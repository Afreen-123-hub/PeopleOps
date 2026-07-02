"""
Build manager → reportee hierarchy from Azure AD (User.Read.All — no extra permissions needed).

Reads every employee's manager from Microsoft Graph, matches them back to
PeopleOPS employee records, and writes data/org-hierarchy.json.

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

from services.teams_api_client import TeamsApiError, get_teams_users_with_manager
from services.teams_auth import TeamsAuthError


def clean(value):
    return str(value or "").strip()


def local_part(email: str) -> str:
    return clean(email).split("@", 1)[0].lower()


def main():
    if not PEOPLEOPS_FILE.exists():
        raise RuntimeError("peopleops-data.json not found. Run generate_peopleops_data.py first.")

    print("Fetching Azure AD users with manager info...")
    try:
        ad_users = get_teams_users_with_manager()
    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1)

    print(f"Fetched {len(ad_users)} Azure AD users.")

    # Build lookup: Azure AD id → user record
    ad_by_id = {clean(u.get("id")).lower(): u for u in ad_users if u.get("id")}

    # Build manager map: manager_azure_id → list of reportee azure ids
    manager_to_reports: dict[str, list[str]] = defaultdict(list)
    user_manager_map: dict[str, dict] = {}

    for user in ad_users:
        user_id = clean(user.get("id")).lower()
        manager = user.get("manager")
        if manager and manager.get("id"):
            manager_id = clean(manager["id"]).lower()
            manager_to_reports[manager_id].append(user_id)
            user_manager_map[user_id] = {
                "id": manager_id,
                "name": clean(manager.get("displayName")),
                "email": clean(manager.get("mail") or manager.get("userPrincipalName")),
            }

    # Load PeopleOPS employees and match by teamsId
    peopleops = json.loads(PEOPLEOPS_FILE.read_text(encoding="utf-8-sig"))
    employees = peopleops.get("employees", [])

    # Build lookup: azure id → employee record
    emp_by_azure_id = {}
    for emp in employees:
        teams_id = clean(emp.get("teamsId")).lower()
        if teams_id:
            emp_by_azure_id[teams_id] = emp

    # Inject manager info into each employee record
    updated = 0
    for emp in employees:
        teams_id = clean(emp.get("teamsId")).lower()
        if not teams_id:
            continue
        mgr = user_manager_map.get(teams_id)
        if mgr:
            emp["managerId"] = mgr["id"]
            emp["managerName"] = mgr["name"]
            emp["managerEmail"] = mgr["email"]
            # Resolve manager to a PeopleOPS employee if possible
            mgr_emp = emp_by_azure_id.get(mgr["id"])
            if mgr_emp:
                emp["managerEmployeeId"] = clean(mgr_emp.get("id"))
            updated += 1

    # Embed directReports into each employee record in peopleops-data.json
    # Build emp_id → employee lookup for resolving names
    emp_by_id = {clean(e.get("id")): e for e in employees if e.get("id")}

    for emp in employees:
        teams_id = clean(emp.get("teamsId")).lower()
        report_azure_ids = manager_to_reports.get(teams_id, [])
        report_entries = []
        for rid in report_azure_ids:
            reportee_emp = emp_by_azure_id.get(rid)
            if reportee_emp:
                report_entries.append({
                    "id": clean(reportee_emp.get("id")),
                    "name": clean(reportee_emp.get("name")),
                    "designation": clean(reportee_emp.get("designation") or ""),
                })
        emp["directReports"] = report_entries

    # Build org hierarchy nodes
    nodes = []
    managers_seen = set()

    for emp in employees:
        teams_id = clean(emp.get("teamsId")).lower()
        report_emp_ids = [r["id"] for r in emp.get("directReports", [])]
        is_manager = len(report_emp_ids) > 0
        nodes.append({
            "id": clean(emp.get("id")),
            "name": clean(emp.get("name")),
            "team": clean(emp.get("team")),
            "designation": clean(emp.get("designation")),
            "teamsId": clean(emp.get("teamsId")),
            "managerId": emp.get("managerEmployeeId", ""),
            "managerName": emp.get("managerName", ""),
            "directReports": report_emp_ids,
            "directReportCount": len(report_emp_ids),
            "isManager": is_manager,
            "kpi": emp.get("kpi"),
            "band": emp.get("band", ""),
        })
        if is_manager:
            managers_seen.add(clean(emp.get("id")))

    # Build summary
    managers = [n for n in nodes if n["isManager"]]
    print(f"\nOrg hierarchy built:")
    print(f"  Total employees : {len(nodes)}")
    print(f"  Managers        : {len(managers)}")
    print(f"  With manager set: {updated}")
    print()
    print("Managers and their direct reports:")
    for m in sorted(managers, key=lambda x: -x["directReportCount"]):
        print(f"  {m['name']} ({m['id']}) — {m['directReportCount']} reports")

    # Save org-hierarchy.json
    payload = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "totalEmployees": len(nodes),
            "managerCount": len(managers),
            "matchedWithManager": updated,
        },
        "employees": nodes,
    }
    ORG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nSaved {ORG_FILE.relative_to(PROJECT)}")

    # Update peopleops-data.json with manager fields
    PEOPLEOPS_FILE.write_text(json.dumps(peopleops, indent=2), encoding="utf-8")
    print(f"Updated {PEOPLEOPS_FILE.relative_to(PROJECT)} with manager info for {updated} employees.")


if __name__ == "__main__":
    main()
