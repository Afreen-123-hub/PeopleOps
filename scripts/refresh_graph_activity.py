from __future__ import annotations

import csv
import io
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
PEOPLEOPS_FILE = PROJECT / "data" / "peopleops-data.json"
GRAPH_FILE = PROJECT / "data" / "graph-activity.json"
sys.path.insert(0, str(PROJECT))

from services.graph_activity_client import GraphActivityClient, GraphActivityError
from services.teams_auth import TeamsAuthError


def clean(value):
    return str(value or "").strip()


def normalized(value):
    return re.sub(r"[^a-z0-9]+", "", clean(value).lower())


def local_part(value):
    return clean(value).split("@", 1)[0].lower()


def iso_value(value):
    if isinstance(value, dict):
        date_time = clean(value.get("dateTime"))
        if not date_time or date_time.endswith("Z") or re.search(r"[+-]\d\d:\d\d$", date_time):
            return date_time
        time_zone = clean(value.get("timeZone")).lower()
        if time_zone in {"india standard time", "asia/kolkata", "asia/calcutta"}:
            return f"{date_time}+05:30"
        if time_zone in {"utc", "etc/utc"}:
            return f"{date_time}Z"
        return date_time
    return clean(value)


def build_user_maps(users):
    by_id = {}
    by_key = {}
    by_name = defaultdict(list)
    for user in users:
        user_id = clean(user.get("id"))
        if not user_id:
            continue
        by_id[user_id.lower()] = user
        for field in ("employeeId", "mailNickname", "mail", "userPrincipalName"):
            value = clean(user.get(field))
            for key in (value.lower(), local_part(value), normalized(value)):
                if key:
                    by_key[key] = user
        name_key = normalized(user.get("displayName"))
        if name_key:
            by_name[name_key].append(user)
    return by_id, by_key, by_name


def resolve_employee_user(employee, maps):
    by_id, by_key, by_name = maps
    teams_id = clean(employee.get("teamsId")).lower()
    if teams_id and teams_id in by_id:
        return by_id[teams_id]
    candidates = [
        employee.get("id"),
        employee.get("email"),
        employee.get("mail"),
        employee.get("userPrincipalName"),
    ]
    for candidate in candidates:
        value = clean(candidate)
        for key in (value.lower(), local_part(value), normalized(value)):
            if key and key in by_key:
                return by_key[key]
    matches = by_name.get(normalized(employee.get("name")), [])
    return matches[0] if len(matches) == 1 else None


def planner_status(task):
    percent = int(task.get("percentComplete") or 0)
    if percent >= 100:
        return "Completed"
    if percent > 0:
        return "In progress"
    return "Not started"


def parse_iso(value: str):
    """Parse an ISO datetime string, returning None on failure."""
    value = clean(value)
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def planner_on_time_rate(assigned: list[dict], now: datetime) -> dict:
    """Compute on-time vs overdue completion stats for a set of Planner tasks."""
    with_due = [t for t in assigned if t.get("dueDateTime")]
    on_time = 0
    overdue_completed = 0
    overdue_open = 0
    for task in with_due:
        due = parse_iso(task["dueDateTime"])
        completed_at = parse_iso(task.get("completedDateTime", ""))
        if due is None:
            continue
        if task["status"] == "Completed" and completed_at:
            if completed_at <= due:
                on_time += 1
            else:
                overdue_completed += 1
        elif task["status"] != "Completed" and due < now:
            overdue_open += 1
    total_with_due = len(with_due)
    rate = round(on_time / total_with_due * 100, 1) if total_with_due else None
    return {
        "onTime": on_time,
        "overdueCompleted": overdue_completed,
        "overdueOpen": overdue_open,
        "totalWithDue": total_with_due,
        "onTimeRate": rate,
    }


def summarize_employee_graph(employee, user, tasks, events, now):
    user_id = clean(user.get("id")) if user else ""
    assigned = tasks.get(user_id, [])
    completed = sum(1 for task in assigned if task["status"] == "Completed")
    in_progress = sum(1 for task in assigned if task["status"] == "In progress")
    not_started = sum(1 for task in assigned if task["status"] == "Not started")
    meeting_minutes = sum(event.get("durationMinutes", 0) for event in events)
    on_time_stats = planner_on_time_rate(assigned, now)
    return {
        "matched": bool(user),
        "userId": user_id,
        "email": clean((user or {}).get("mail") or (user or {}).get("userPrincipalName")),
        "planner": {
            "assigned": len(assigned),
            "completed": completed,
            "inProgress": in_progress,
            "notStarted": not_started,
            "onTime": on_time_stats["onTime"],
            "overdueCompleted": on_time_stats["overdueCompleted"],
            "overdueOpen": on_time_stats["overdueOpen"],
            "onTimeRate": on_time_stats["onTimeRate"],
            "tasks": assigned,
        },
        "calendar": {
            "events": len(events),
            "meetingHours": round(meeting_minutes / 60, 1),
            "items": events,
        },
        "teams": employee.get("teams", {}),
        "attendance": employee.get("attendance", {}),
        "kpi": employee.get("kpi"),
        "band": employee.get("band", ""),
        "designation": employee.get("designation", ""),
        "sourceConfidence": employee.get("sourceConfidence", 0),
    }


def event_duration_minutes(event):
    try:
        start = datetime.fromisoformat(iso_value(event.get("start")).replace("Z", "+00:00"))
        end = datetime.fromisoformat(iso_value(event.get("end")).replace("Z", "+00:00"))
        return max(0, round((end - start).total_seconds() / 60))
    except (TypeError, ValueError):
        return 0


def read_sharepoint_activity(client) -> dict:
    """Fetch SharePoint activity report CSV and index by email local part + display name."""
    try:
        csv_text = client.get_sharepoint_activity_report()
    except Exception as exc:
        print(f"WARNING: SharePoint activity report skipped: {exc}", file=sys.stderr)
        return {}
    result = {}
    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        for row in reader:
            upn = clean(row.get("User Principal Name") or row.get("userPrincipalName") or "")
            if not upn:
                continue
            key = local_part(upn)
            display = clean(row.get("Display Name") or "")
            def si(col):
                try: return int(row.get(col) or 0)
                except: return 0
            entry = {
                "upn": upn,
                "displayName": display,
                "filesViewedEdited": si("Viewed Or Edited File Count"),
                "filesSynced": si("Synced File Count"),
                "filesSharedInternally": si("Shared Internally File Count"),
                "filesSharedExternally": si("Shared Externally File Count"),
                "pagesVisited": si("Visited Page Count"),
                "lastActivityDate": clean(row.get("Last Activity Date") or ""),
            }
            if key:
                result[key] = entry
            if display:
                result[f"name:{normalized(display)}"] = entry
    except Exception as exc:
        print(f"WARNING: SharePoint activity CSV parse failed: {exc}", file=sys.stderr)
    print(f"SharePoint activity report loaded: {len([k for k in result if not k.startswith('name:')])} users")
    return result


def resolve_sharepoint_activity(employee, sp_activity: dict):
    email = clean(employee.get("email") or employee.get("mail") or "")
    key = local_part(email) if email else ""
    if key and key in sp_activity:
        return sp_activity[key]
    name_key = f"name:{normalized(employee.get('name', ''))}"
    return sp_activity.get(name_key)


def refresh():
    if not PEOPLEOPS_FILE.exists():
        raise RuntimeError("peopleops-data.json is missing. Generate PeopleOPS data first.")

    peopleops = json.loads(PEOPLEOPS_FILE.read_text(encoding="utf-8-sig"))
    employees = peopleops.get("employees", [])
    client = GraphActivityClient()
    sp_activity = read_sharepoint_activity(client)
    users = client.get_users()
    user_names = {
        clean(user.get("id")): clean(user.get("displayName"))
        or clean(user.get("mail"))
        or clean(user.get("userPrincipalName"))
        for user in users
    }
    maps = build_user_maps(users)

    matched = {}
    for employee in employees:
        user = resolve_employee_user(employee, maps)
        if user:
            matched[clean(employee.get("id"))] = user
            employee["teamsId"] = clean(user.get("id"))

    groups = client.get_groups()
    plans = []
    tasks_by_user = defaultdict(list)
    planner_errors = []
    for group in groups:
        try:
            group_plans = client.get_group_plans(clean(group.get("id")))
        except (GraphActivityError, TeamsAuthError) as exc:
            planner_errors.append(str(exc))
            continue
        for plan in group_plans:
            try:
                raw_tasks = client.get_plan_tasks(clean(plan.get("id")))
            except (GraphActivityError, TeamsAuthError) as exc:
                planner_errors.append(str(exc))
                continue
            normalized_tasks = []
            for task in raw_tasks:
                item = {
                    "id": clean(task.get("id")),
                    "title": clean(task.get("title")) or "Untitled task",
                    "status": planner_status(task),
                    "percentComplete": int(task.get("percentComplete") or 0),
                    "priority": task.get("priority"),
                    "startDateTime": clean(task.get("startDateTime")),
                    "dueDateTime": clean(task.get("dueDateTime")),
                    "completedDateTime": clean(task.get("completedDateTime")),
                    "planId": clean(plan.get("id")),
                    "planTitle": clean(plan.get("title")),
                    "groupId": clean(group.get("id")),
                    "groupName": clean(group.get("displayName")),
                    "assigneeIds": list((task.get("assignments") or {}).keys()),
                }
                item["assignees"] = [
                    user_names.get(user_id, user_id) for user_id in item["assigneeIds"]
                ]
                normalized_tasks.append(item)
                for assignee_id in item["assigneeIds"]:
                    tasks_by_user[assignee_id].append(item)
            plans.append(
                {
                    "id": clean(plan.get("id")),
                    "title": clean(plan.get("title")),
                    "groupId": clean(group.get("id")),
                    "groupName": clean(group.get("displayName")),
                    "tasks": normalized_tasks,
                    "summary": dict(Counter(task["status"] for task in normalized_tasks)),
                }
            )

    india_timezone = timezone(timedelta(hours=5, minutes=30))
    now = datetime.now(india_timezone)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if now.month == 12:
        end = start.replace(year=now.year + 1, month=1)
    else:
        end = start.replace(month=now.month + 1)

    events_by_employee = {}
    calendar_errors = []
    for employee_id, user in matched.items():
        try:
            raw_events = client.get_calendar_view(
                clean(user.get("id")),
                start.isoformat(),
                end.isoformat(),
            )
            events_by_employee[employee_id] = [
                {
                    "id": clean(event.get("id")),
                    "subject": clean(event.get("subject")) or "(No subject)",
                    "start": iso_value(event.get("start")),
                    "end": iso_value(event.get("end")),
                    "isAllDay": bool(event.get("isAllDay")),
                    "showAs": clean(event.get("showAs")),
                    "webLink": clean(event.get("webLink")),
                    "organizer": clean(
                        ((event.get("organizer") or {}).get("emailAddress") or {}).get("name")
                    ),
                    "attendees": [
                        clean((attendee.get("emailAddress") or {}).get("name"))
                        or clean((attendee.get("emailAddress") or {}).get("address"))
                        for attendee in event.get("attendees", [])
                    ],
                    "location": clean((event.get("location") or {}).get("displayName")),
                    "meetingLink": clean((event.get("onlineMeeting") or {}).get("joinUrl")),
                    "description": clean(event.get("bodyPreview")),
                    "categories": event.get("categories", []),
                    "isCancelled": bool(event.get("isCancelled")),
                    "durationMinutes": event_duration_minutes(event),
                }
                for event in raw_events
            ]
        except (GraphActivityError, TeamsAuthError) as exc:
            calendar_errors.append(f"{employee_id}: {exc}")
            events_by_employee[employee_id] = []

    sites = []
    sharepoint_errors = []
    for site in client.search_sites(limit=100):
        web_url = clean(site.get("webUrl"))
        if "/sites/" not in web_url:
            continue
        item = {
            "id": clean(site.get("id")),
            "displayName": clean(site.get("displayName")),
            "webUrl": web_url,
            "owner": clean(
                ((site.get("createdBy") or {}).get("user") or {}).get("displayName")
            ),
            "lastActivity": clean(site.get("lastModifiedDateTime")),
            "lists": [],
            "files": [],
        }
        try:
            item["lists"] = [
                {
                    "id": clean(row.get("id")),
                    "displayName": clean(row.get("displayName")),
                    "webUrl": clean(row.get("webUrl")),
                    "template": clean((row.get("list") or {}).get("template")),
                }
                for row in client.get_site_lists(item["id"], limit=25)
            ]
        except (GraphActivityError, TeamsAuthError) as exc:
            sharepoint_errors.append(f"{item['displayName']} lists: {exc}")
        try:
            item["files"] = [
                {
                    "id": clean(row.get("id")),
                    "name": clean(row.get("name")),
                    "webUrl": clean(row.get("webUrl")),
                    "size": int(row.get("size") or 0),
                    "lastModifiedDateTime": clean(row.get("lastModifiedDateTime")),
                    "type": "folder" if row.get("folder") else "file",
                }
                for row in client.get_site_drive_items(item["id"], limit=25)
            ]
        except (GraphActivityError, TeamsAuthError) as exc:
            sharepoint_errors.append(f"{item['displayName']} files: {exc}")
        sites.append(item)

    employee_summaries = []
    for employee in employees:
        employee_id = clean(employee.get("id"))
        user = matched.get(employee_id)
        events = events_by_employee.get(employee_id, [])
        graph_activity = summarize_employee_graph(employee, user, tasks_by_user, events, now)
        sp = resolve_sharepoint_activity(employee, sp_activity)
        graph_activity["sharePoint"] = {
            "filesViewedEdited": sp["filesViewedEdited"] if sp else 0,
            "filesSynced": sp["filesSynced"] if sp else 0,
            "filesSharedInternally": sp["filesSharedInternally"] if sp else 0,
            "filesSharedExternally": sp["filesSharedExternally"] if sp else 0,
            "pagesVisited": sp["pagesVisited"] if sp else 0,
            "lastActivityDate": sp["lastActivityDate"] if sp else "",
        }
        employee["graphActivity"] = graph_activity
        employee_summaries.append(
            {
                "id": employee_id,
                "name": clean(employee.get("name")),
                "team": clean(employee.get("team")),
                **graph_activity,
            }
        )

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    graph_payload = {
        "meta": {
            "generatedAt": generated_at,
            "periodStart": start.date().isoformat(),
            "periodEnd": end.date().isoformat(),
            "calendarTimeZone": "Asia/Kolkata (+05:30)",
            "matchedEmployees": len(matched),
            "totalEmployees": len(employees),
            "errors": {
                "planner": planner_errors[:20],
                "calendar": calendar_errors[:20],
                "sharepoint": sharepoint_errors[:20],
            },
        },
        "overview": {
            "groups": len(groups),
            "plans": len(plans),
            "plannerTasks": sum(len(plan["tasks"]) for plan in plans),
            "completedPlannerTasks": sum(
                1 for plan in plans for task in plan["tasks"] if task["status"] == "Completed"
            ),
            "onTimePlannerTasks": sum(
                1 for s in employee_summaries
                for _ in [s.get("planner", {})]
                if s.get("planner", {}).get("onTime", 0)
            ),
            "overduePlannerTasks": sum(
                (s.get("planner", {}).get("overdueCompleted", 0) + s.get("planner", {}).get("overdueOpen", 0))
                for s in employee_summaries
            ),
            "calendarEvents": sum(len(events) for events in events_by_employee.values()),
            "sharePointSites": len(sites),
            "sharePointLists": sum(len(site["lists"]) for site in sites),
            "sharePointFiles": sum(len(site["files"]) for site in sites),
            "sharePointActiveUsers": len([k for k in sp_activity if not k.startswith("name:")]),
            "sharePointFilesViewedEdited": sum(
                s.get("sharePoint", {}).get("filesViewedEdited", 0) for s in employee_summaries
            ),
        },
        "employees": employee_summaries,
        "planner": {"plans": plans},
        "sharePoint": {"sites": sites},
    }
    GRAPH_FILE.write_text(json.dumps(graph_payload, indent=2), encoding="utf-8")

    peopleops.setdefault("meta", {})["graphRefreshedAt"] = generated_at
    peopleops["meta"]["graphPeriod"] = {
        "start": start.date().isoformat(),
        "end": end.date().isoformat(),
    }
    peopleops["graphOverview"] = graph_payload["overview"]
    PEOPLEOPS_FILE.write_text(json.dumps(peopleops, indent=2), encoding="utf-8")
    print(
        f"Microsoft Graph refreshed: {len(plans)} plans, "
        f"{graph_payload['overview']['plannerTasks']} tasks, "
        f"{graph_payload['overview']['calendarEvents']} calendar events, "
        f"{len(sites)} SharePoint sites, {len(matched)}/{len(employees)} employees matched."
    )


if __name__ == "__main__":
    try:
        refresh()
    except (RuntimeError, TeamsAuthError, GraphActivityError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
