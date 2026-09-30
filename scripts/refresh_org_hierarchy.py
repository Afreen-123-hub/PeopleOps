"""
Build manager -> reportee hierarchy from GreytHR's reporting-hierarchy API (HR's own
system of record for reporting lines), with Microsoft Graph's "Manager" field as a fallback
for anyone GreytHR doesn't cover (mainly interns/MTM staff GreytHR doesn't track at all).

This replaced a Graph-only version: Graph's manager field is frequently unset (only ~55% of
employees had it set), while GreytHR's hierarchy is actively maintained as part of onboarding
and reflects the org chart HR itself works from (verified 2026-09-28 against an HR-exported
org chart: 93/93 employees, fully linked). GreytHR stays primary and authoritative; Graph only
fills in people GreytHR has no record of at all, so it can never override or conflict with
GreytHR's data — validated 2026-09-29 that this recovers ~33 additional people.

Also updates each employee record in peopleops-data.json with:
  - managerId, managerName, managerEmail

Run:
    python scripts/refresh_org_hierarchy.py
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
PEOPLEOPS_FILE = PROJECT / "data" / "peopleops-data.json"
ORG_FILE = PROJECT / "data" / "org-hierarchy.json"

import sys
sys.path.insert(0, str(PROJECT))

from services.greythr_api_client import GreytHRApiError, GreytHRAuthError, GreytHRConfigError, get_reporting_hierarchy, get_token
from services.teams_api_client import TeamsApiError, get_teams_users_with_manager
from services.teams_auth import TeamsAuthError

# GreytHR carries a handful of non-employee rows (test/sample accounts) even in the live
# hierarchy report — excluded the same way BLOCKED_IDS excludes them elsewhere.
BLOCKED_EMPLOYEE_NOS = {"EM01"}


def clean(value):
    return str(value or "").strip()


def _graph_fallback(unresolved_ids: set[str], emp_by_id: dict[str, dict], resigned_employee_nos: set[str]) -> dict[str, dict]:
    """Resolve a manager for employees GreytHR didn't cover, via Microsoft Graph's Manager
    field. Matches by teamsId (Azure AD user id) rather than name/email, since that's the
    reliable link already established elsewhere in the pipeline (refresh_teams.py).
    Returns {employeeNo: {id, name, email}} — same shape as the GreytHR-derived map, so the
    caller can merge it in without GreytHR ever being overridden (it's only consulted for ids
    GreytHR left unresolved).

    A Graph-resolved manager is discarded if GreytHR says they've resigned — Graph is often
    stale about departures (deprovisioning runs on IT's own timeline, separate from HR), so
    GreytHR's resigned flag always wins over what Graph still shows."""
    if not unresolved_ids:
        return {}
    try:
        graph_users = get_teams_users_with_manager()
    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"WARNING: Graph fallback skipped (could not fetch Teams users): {exc}")
        return {}

    graph_by_id = {clean(u.get("id")).lower(): u for u in graph_users if u.get("id")}
    teamsid_to_empid = {
        clean(e.get("teamsId")).lower(): clean(e.get("id"))
        for e in emp_by_id.values()
        if e.get("teamsId")
    }

    resolved: dict[str, dict] = {}
    for emp_id in unresolved_ids:
        emp = emp_by_id.get(emp_id)
        teams_id = clean(emp.get("teamsId")).lower() if emp else ""
        if not teams_id:
            continue
        graph_user = graph_by_id.get(teams_id)
        if not graph_user:
            continue
        mgr = graph_user.get("manager")
        mgr_teams_id = clean((mgr or {}).get("id")).lower()
        if not mgr_teams_id:
            continue
        mgr_emp_id = teamsid_to_empid.get(mgr_teams_id)
        if not mgr_emp_id or mgr_emp_id not in emp_by_id:
            continue
        if mgr_emp_id in resigned_employee_nos:
            continue
        resolved[emp_id] = {
            "id": mgr_emp_id,
            "name": clean(emp_by_id[mgr_emp_id].get("name")),
            "email": clean(emp_by_id[mgr_emp_id].get("email")),
        }
    return resolved


def main():
    if not PEOPLEOPS_FILE.exists():
        raise RuntimeError("peopleops-data.json not found. Run generate_peopleops_data.py first.")

    print("Fetching GreytHR reporting hierarchy...")
    try:
        token, domain = get_token()
        rows = get_reporting_hierarchy(token, domain)
    except (GreytHRApiError, GreytHRAuthError, GreytHRConfigError) as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1)

    # Captured before filtering out resigned rows: the Graph fallback needs this too, since
    # Microsoft Graph is often stale about someone having left (that's exactly how Trinita
    # Rex Anto's resignation slipped through un-flagged the first time this was built) —
    # GreytHR's resigned flag is the more current signal and should override Graph either way.
    resigned_employee_nos = {clean(r.get("employeeNo")) for r in rows if r.get("resigned")}

    rows = [
        r for r in rows
        if not r.get("resigned") and clean(r.get("employeeNo")) not in BLOCKED_EMPLOYEE_NOS
    ]
    print(f"Fetched {len(rows)} active GreytHR employees.")

    # GreytHR's `pid` links to another row's internal `id` (not employeeNo) — resolve pid ->
    # manager's employeeNo/name/email via this lookup, same shape the old Graph-based script
    # produced so nothing downstream (access_control.py, the frontend) needs to change.
    by_gid = {r["id"]: r for r in rows if r.get("id") is not None}

    manager_to_reports: dict[str, list[str]] = defaultdict(list)
    employee_manager: dict[str, dict] = {}  # employeeNo -> {id, name, email}

    for row in rows:
        emp_no = clean(row.get("employeeNo"))
        pid = row.get("pid")
        if not emp_no or pid is None:
            continue
        mgr_row = by_gid.get(pid)
        if not mgr_row:
            continue
        mgr_emp_no = clean(mgr_row.get("employeeNo"))
        if not mgr_emp_no:
            continue
        employee_manager[emp_no] = {
            "id": mgr_emp_no,
            "name": clean(mgr_row.get("name")),
            "email": clean(mgr_row.get("email")),
        }
        manager_to_reports[mgr_emp_no].append(emp_no)

    # Load PeopleOPS employees for enrichment (team, designation, kpi, band) — GreytHR's own
    # designation/department fields are inconsistently filled, so peopleops-data.json (sourced
    # from Worklogix) remains the richer record where the same employee exists in both.
    peopleops = json.loads(PEOPLEOPS_FILE.read_text(encoding="utf-8-sig"))
    employees = peopleops.get("employees", [])
    emp_by_id = {clean(e.get("id")): e for e in employees if e.get("id")}

    # Graph fallback: only for employees GreytHR left unresolved. Never touches anyone
    # GreytHR already has an answer for, so GreytHR's data always wins where both exist.
    unresolved_ids = {eid for eid in emp_by_id if eid not in employee_manager}
    print(f"Trying Microsoft Graph fallback for {len(unresolved_ids)} employees GreytHR didn't resolve...")
    graph_resolved = _graph_fallback(unresolved_ids, emp_by_id, resigned_employee_nos)
    for emp_id, mgr in graph_resolved.items():
        employee_manager[emp_id] = mgr
        manager_to_reports[mgr["id"]].append(emp_id)
    print(f"Graph fallback resolved {len(graph_resolved)} additional employees.")

    updated = 0
    for emp in employees:
        emp_id = clean(emp.get("id"))
        mgr = employee_manager.get(emp_id)
        if mgr:
            emp["managerId"] = mgr["id"]
            emp["managerName"] = mgr["name"]
            emp["managerEmail"] = mgr["email"]
            emp["managerEmployeeId"] = mgr["id"]  # already a PeopleOPS employee id (employeeNo)
            updated += 1
        else:
            for key in ("managerId", "managerName", "managerEmail", "managerEmployeeId"):
                emp.pop(key, None)

    for emp in employees:
        emp_id = clean(emp.get("id"))
        report_ids = [r for r in manager_to_reports.get(emp_id, []) if r in emp_by_id]
        emp["directReports"] = [
            {"id": rid, "name": clean(emp_by_id[rid].get("name")), "designation": clean(emp_by_id[rid].get("designation") or "")}
            for rid in report_ids
        ]

    # Build org hierarchy nodes — same shape as before, still keyed by PeopleOPS employee id.
    nodes = []
    for emp in employees:
        emp_id = clean(emp.get("id"))
        report_ids = [r["id"] for r in emp.get("directReports", [])]
        is_manager = len(report_ids) > 0
        nodes.append({
            "id": emp_id,
            "name": clean(emp.get("name")),
            "team": clean(emp.get("team")),
            "designation": clean(emp.get("designation")),
            "teamsId": clean(emp.get("teamsId")),
            "managerId": emp.get("managerEmployeeId", ""),
            "managerName": emp.get("managerName", ""),
            "directReports": report_ids,
            "directReportCount": len(report_ids),
            "isManager": is_manager,
            "kpi": emp.get("kpi"),
            "band": emp.get("band", ""),
        })

    managers = [n for n in nodes if n["isManager"]]
    print(f"\nOrg hierarchy built:")
    print(f"  Total employees : {len(nodes)}")
    print(f"  Managers        : {len(managers)}")
    print(f"  With manager set: {updated}")
    print()
    print("Managers and their direct reports:")
    for m in sorted(managers, key=lambda x: -x["directReportCount"]):
        print(f"  {m['name']} ({m['id']}) — {m['directReportCount']} reports")

    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "greythr-reporting-hierarchy+graph-fallback",
            "graphFallbackResolved": len(graph_resolved),
            "totalEmployees": len(nodes),
            "managerCount": len(managers),
            "matchedWithManager": updated,
        },
        "employees": nodes,
    }
    ORG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nSaved {ORG_FILE.relative_to(PROJECT)}")

    PEOPLEOPS_FILE.write_text(json.dumps(peopleops, indent=2), encoding="utf-8")
    print(f"Updated {PEOPLEOPS_FILE.relative_to(PROJECT)} with manager info for {updated} employees.")


if __name__ == "__main__":
    main()
