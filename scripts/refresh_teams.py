from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT / "data" / "peopleops-data.json"
sys.path.insert(0, str(PROJECT))

from services.teams_api_client import TeamsApiError, get_presences_by_user_id, get_teams_users
from services.teams_auth import TeamsAuthError
from services.teams_transformer import teams_presence_dataframe_from_payload

ACTIVE_STATUSES = {
    "Available", "Busy", "InACall", "InAConferenceCall",
    "InAMeeting", "Presenting", "DoNotDisturb",
}
AWAY_STATUSES = {"Away", "BeRightBack", "OutOfOffice", "OffWork"}
OFFLINE_STATUSES = {"Offline", "Inactive", "PresenceUnknown"}


def clean(v):
    return str(v or "").strip()


def normalize_name(value):
    return "".join(ch for ch in clean(value).lower() if ch.isalnum())


def email_local(value):
    return clean(value).split("@", 1)[0].lower()


def build_graph_user_maps():
    try:
        graph_users = get_teams_users()
    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"WARNING: Teams user lookup skipped: {exc}")
        graph_users = []
    by_id = {}
    by_mail = {}
    by_name = defaultdict(list)
    for user in graph_users:
        graph_id = clean(user.get("id"))
        if not graph_id:
            continue
        by_id[graph_id.lower()] = user
        for key in ("employeeId", "mailNickname"):
            value = clean(user.get(key)).lower()
            if value:
                by_mail[value] = user
        for key in ("mail", "userPrincipalName"):
            local = email_local(user.get(key))
            if local:
                by_mail[local] = user
        name_key = normalize_name(user.get("displayName"))
        if name_key:
            by_name[name_key].append(user)
    return by_id, by_mail, by_name


def resolve_teams_user(emp, graph_maps):
    existing_id = clean(emp.get("teamsId"))
    by_id, by_mail, by_name = graph_maps
    if existing_id and existing_id.lower() in by_id:
        return by_id[existing_id.lower()]
    for value in (
        emp.get("id"),
        emp.get("email"),
        emp.get("mail"),
        emp.get("userPrincipalName"),
    ):
        local = email_local(value) or clean(value).lower()
        if local and local in by_mail:
            return by_mail[local]
    name_matches = by_name.get(normalize_name(emp.get("name")), [])
    if len(name_matches) == 1:
        return name_matches[0]
    return None


def refresh():
    if not DATA_FILE.exists():
        print("ERROR: data file not found — run generate_peopleops_data.py first.")
        sys.exit(1)

    data = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
    employees = data.get("employees", [])

    id_to_index = {}
    graph_maps = build_graph_user_maps()
    for i, emp in enumerate(employees):
        graph_user = resolve_teams_user(emp, graph_maps)
        tid = clean(graph_user.get("id")) if graph_user else clean(emp.get("teamsId"))
        if tid:
            emp["teamsId"] = tid
            id_to_index[tid] = i

    if not id_to_index:
        print("No teamsId found in data — run generate_peopleops_data.py first to populate them.")
        sys.exit(1)

    try:
        payload = get_presences_by_user_id(list(id_to_index.keys()))
    except TeamsApiError as exc:
        print(f"ERROR fetching Teams presence: {exc}")
        sys.exit(1)

    df = teams_presence_dataframe_from_payload(payload)
    updated = 0
    for _, row in df.iterrows():
        ms_id = clean(row.get("User ID"))
        idx = id_to_index.get(ms_id)
        if idx is None:
            continue
        availability = clean(row.get("Availability"))
        activity = clean(row.get("Activity"))
        status = availability or activity
        employees[idx]["teams"] = {
            "status": status,
            "workLocation": clean(row.get("Work Location")),
            "isActive": 1 if status in ACTIVE_STATUSES else 0,
            "isAway": 1 if status in AWAY_STATUSES else 0,
            "isOffline": 1 if status in OFFLINE_STATUSES else 0,
            "isOutOfOffice": 1 if status == "OutOfOffice" else 0,
            "reports": 1,
        }
        employees[idx].setdefault("sources", {})["teams"] = True
        sources = employees[idx].get("sources", {})
        employees[idx]["sourceConfidence"] = round(
            sum(1 for available in sources.values() if available) / max(1, len(sources)) * 100
        )
        updated += 1

    data["meta"]["teamsRefreshedAt"] = datetime.now().isoformat(timespec="seconds")
    data.setdefault("overview", {}).setdefault("sourceCoverage", {})["teams"] = sum(
        1 for emp in employees if emp.get("sources", {}).get("teams")
    )
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Teams presence refreshed: {updated}/{len(id_to_index)} employees updated.")


if __name__ == "__main__":
    refresh()
