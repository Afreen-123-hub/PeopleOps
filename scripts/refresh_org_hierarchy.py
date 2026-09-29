"""
Build manager -> reportee hierarchy from GreytHR's reporting-hierarchy API (HR's own
system of record for reporting lines).

This replaced a Microsoft Graph (Azure AD "Manager" field) based version: Graph's manager
field is frequently unset (only ~55% of employees had it set), while GreytHR's hierarchy is
actively maintained as part of onboarding and reflects the org chart HR itself works from
(verified 2026-09-28 against an HR-exported org chart: 93/93 employees, fully linked).

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

# GreytHR carries a handful of non-employee rows (test/sample accounts) even in the live
# hierarchy report — excluded the same way BLOCKED_IDS excludes them elsewhere.
BLOCKED_EMPLOYEE_NOS = {"EM01"}


def clean(value):
    return str(value or "").strip()


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
            "source": "greythr-reporting-hierarchy",
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
