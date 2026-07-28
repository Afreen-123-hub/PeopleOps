from __future__ import annotations

import csv
import io
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT / "data" / "peopleops-data.json"
sys.path.insert(0, str(PROJECT))

from services.teams_api_client import TeamsApiError, get_presences_by_user_id, get_teams_activity_report, get_teams_users
from services.teams_auth import TeamsAuthError
from services.teams_transformer import extract_presence_rows, transform_presence_row

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
    tid_to_upn: dict[str, str] = {}   # teamsId (lower) -> UPN (lower)
    graph_maps = build_graph_user_maps()
    by_id = graph_maps[0]
    for i, emp in enumerate(employees):
        graph_user = resolve_teams_user(emp, graph_maps)
        tid = clean(graph_user.get("id")) if graph_user else clean(emp.get("teamsId"))
        if tid:
            emp["teamsId"] = tid
            id_to_index[tid] = i
            # Store the authoritative UPN so we can match the activity report later
            graph_upn = clean((graph_user or by_id.get(tid.lower(), {})).get("userPrincipalName")).lower()
            if graph_upn:
                tid_to_upn[tid.lower()] = graph_upn

    if not id_to_index:
        print("No teamsId found in data — run generate_peopleops_data.py first to populate them.")
        sys.exit(1)

    try:
        payload = get_presences_by_user_id(list(id_to_index.keys()))
    except TeamsApiError as exc:
        print(f"ERROR fetching Teams presence: {exc}")
        sys.exit(1)

    presence_rows = [transform_presence_row(r) for r in extract_presence_rows(payload)]
    updated = 0
    for row in presence_rows:
        ms_id = clean(row.get("User ID"))
        idx = id_to_index.get(ms_id)
        if idx is None:
            continue
        availability = clean(row.get("Availability"))
        activity = clean(row.get("Activity"))
        status = availability or activity
        employees[idx].setdefault("teams", {}).update({
            "status": status,
            "workLocation": clean(row.get("Work Location")),
            "isActive": 1 if status in ACTIVE_STATUSES else 0,
            "isAway": 1 if status in AWAY_STATUSES else 0,
            "isOffline": 1 if status in OFFLINE_STATUSES else 0,
            "isOutOfOffice": 1 if status == "OutOfOffice" else 0,
            "reports": 1,
        })
        employees[idx].setdefault("sources", {})["teams"] = True
        sources = employees[idx].get("sources", {})
        employees[idx]["sourceConfidence"] = round(
            sum(1 for available in sources.values() if available) / max(1, len(sources)) * 100
        )
        updated += 1

    # ── Activity report: messages, meetings, calls per user ──────────────────
    activity_by_upn: dict[str, dict] = {}
    try:
        csv_text = get_teams_activity_report("D30")
        reader = csv.DictReader(io.StringIO(csv_text))
        for row in reader:
            upn = (row.get("User Principal Name") or "").strip().lower()
            if not upn:
                continue
            def _int(key):
                try:
                    return int(row.get(key) or 0)
                except ValueError:
                    return 0
            activity_by_upn[upn] = {
                "messagesCount": _int("Team Chat Message Count") + _int("Private Chat Message Count"),
                "meetingCount": _int("Meetings Attended Count") or _int("Meeting Count"),
                "callCount": _int("Call Count"),
                "activityMatched": True,
            }
        print(f"Activity report loaded: {len(activity_by_upn)} users found.")
    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"WARNING: Activity report skipped (check Reports.Read.All permission): {exc}")
        activity_by_upn = {}

    # Build UPN → employee index map using the authoritative UPN from Graph
    upn_to_index: dict[str, int] = {}
    for tid, idx in id_to_index.items():
        upn = tid_to_upn.get(tid.lower())
        if upn:
            upn_to_index[upn] = idx

    # Merge activity counts into employee records
    activity_matched = 0
    for tid, idx in id_to_index.items():
        upn = tid_to_upn.get(tid.lower(), "")
        # 1. Match by authoritative Graph UPN
        activity = activity_by_upn.get(upn)
        # 2. Fallback: match by local part of UPN (before @)
        if not activity and upn and "@" in upn:
            local = upn.split("@")[0]
            activity = next((v for k, v in activity_by_upn.items() if k.split("@")[0] == local), None)
        # 3. Fallback: match by employee email local part
        if not activity:
            emp_email = (employees[idx].get("email") or "").lower()
            if emp_email and "@" in emp_email:
                local = emp_email.split("@")[0]
                activity = next((v for k, v in activity_by_upn.items() if k.split("@")[0] == local), None)
        if activity:
            employees[idx].setdefault("teams", {}).update(activity)
            activity_matched += 1
        else:
            t = employees[idx].setdefault("teams", {})
            t.setdefault("messagesCount", 0)
            t.setdefault("meetingCount", 0)
            t.setdefault("callCount", 0)
            t.setdefault("activityMatched", False)

    print(f"Activity counts merged: {activity_matched}/{len(id_to_index)} employees matched.")

    data["meta"]["teamsRefreshedAt"] = datetime.now().isoformat(timespec="seconds")
    data.setdefault("overview", {}).setdefault("sourceCoverage", {})["teams"] = sum(
        1 for emp in employees if emp.get("sources", {}).get("teams")
    )
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Teams presence refreshed: {updated}/{len(id_to_index)} employees updated.")


if __name__ == "__main__":
    refresh()
