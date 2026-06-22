from __future__ import annotations

import json
import math
import re
import statistics
import sys
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
PROJECT = Path(__file__).resolve().parents[1]
OUT = PROJECT / "data" / "peopleops-data.json"
SAMPLE_PERIOD_LABEL = "Sample evaluation data"
sys.path.insert(0, str(PROJECT))

from services.greythr_api_client import GreytHRApiError, GreytHRAuthError, GreytHRConfigError, get_greythr_attendance
from services.teams_api_client import TeamsApiError, get_presences_by_user_id, get_teams_users
from services.teams_auth import TeamsAuthError
from services.teams_transformer import teams_presence_dataframe_from_payload
from services.worklogix_api_client import (
    get_worklogix_daily_updates,
    get_worklogix_employee_info,
    get_worklogix_employee_presence_report,
    get_worklogix_projects,
    get_worklogix_tasks,
)
from services.worklogix_transformer import (
    daily_updates_dataframe_from_payload,
    employees_dataframe_from_payload,
    extract_rows,
    projects_dataframe_from_payload,
)

def clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.upper() in {"NULL", "NAN", "NONE"} else text


def num(value, default=0.0):
    try:
        if value in (None, "", "null", "NULL"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_jsonish(value, fallback):
    value = clean(value)
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def excel_date(serial):
    try:
        return (datetime(1899, 12, 30) + timedelta(days=float(serial))).date().isoformat()
    except (TypeError, ValueError):
        return clean(serial)


def excel_time(serial):
    try:
        fraction = float(serial) % 1
        total = round(fraction * 24 * 60)
        return f"{total // 60:02d}:{total % 60:02d}"
    except (TypeError, ValueError):
        return clean(serial)


def time_to_hours(value):
    value = clean(value)
    if not value:
        return 0.0
    match = re.match(r"^(\d+):(\d+)", value)
    if match:
        return int(match.group(1)) + int(match.group(2)) / 60
    return num(value)


def normalize_name(value):
    return re.sub(r"[^a-z0-9]+", "", clean(value).lower())


def email_local(value):
    return clean(value).split("@", 1)[0].lower()


def build_graph_user_maps():
    try:
        graph_users = get_teams_users()
    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"WARNING: Teams user lookup skipped: {exc}", file=sys.stderr)
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


def resolve_teams_user(user, graph_maps):
    existing_id = clean(user.get("ms_teams_id"))
    by_id, by_mail, by_name = graph_maps
    if existing_id and existing_id.lower() in by_id:
        return by_id[existing_id.lower()]
    for key in ("id", "employee_id", "employee_code", "email", "mail", "userPrincipalName"):
        local = email_local(user.get(key)) or clean(user.get(key)).lower()
        if local and local in by_mail:
            return by_mail[local]
    name_matches = by_name.get(normalize_name(user.get("name")), [])
    if len(name_matches) == 1:
        return name_matches[0]
    return None


def standardize_team(value):
    team = clean(value) or "Unassigned"
    key = re.sub(r"[^a-z0-9]+", "", team.lower())
    mapping = {
        "softwaredevelopment": "Software Development",
        "softwaredevelopmentteam": "Software Development",
        "softwaredeveloper": "Software Development",
        "developmentteam": "Software Development",
        "aidevelopment": "AI Development",
        "technologydevelopment": "Technology & Development",
        "businessdevelopment": "Business Development",
        "devopsteam": "DevOps Team",
    }
    return mapping.get(key, team)


def source_label(source):
    labels = {
        "worklogix": "Worklogix",
        "greythr": "GreytHR",
        "biometrics": "Biometrics",
        "teams": "Teams",
    }
    return labels.get(source, source)


def build_gap_analysis(sources, source_confidence, score_drivers, kpi):
    missing_sources = [source_label(source) for source, available in sources.items() if not available]
    driver_labels = {
        "delivery": "Delivery",
        "efficiency": "Weighted efficiency",
        "attendance": "Attendance",
        "collaboration": "Teams collaboration",
        "volume": "Workload volume",
        "quality": "Completion quality",
    }
    weak_drivers = [
        f"{driver_labels[key]} {value}"
        for key, value in sorted(score_drivers.items(), key=lambda item: item[1])
        if value < 60
    ]
    reasons = []
    if source_confidence < 75:
        reasons.append("KPI not calculated because source confidence is below 75%")
    elif kpi is not None and kpi < 70:
        reasons.append("KPI is below high-performance level")
    if missing_sources:
        reasons.append("Missing data from " + ", ".join(missing_sources))
    if weak_drivers:
        reasons.append("Lagging drivers: " + ", ".join(weak_drivers[:3]))
    return {
        "missingSources": missing_sources,
        "laggingDrivers": weak_drivers,
        "gapReason": "; ".join(reasons) if reasons else "No major gap found",
    }


def is_real_employee(user):
    emp_id = clean(user.get("id"))
    name = clean(user.get("name")).lower()
    role = clean(user.get("role"))
    team = clean(user.get("team")).lower()
    designation = clean(user.get("designation")).lower()
    if role == "7" or emp_id.startswith("CLT"):
        return False
    if "(test)" in emp_id.lower():
        return False
    if team in {"test", "test account", "test(for test)"}:
        return False
    if designation in {"test", "test account"} or "client" in designation:
        return False
    if name in {"test project manager", "test employee", "test client", "leadership test"}:
        return False
    return True


def dataframe_records(frame):
    if frame.empty:
        return []
    return frame.fillna("").to_dict("records")


def read_worklogix_api():
    # Worklogix CSV usage is replaced here with live API data. The transformer
    # keeps the old column names so the KPI logic can continue unchanged.
    employees_payload = get_worklogix_employee_info()
    tasks_payload = get_worklogix_tasks()
    daily_payload = get_worklogix_daily_updates()
    projects_payload = get_worklogix_projects()

    # These DataFrame names mirror the old CSV-driven flow as closely as possible.
    employees_df = employees_dataframe_from_payload(employees_payload)
    tasks_df = pd.DataFrame(extract_rows(tasks_payload)).fillna("")
    daily_df = daily_updates_dataframe_from_payload(daily_payload)
    projects_df = projects_dataframe_from_payload(projects_payload)

    if daily_df.empty and not tasks_df.empty:
        daily_df = daily_updates_dataframe_from_payload(tasks_payload)

    return {
        "users": dataframe_records(employees_df),
        "tasks": dataframe_records(tasks_df),
        "daily": dataframe_records(daily_df),
        # Monthly Update API disabled because current account has no permission.
        "monthly": [],
        "projects": dataframe_records(projects_df),
    }


def read_teams_api(users):
    graph_maps = build_graph_user_maps()
    teams_id_map = {}
    for emp_id, user in users.items():
        graph_user = resolve_teams_user(user, graph_maps)
        ms_id = clean(graph_user.get("id")) if graph_user else clean(user.get("ms_teams_id"))
        if ms_id:
            teams_id_map[ms_id] = emp_id
            user["ms_teams_id"] = ms_id

    result = defaultdict(lambda: Counter())
    if not teams_id_map:
        return result

    active_statuses = {
        "Available", "Busy", "InACall", "InAConferenceCall",
        "InAMeeting", "Presenting", "DoNotDisturb",
    }
    away_statuses = {
        "Away", "BeRightBack", "OutOfOffice", "OffWork",
    }
    offline_statuses = {
        "Offline", "Inactive", "PresenceUnknown",
    }

    payload = get_presences_by_user_id(list(teams_id_map.keys()))
    df = teams_presence_dataframe_from_payload(payload)

    for _, row in df.iterrows():
        ms_id = clean(row.get("User ID"))
        emp_id = teams_id_map.get(ms_id)
        if not emp_id:
            continue
        availability = clean(row.get("Availability"))
        activity = clean(row.get("Activity"))
        status = availability or activity
        result[emp_id]["status"] = status
        result[emp_id]["isActive"] += 1 if status in active_statuses else 0
        result[emp_id]["isAway"] += 1 if status in away_statuses else 0
        result[emp_id]["isOffline"] += 1 if status in offline_statuses else 0
        result[emp_id]["workLocation"] = clean(row.get("Work Location"))
        result[emp_id]["isOutOfOffice"] = 1 if status == "OutOfOffice" else 0
        result[emp_id]["reports"] += 1

    return result


def percentile(values, pct):
    if not values:
        return 0.0
    values = sorted(values)
    pos = (len(values) - 1) * pct
    low = math.floor(pos)
    high = math.ceil(pos)
    if low == high:
        return values[low]
    return values[low] * (high - pos) + values[high] * (pos - low)


def minmax(value, values, invert=False):
    values = [v for v in values if v is not None]
    if not values:
        return 50.0
    lo, hi = min(values), max(values)
    if hi == lo:
        return 75.0
    score = (value - lo) / (hi - lo) * 100
    return 100 - score if invert else score


def parse_duration_string(value):
    if not value:
        return 0.0
    text = str(value).lower()
    h_match = re.search(r"(\d+)\s*hour", text)
    m_match = re.search(r"(\d+)\s*min", text)
    hours = float(h_match.group(1)) if h_match else 0.0
    minutes = float(m_match.group(1)) if m_match else 0.0
    return hours + minutes / 60


def to_presence_month_label(period):
    period = clean(period)
    if not period:
        return ""
    for fmt in ("%Y-%m", "%b %Y", "%B %Y"):
        try:
            return datetime.strptime(period, fmt).strftime("%b %Y")
        except ValueError:
            continue
    return period


def read_biometric_api(month_label):
    try:
        payload = get_worklogix_employee_presence_report(month=month_label)
    except Exception as exc:
        print(f"WARNING: biometric presence report skipped: {exc}", file=sys.stderr)
        return defaultdict(lambda: Counter())

    result = defaultdict(lambda: Counter())
    for row in extract_rows(payload):
        emp_id = clean(row.get("user_id"))
        if not emp_id:
            continue
        if row.get("biometric_in_office_status") is not None:
            result[emp_id]["biometricDays"] += 1
        presence = row.get("microsoft_teams_presence") or {}
        avail = parse_duration_string(presence.get("available"))
        if avail > 0:
            result[emp_id]["officeHours"] += avail
            result[emp_id]["validOfficeDays"] += 1
        result[emp_id]["presenceReports"] += 1
    return result


def period_to_date_range(period: str):
    period = clean(period)
    if not period:
        return "", ""
    for fmt in ("%Y-%m", "%b %Y", "%B %Y"):
        try:
            dt = datetime.strptime(period, fmt)
            start = dt.replace(day=1).strftime("%Y-%m-%d")
            end = dt.replace(day=monthrange(dt.year, dt.month)[1]).strftime("%Y-%m-%d")
            return start, end
        except ValueError:
            continue
    return "", ""


def read_greythr_api(start: str, end: str) -> defaultdict:
    result = defaultdict(lambda: Counter())
    if not start or not end:
        print("WARNING: GreytHR skipped — could not determine date range", file=sys.stderr)
        return result
    try:
        raw = get_greythr_attendance(start, end)
        for emp_no, counter in raw.items():
            result[emp_no] = counter
        print(f"GreytHR attendance loaded: {len(raw)} employees ({start} to {end})")
    except (GreytHRConfigError, GreytHRAuthError, GreytHRApiError) as exc:
        print(f"WARNING: GreytHR attendance skipped: {exc}", file=sys.stderr)
    return result


def main():
    # KPI generation now uses live Worklogix and Teams API data. Local
    # Biometrics, GreytHR, Teams, and Worklogix input files are no longer read.
    worklogix = read_worklogix_api()
    all_users = {clean(r["id"]): r for r in worklogix["users"]}
    all_users = {k: v for k, v in all_users.items() if k}
    users = {emp_id: user for emp_id, user in all_users.items() if is_real_employee(user)}
    allowed_employee_ids = set(users)
    all_daily_rows = worklogix["daily"]
    month_counts = Counter(clean(r.get("month")) for r in all_daily_rows if clean(r.get("month")))
    target_period = month_counts.most_common(1)[0][0] if month_counts else ""
    monthly = {
        clean(r["employee_id"]): r
        for r in worklogix["monthly"]
        if clean(r.get("month")) == target_period and clean(r.get("employee_id")) in allowed_employee_ids
    }
    daily = [
        r for r in all_daily_rows
        if clean(r.get("month")) == target_period and clean(r.get("employee_id")) in allowed_employee_ids
    ]
    projects = worklogix["projects"]

    employees = {}
    for emp_id, user in users.items():
        employees[emp_id] = {
            "id": emp_id,
            "name": clean(user.get("name")) or emp_id,
            "designation": clean(user.get("designation")) or "Unassigned",
            "team": standardize_team(user.get("team")),
            "active": clean(user.get("is_active")).lower() == "true",
            "teamsId": clean(user.get("ms_teams_id")),
            "sourceKeys": {
                "worklogix": emp_id,
                "teams": emp_id,
                "biometric": clean(user.get("biometric_id")) or emp_id,
            },
        }

    for emp_id, row in monthly.items():
        employees.setdefault(emp_id, {"id": emp_id, "name": clean(row.get("name")) or emp_id})
        employees[emp_id]["name"] = clean(row.get("name")) or employees[emp_id]["name"]
        employees[emp_id]["worklogixScore"] = {
            "completion": num(row.get("completion_score")) * 100,
            "productivity": num(row.get("productivity_score")) * 100,
            "volume": num(row.get("volume_score")) * 100,
            "priority": num(row.get("priority_score")) * 100,
            "dependency": num(row.get("dependency_score")) * 100,
            "consistency": num(row.get("consistency_score")) * 100,
            "final": num(row.get("final_score")),
            "rating": num(row.get("final_rating")),
        }

    work_item_stats = defaultdict(lambda: Counter())
    project_hours = defaultdict(float)
    priority_weights = {"Low": 1, "Medium": 2, "High": 3, "Critical": 4}
    # Weighted efficiency: Primary tasks require more skill/effort than Rework
    work_type_weights = {"Primary": 2.0, "Rework": 1.0}
    priority_multipliers = {"High": 1.5, "Medium": 1.0, "Low": 0.5}
    for row in daily:
        emp_id = clean(row.get("employee_id"))
        if not emp_id:
            continue
        stats = work_item_stats[emp_id]
        stats["workItems"] += 1
        stats[f"status:{clean(row.get('status')) or 'Unknown'}"] += 1
        stats[f"approval:{clean(row.get('approval_status')) or 'Unknown'}"] += 1
        stats["priorityPoints"] += priority_weights.get(clean(row.get("priority")), 1)
        # Task weight = work_type_weight × priority_multiplier
        task_weight = (
            work_type_weights.get(clean(row.get("work_type")), 1.5)
            * priority_multipliers.get(clean(row.get("priority")), 1.0)
        )
        stats["totalWeightedPoints"] += task_weight
        if clean(row.get("status")) == "Completed":
            stats["weightedPointsCompleted"] += task_weight
        if clean(row.get("dependency_status")).lower() == "blocked":
            stats["blocked"] += 1
        working_hours_raw = row.get("working_hours")
        if isinstance(working_hours_raw, (int, float)):
            stats["workHours"] += num(working_hours_raw)
        else:
            working_hours = parse_jsonish(working_hours_raw, {})
            if isinstance(working_hours, dict):
                for day in working_hours.values():
                    stats["workHours"] += num(day.get("hours") if isinstance(day, dict) else day)
            elif isinstance(working_hours, (int, float)):
                stats["workHours"] += num(working_hours)
        stats["meetingHours"] += num(row.get("meeting_hours"))
        project_hours[clean(row.get("project_id"))] += stats["workHours"]

    greythr_start, greythr_end = period_to_date_range(target_period)
    if not greythr_start and all_daily_rows:
        date_months = Counter(
            clean(r.get("assigned_date", ""))[:7]
            for r in all_daily_rows
            if len(clean(r.get("assigned_date", ""))) >= 7
        )
        if date_months:
            greythr_start, greythr_end = period_to_date_range(date_months.most_common(1)[0][0])
    greythr = read_greythr_api(greythr_start, greythr_end)
    teams = read_teams_api(users)
    presence_month = to_presence_month_label(target_period)
    attendance = read_biometric_api(presence_month)

    project_cards = []
    for row in projects:
        members = parse_jsonish(row.get("project_member"), [])
        active_members = [
            m for m in members
            if isinstance(m, dict) and clean(m.get("user_id")) in allowed_employee_ids
        ] if isinstance(members, list) else []
        if not active_members:
            continue
        project_cards.append({
            "id": clean(row.get("id")),
            "name": clean(row.get("name")),
            "status": clean(row.get("status")),
            "members": len(active_members),
            "estimatedHours": sum(num(m.get("hours_estimated")) for m in active_members),
        })

    work_scores = [e.get("worklogixScore", {}).get("final", 0) for e in employees.values()]
    team_active = [teams[eid]["isActive"] for eid in employees if teams[eid]]
    office_hours = [attendance[eid]["officeHours"] for eid in employees if attendance[eid]]
    work_item_counts = [work_item_stats[eid]["workItems"] for eid in employees if work_item_stats[eid]]
    absence_counts = [greythr[eid]["A"] for eid in employees if greythr[eid]]
    efficiency_hours_map = {
        eid: (attendance.get(eid, Counter())["officeHours"] or work_item_stats[eid]["workHours"])
        for eid in employees
        if work_item_stats[eid]["workItems"]
    }
    all_efficiencies = [
        work_item_stats[eid]["weightedPointsCompleted"] / max(1, efficiency_hours_map[eid])
        for eid in efficiency_hours_map
    ]

    employee_rows = []
    for emp_id, emp in employees.items():
        stats = work_item_stats[emp_id]
        gh = greythr[emp_id]
        bio = attendance[emp_id]
        tm = teams[emp_id]
        monthly_final = emp.get("worklogixScore", {}).get("final", 0)
        efficiency_hours = efficiency_hours_map.get(emp_id, stats["workHours"])
        raw_efficiency = stats["weightedPointsCompleted"] / max(1, efficiency_hours)
        efficiency_driver = minmax(raw_efficiency, all_efficiencies) if stats["workItems"] else 50
        if monthly_final:
            worklogix_score = monthly_final
        elif stats["workItems"]:
            weighted_completion_rate = stats["weightedPointsCompleted"] / max(1, stats["totalWeightedPoints"])
            approval_rate = stats["approval:approved"] / max(1, stats["workItems"])
            efficiency_signal = efficiency_driver / 100
            worklogix_score = (weighted_completion_rate * 55 + approval_rate * 25 + efficiency_signal * 20)
        else:
            worklogix_score = 50
        attendance_score = 100 - minmax(gh["A"], absence_counts, invert=False) if gh else minmax(bio["officeHours"], office_hours)
        activity_score = minmax(tm["isActive"], team_active) if tm else 50
        volume_score = minmax(stats["workItems"], work_item_counts) if stats else 50
        quality_score = emp.get("worklogixScore", {}).get("completion") or (
            stats["status:Completed"] / max(1, stats["workItems"]) * 100 if stats["workItems"] else 50
        )
        sources = {
            "worklogix": emp_id in allowed_employee_ids,
            "greythr": bool(greythr.get(emp_id)),
            "biometrics": bool(attendance.get(emp_id)),
            "teams": bool(tm),
        }
        source_count = sum(sources.values())
        source_confidence = round(source_count / len(sources) * 100)
        kpi = None
        band = ""
        if source_confidence >= 75:
            kpi = round(
                worklogix_score * 0.45
                + attendance_score * 0.2
                + activity_score * 0.15
                + volume_score * 0.1
                + quality_score * 0.1,
                1,
            )
            band = "High Performance" if kpi >= 70 else "Need Improvement" if kpi >= 55 else "Low Performance"
        score_drivers = {
            "delivery": round(worklogix_score, 1),
            "efficiency": round(efficiency_driver, 1),
            "attendance": round(attendance_score, 1),
            "collaboration": round(activity_score, 1),
            "volume": round(volume_score, 1),
            "quality": round(quality_score, 1),
        }
        gap_analysis = build_gap_analysis(sources, source_confidence, score_drivers, kpi)
        employee_rows.append({
            **emp,
            "kpi": kpi,
            "band": band,
            "sourceConfidence": source_confidence,
            "sources": sources,
            "worklogixScore": emp.get("worklogixScore", {}),
            "worklogix": {
                "workItems": stats["workItems"],
                "completed": stats["status:Completed"],
                "todo": stats["status:Todo"],
                "inProgress": stats["status:In Progress"],
                "approved": stats["approval:approved"],
                "pending": stats["approval:pending"],
                "blocked": stats["blocked"],
                "workHours": round(stats["workHours"], 1),
                "meetingHours": round(stats["meetingHours"], 1),
                "priorityPoints": stats["priorityPoints"],
                "weightedPointsCompleted": round(stats["weightedPointsCompleted"], 1),
                "totalWeightedPoints": round(stats["totalWeightedPoints"], 1),
                "efficiencyScore": round(raw_efficiency, 2),
                "efficiencyHours": round(efficiency_hours, 1),
            },
            "attendance": {
                "present": gh["P"],
                "absent": gh["A"],
                "off": gh["OFF"],
                "holidays": gh["H"],
                "leave": sum(v for k, v in gh.items() if k not in {"P", "A", "OFF", "H", "Blank"}),
                "blank": gh["Blank"],
                "biometricDays": bio["biometricDays"],
                "officeHours": round(bio["officeHours"], 1),
                "avgOfficeHours": round(bio["officeHours"] / max(1, bio["validOfficeDays"]), 1),
            },
            "teams": {
                "status": tm.get("status", ""),
                "workLocation": tm.get("workLocation", ""),
                "isActive": tm["isActive"],
                "isAway": tm["isAway"],
                "isOffline": tm["isOffline"],
                "isOutOfOffice": tm["isOutOfOffice"],
                "reports": tm["reports"],
            },
            "scoreDrivers": score_drivers,
            "missingSources": gap_analysis["missingSources"],
            "laggingDrivers": gap_analysis["laggingDrivers"],
            "gapReason": gap_analysis["gapReason"],
        })

    employee_rows.sort(key=lambda item: item["kpi"] if item["kpi"] is not None else -1, reverse=True)
    active_rows = [e for e in employee_rows if e.get("active", True)]
    inactive_rows = [e for e in employee_rows if not e.get("active", True)]
    scored_rows = [e for e in employee_rows if e["kpi"] is not None]
    kpis = [e["kpi"] for e in scored_rows]
    source_counts = Counter()
    for e in employee_rows:
        for key, available in e["sources"].items():
            source_counts[key] += 1 if available else 0

    payload = {
        "meta": {
            "name": "PeopleOPS Intelligence",
            "period": SAMPLE_PERIOD_LABEL,
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "dataMode": "Worklogix API + GreytHR API + Biometrics API + Teams API",
            "sourceFiles": {
                "worklogix": "api",
                "greythr": "api",
                "biometrics": "api",
                "teams": "api",
            },
            "weights": {
                "worklogixDelivery": 45,
                "attendance": 20,
                "teamsCollaboration": 15,
                "workloadVolume": 10,
                "completionQuality": 10,
            },
        },
        "overview": {
            "employees": len(employee_rows),
            "activeEmployees": len(active_rows),
            "inactiveEmployees": len(inactive_rows),
            "avgKpi": round(statistics.mean(kpis), 1) if kpis else 0,
            "medianKpi": round(statistics.median(kpis), 1) if kpis else 0,
            "topQuartile": round(percentile(kpis, 0.75), 1),
            "scoredEmployees": len(scored_rows),
            "unscoredEmployees": len(employee_rows) - len(scored_rows),
            "riskCount": sum(1 for e in scored_rows if e["band"] == "Low Performance"),
            "watchCount": sum(1 for e in scored_rows if e["band"] == "Need Improvement"),
            "totalWorkItems": sum(e["worklogix"]["workItems"] for e in employee_rows),
            "completedWorkItems": sum(e["worklogix"]["completed"] for e in employee_rows),
            "blockedWorkItems": sum(e["worklogix"]["blocked"] for e in employee_rows),
            "officeHours": round(sum(e["attendance"]["officeHours"] for e in employee_rows), 1),
            "teamsActiveCount": sum(e["teams"]["isActive"] for e in employee_rows),
            "teamsAwayCount": sum(e["teams"]["isAway"] for e in employee_rows),
            "teamsOfflineCount": sum(e["teams"]["isOffline"] for e in employee_rows),
            "teamsOutOfOfficeCount": sum(e["teams"]["isOutOfOffice"] for e in employee_rows),
            "sourceCoverage": dict(source_counts),
        },
        "employees": employee_rows,
        "projects": sorted(project_cards, key=lambda p: (p["members"], p["estimatedHours"]), reverse=True),
        "bands": dict(Counter(e["band"] or "Insufficient Data" for e in employee_rows)),
    }
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(PROJECT)} with {len(employee_rows)} employees")


if __name__ == "__main__":
    main()
