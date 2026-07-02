"""
Diagnose why certain employees have null KPI scores.

Reads the current peopleops-data.json and shows exactly which data sources
are missing for each employee with kpi=null, so the linkage issue can be
fixed at the source rather than lowering the confidence threshold.

Run from the peopleops-intelligence root:
    python scripts/diagnose_null_kpi.py
"""
from __future__ import annotations

import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT / "data" / "peopleops-data.json"

SOURCE_LABELS = {
    "worklogix": "Worklogix (tasks/productivity)",
    "greythr":   "GreytHR   (leave/attendance)",
    "biometrics":"Biometrics (office hours/punch-in)",
    "teams":     "Teams     (presence/activity)",
}

FIX_HINTS = {
    "worklogix":  "Check that employee ID exists in Worklogix daily/monthly data for the target period.",
    "greythr":    "Check employee_no / employeeNo field in Worklogix user record matches GreytHR ID.",
    "biometrics": "Check biometric_id field in Worklogix user record matches presence report user_id.",
    "teams":      "Check ms_teams_id field in Worklogix user record is populated and correct.",
}


def main():
    if not DATA_FILE.exists():
        print(f"ERROR: {DATA_FILE} not found. Run generate_peopleops_data.py first.")
        return

    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    employees = data.get("employees", [])

    null_employees = [e for e in employees if e.get("kpi") is None]
    scored_employees = [e for e in employees if e.get("kpi") is not None]

    print(f"\n{'='*65}")
    print(f"  KPI NULL DIAGNOSIS — PeopleOPS Intelligence")
    print(f"{'='*65}")
    print(f"  Total employees : {len(employees)}")
    print(f"  Scored (KPI OK) : {len(scored_employees)}")
    print(f"  Null KPI        : {len(null_employees)}")
    print(f"{'='*65}\n")

    if not null_employees:
        print("All employees have KPI scores. Nothing to fix!")
        return

    # Count which sources are most commonly missing
    missing_counts: dict[str, int] = {k: 0 for k in SOURCE_LABELS}
    for emp in null_employees:
        sources = emp.get("sources", {})
        for src in SOURCE_LABELS:
            if not sources.get(src):
                missing_counts[src] += 1

    print("MISSING SOURCE SUMMARY (across all null-KPI employees):")
    print(f"  {'Source':<14} {'Missing':>8}  Fix")
    print(f"  {'-'*14} {'-'*8}  {'-'*38}")
    for src, label in SOURCE_LABELS.items():
        count = missing_counts[src]
        bar = "█" * count + "░" * (len(null_employees) - count)
        print(f"  {src:<14} {count:>6}/{len(null_employees)}  {bar}")

    print()
    print("─" * 65)
    print("PER-EMPLOYEE BREAKDOWN")
    print("─" * 65)

    for emp in sorted(null_employees, key=lambda e: e.get("name", "")):
        name = emp.get("name", "Unknown")
        emp_id = emp.get("id", "")
        team = emp.get("team", "")
        conf = emp.get("sourceConfidence", 0)
        sources = emp.get("sources", {})
        missing = [src for src in SOURCE_LABELS if not sources.get(src)]
        source_keys = emp.get("sourceKeys", {})

        print(f"\n  {name} ({emp_id})  |  {team}  |  Confidence: {conf}%")
        print(f"  Missing sources: {', '.join(missing) if missing else 'none'}")

        for src in missing:
            hint = FIX_HINTS[src]
            key_val = source_keys.get(src, "—")
            print(f"    [{src}] stored key='{key_val}'")
            print(f"           → {hint}")

    print(f"\n{'='*65}")
    print("HOW TO FIX")
    print(f"{'='*65}")
    print("""
1. Open the Worklogix employee record for each employee above.
2. Check the fields listed next to each missing source.
3. The most common fix:
   - greythr  → set employee_no to match GreytHR employee number
   - biometrics → set biometric_id to match the biometric device user ID
   - teams    → set ms_teams_id to the employee's Azure AD object ID
               (get it from: Azure Portal > Users > [name] > Object ID)
4. After fixing the Worklogix records, re-run:
     python scripts/generate_peopleops_data.py
   Those employees should now have KPI scores.

NOTE: Do NOT lower the confidence threshold just to force scores.
      A KPI built on 1 source is unreliable for HR decisions.
""")


if __name__ == "__main__":
    main()
