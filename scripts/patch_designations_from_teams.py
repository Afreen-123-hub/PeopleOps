"""Patch employee designations in peopleops-data.json using jobTitle from Microsoft Teams/Graph API."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.teams_api_client import get_teams_users

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "peopleops-data.json"


def main():
    print("Fetching Teams users from Microsoft Graph...")
    graph_users = get_teams_users()

    # Build lookup: email → jobTitle, id → jobTitle
    job_by_email = {}
    job_by_id = {}
    for u in graph_users:
        title = (u.get("jobTitle") or "").strip()
        if not title:
            continue
        uid = (u.get("id") or "").lower()
        mail = (u.get("mail") or u.get("userPrincipalName") or "").lower()
        if uid:
            job_by_id[uid] = title
        if mail:
            job_by_email[mail] = title

    print(f"Found {len(job_by_id)} Teams users with jobTitle")

    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    updated = 0
    for emp in data["employees"]:
        teams_id = (emp.get("teamsId") or "").lower()
        email = (emp.get("email") or "").lower()
        title = job_by_id.get(teams_id) or job_by_email.get(email)
        if title and title != emp.get("designation"):
            print(f"  {emp['name']}: '{emp.get('designation')}' → '{title}'")
            emp["designation"] = title
            updated += 1

    DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"\nDone — updated {updated} designations from Teams")


if __name__ == "__main__":
    main()
