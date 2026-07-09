"""Patch employee designations in peopleops-data.json using designation from GreytHR (matched by name)."""
import json, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.greythr_api_client import get_token, _api_get

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "peopleops-data.json"

def normalize(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())

def main():
    print("Fetching designations from GreytHR...")
    token, domain = get_token()
    raw = _api_get(f"https://{domain}/core-hr/v1/employees/reporting-hierarchy", token, domain,
                   params={"display": "all", "page": 0, "size": 30000})

    # Build name → designation lookup
    by_name = {}
    for emp in raw.get("data", []):
        designation = (emp.get("designation") or "").strip()
        name = normalize(emp.get("name") or emp.get("displayName") or "")
        if name and designation:
            by_name[name] = designation

    print(f"Found {len(by_name)} GreytHR employees with designation")

    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    updated = 0
    no_match = []
    for emp in data["employees"]:
        key = normalize(emp.get("name", ""))
        designation = by_name.get(key)
        if designation and designation != emp.get("designation"):
            print(f"  {emp['name']}: '{emp.get('designation')}' -> '{designation}'")
            emp["designation"] = designation
            updated += 1
        elif not designation:
            no_match.append(emp["name"])

    DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"\nDone — updated {updated} designations from GreytHR")
    if no_match:
        print(f"No GreytHR match for {len(no_match)} employees (they'll keep current designation):")
        for n in no_match[:10]:
            print(f"  - {n}")

if __name__ == "__main__":
    main()
