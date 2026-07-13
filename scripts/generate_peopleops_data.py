from __future__ import annotations

import csv
import io
import json
import math
import os
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
GITHUB_DATA_FILE = PROJECT / "data" / "github-data.json"
SAMPLE_PERIOD_LABEL = "Sample evaluation data"
sys.path.insert(0, str(PROJECT))

from services.greythr_api_client import GreytHRApiError, GreytHRAuthError, GreytHRConfigError, get_greythr_attendance
from services.teams_api_client import TeamsApiError, get_presences_by_user_id, get_teams_activity_report, get_teams_users, get_teams_users_with_manager
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


# Manual team corrections — applied after data is loaded from all sources
TEAM_OVERRIDES = {
    "92aeedc1-492b-4dae-ab4b-cefc91956c4a": "Management Team",  # Bala Prasanna R — PM Intern moved from Business Development
}


def get_role_category(designation: str) -> str:
    """Return 'executive', 'technical', 'management', 'support', or 'intern' per the
    KPI Calculation Framework's role categories.

    - executive : CEO, MD, Advisors, Chiefs — no KPI scored (band = 'Executive')
    - management: Delivery Manager, Project Manager, Junior Manager (incl. "PM Intern",
                  which is an established exception carried over from the org chart)
                  → Management KPI (Team Avg 35% + Project Delivery 25% + Approval Speed 10%
                    + Attendance 10% + Punctuality 5% + Collaboration 10% + Planner Completion 5%)
    - intern    : any other designation containing "intern" (excl. "PM Intern" above).
                  "Trainee" designations are NOT treated as interns — they fall through
                  to whichever category their actual role implies (e.g. "AI Trainee" →
                  technical, "Cyber Security Trainee" → support), same as any employee.
                  → Intern KPI (Task Completion 30% + Punctuality 20% + Collaboration 20%
                    + Mentor Feedback 30%)
    - support   : HR, Recruiter, Marketing, BDM/Business Development, Admin, Accounts,
                  UI/UX, Cyber Security
                  → Support KPI (Attendance 25% + Punctuality 15% + Collaboration 20%
                    + Task Completion 30% + Manager Ratings 10%)
    - technical : everyone else (Developers, QA, AI Engineers, DevOps, Fullstack, etc.)
                  → Technical KPI (Productivity 55% + Code Contribution 5% + Attendance 15%
                    + Punctuality 15% + Teams Collaboration 10%)
    """
    d = (designation or "").lower()
    exec_keys = ["managing director", "director", "advisor", "chief"]
    if any(k in d for k in exec_keys):
        return "executive"
    if "pm intern" in d:
        return "management"
    if "intern" in d:
        return "intern"
    support_keys = ["hr", "human resource", "recruiter", "admin", "bdm",
                    "business development", "marketing", "ui /", "ui/", "ux", "account",
                    "cyber security", "cyber"]
    if any(k in d for k in support_keys):
        return "support"
    mgmt_keys = ["delivery manager", "project manager", "manager"]
    if any(k in d for k in mgmt_keys):
        return "management"
    return "technical"


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
        "productivity": "Productivity",
        "attendance": "Attendance",
        "taskCompletion": "Task Completion",
        "punctuality": "Punctuality",
        "collaboration": "Collaboration",
        "github": "GitHub Contribution",
        "codeContribution": "Code Contribution",
        "pmProjectScore": "Project Delivery",
        "projectDelivery": "Project Delivery",
        "taskApprovalSpeed": "Task Approval Speed",
        "plannerCompletion": "Planner Completion",
    }
    weak_drivers = [
        f"{driver_labels.get(key, key)} {value}"
        for key, value in sorted(score_drivers.items(), key=lambda item: item[1])
        if value < 60
    ]
    reasons = []
    if source_confidence < 50:
        reasons.append("KPI not calculated — source confidence below 50% (fewer than 2 data sources matched)")
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
    emp_id = clean(user.get("user_id") or user.get("id"))
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
    # Generic placeholder names that are not real employees
    if name in {"employee", "team lead"}:
        return False
    # Names beginning with "test " are test accounts (e.g. "Test Hr", "Test Intern")
    if name.startswith("test "):
        return False
    # Ex-employees marked inline (e.g. "Nithisha Ex-PM")
    if " ex-" in name or name.endswith(" ex"):
        return False
    # Inactive employees (marked as left in Worklogix)
    if clean(user.get("is_active")).lower() == "false":
        return False
    return True


def dataframe_records(frame):
    if frame.empty:
        return []
    return frame.fillna("").to_dict("records")


def read_worklogix_api():
    # Worklogix CSV usage is replaced here with live API data. The transformer
    # keeps the old column names so the KPI logic can continue unchanged.
    from services.worklogix_api_client import WorklogixApiError
    from services.worklogix_auth import WorklogixAuthError
    try:
        employees_payload = get_worklogix_employee_info()
        tasks_payload = get_worklogix_tasks()
        daily_payload = get_worklogix_daily_updates()
        projects_payload = get_worklogix_projects()
    except WorklogixAuthError as exc:
        print(f"ERROR: Worklogix login failed — check credentials in .env: {exc}", file=sys.stderr)
        sys.exit(1)
    except WorklogixApiError as exc:
        print(f"ERROR: Worklogix API unavailable — try again in a moment: {exc}", file=sys.stderr)
        sys.exit(1)

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
        # Use Teams jobTitle as designation if available — it's maintained by HR in Microsoft 365
        if graph_user:
            job_title = clean(graph_user.get("jobTitle"))
            if job_title:
                user["designation"] = job_title

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
    score = 100 - score if invert else score
    return max(0.0, min(100.0, score))


def weighted_score(components):
    """components: iterable of (label, score_or_None, weight).

    Implements the KPI Calculation Framework's weighted-composite formula while
    handling sub-metrics that have no data source (e.g. Manager Ratings, Mentor
    Feedback, Task Approval Speed when timestamps are missing): components with
    score=None are dropped and the remaining weights are renormalized to sum to
    100, so the KPI is always computed purely from real, available data instead
    of guessing a value for the missing input.

    Returns (rounded_score_or_None, {label: effective_weight_pct}).
    """
    available = [(label, score, weight) for label, score, weight in components if score is not None]
    total_weight = sum(weight for _, _, weight in available)
    if not available or total_weight <= 0:
        return None, {}
    result = sum(score * (weight / total_weight) for _, score, weight in available)
    weights_used = {label: round(weight / total_weight * 100, 1) for label, _, weight in available}
    return round(result, 1), weights_used


def band_for_kpi(kpi):
    return (
        "Excellent" if kpi >= 90 else
        "Good" if kpi >= 80 else
        "Average" if kpi >= 70 else
        "Needs Improvement" if kpi >= 60 else
        "Critical"
    )


def quadrant_for(prod_high, att_high):
    if prod_high and att_high:
        return "High Performer"
    if prod_high and not att_high:
        return "Ghost Worker"
    if not prod_high and att_high:
        return "Present but Idle"
    return "Disengaged"


def approval_turnaround_score(created_at, updated_at):
    """Score how quickly a submitted task was reviewed/approved, per the KPI
    framework's turnaround table: <=4h=100, <=1 day=90, <=2 days=80, beyond
    that scaled down 15 points per additional day. Returns None if the
    timestamps are missing/unparseable (caller should redistribute the weight)."""
    created = pd.to_datetime(clean(created_at), errors="coerce")
    updated = pd.to_datetime(clean(updated_at), errors="coerce")
    if pd.isna(created) or pd.isna(updated):
        return None
    hours = (updated - created).total_seconds() / 3600
    if hours < 0:
        return None
    if hours <= 4:
        return 100.0
    if hours <= 24:
        return 90.0
    if hours <= 48:
        return 80.0
    days_over = (hours - 48) / 24
    return max(0.0, 80.0 - days_over * 15)


def compute_attendance_pct(gh, bio, fallback):
    """Attendance = (Present Days / Working Days) x 100. Working Days = Present +
    Absent + Leave (days the employee was expected to work). Falls back to the
    biometric-derived proxy, then the pre-computed minmax fallback, when GreytHR
    data isn't available for this employee."""
    working_days = (gh["P"] + gh["A"] + gh["Leave"]) if gh else 0
    if working_days > 0:
        return round(min(100.0, gh["P"] / working_days * 100), 1)
    if bio.get("validOfficeDays"):
        return round(min(100.0, bio["biometricDays"] / bio["validOfficeDays"] * 100), 1)
    return round(fallback, 1)


def compute_punctuality_pct(bio, fallback):
    """Punctuality = (On-time Days / Working Days) x 100, from biometric check-in
    times. Falls back to the pre-computed minmax proxy when unavailable."""
    punct_raw = bio.get("punctualityScore")
    return round(punct_raw, 1) if punct_raw is not None else round(fallback, 1)


def compute_collaboration_pct(bio, ta, all_meeting_counts, fallback):
    """Teams Collaboration = (Availability Score x 50%) + (Meeting Score x 50%).
    Availability Score = Productive Hours / Total Tracked Hours x 100 (Teams
    presence). Meeting Score = meeting count normalized against the org (the
    Teams activity export has no "meetings invited" count to divide by)."""
    avail_total = bio.get("teamsAvailableHours", 0) + bio.get("teamsAwayHours", 0) + bio.get("teamsOfflineHours", 0)
    availability_score = (bio.get("teamsAvailableHours", 0) / avail_total * 100) if avail_total > 0 else None
    meeting_score = minmax(ta["meetingCount"], all_meeting_counts) if ta else None
    if availability_score is not None and meeting_score is not None:
        return round(availability_score * 0.5 + meeting_score * 0.5, 1)
    if availability_score is not None:
        return round(availability_score, 1)
    if meeting_score is not None:
        return round(meeting_score, 1)
    return round(fallback, 1)


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
    for fmt in ("%Y-%m-%d", "%Y-%m", "%b %Y", "%B %Y"):
        try:
            return datetime.strptime(period, fmt).strftime("%b %Y")
        except ValueError:
            continue
    return ""


OFFICE_START_HOUR = 9.5   # 9:30 AM
LATE_GRACE_MINUTES = 30   # 30-min grace window — on-time cutoff is 10:00 AM


def parse_time_ampm(s: str):
    """Parse '09:13 AM' or '06:05 PM' → float hours (24h). Returns None on failure."""
    s = s.strip().upper()
    try:
        dt = datetime.strptime(s, "%I:%M %p")
        return dt.hour + dt.minute / 60
    except ValueError:
        pass
    try:
        parts = s.split(":")
        return int(parts[0]) + int(parts[1]) / 60
    except (ValueError, IndexError):
        return None


def read_biometric_api(month_label):
    try:
        payload = get_worklogix_employee_presence_report(month=month_label)
    except Exception as exc:
        print(f"WARNING: biometric presence report skipped: {exc}", file=sys.stderr)
        return defaultdict(lambda: Counter())

    result = defaultdict(lambda: Counter())
    checkin_times: dict[str, list[float]] = defaultdict(list)
    checkout_times: dict[str, list[float]] = defaultdict(list)

    for row in extract_rows(payload):
        emp_id = clean(row.get("user_id"))
        if not emp_id:
            continue
        # Also index by normalised name so UUID-keyed employees (interns) can match
        user_name_key = normalize_name(row.get("user_name", ""))
        if user_name_key:
            result[f"name:{user_name_key}"] = result[emp_id]

        bio = row.get("biometric_in_office_status") or {}
        if bio:
            result[emp_id]["biometricDays"] += 1
            # "09:13 AM - 06:05 PM"
            time_range = clean(bio.get("time", ""))
            if " - " in time_range:
                cin_str, cout_str = time_range.split(" - ", 1)
                cin = parse_time_ampm(cin_str)
                cout = parse_time_ampm(cout_str)
                if cin is not None:
                    checkin_times[emp_id].append(cin)
                if cout is not None:
                    checkout_times[emp_id].append(cout)
            loc = clean(bio.get("location", ""))
            if loc:
                result[emp_id][f"loc:{loc}"] += 1

        presence = row.get("microsoft_teams_presence") or {}
        avail = parse_duration_string(presence.get("available"))
        away = parse_duration_string(presence.get("away"))
        offline = parse_duration_string(presence.get("offline") or presence.get("offline_presence"))
        if avail > 0:
            result[emp_id]["officeHours"] += avail
            result[emp_id]["validOfficeDays"] += 1
        result[emp_id]["teamsAvailableHours"] += avail
        result[emp_id]["teamsAwayHours"] += away
        result[emp_id]["teamsOfflineHours"] += offline
        result[emp_id]["presenceReports"] += 1

    # Compute punctuality score and averages per employee
    grace = LATE_GRACE_MINUTES / 60
    for emp_id, times in checkin_times.items():
        on_time = sum(1 for t in times if t <= OFFICE_START_HOUR + grace)
        result[emp_id]["punctualityScore"] = round((on_time / len(times)) * 100, 1)
        result[emp_id]["avgCheckinHour"] = round(sum(times) / len(times), 2)
    for emp_id, times in checkout_times.items():
        result[emp_id]["avgCheckoutHour"] = round(sum(times) / len(times), 2)

    # Resolve most common office location per employee
    for emp_id, counts in result.items():
        loc_counts = {k[4:]: v for k, v in counts.items() if k.startswith("loc:")}
        if loc_counts:
            result[emp_id]["officeLocation"] = max(loc_counts, key=loc_counts.get)

    return result


def read_teams_activity_report() -> dict:
    """Fetch Teams user activity CSV and index by email local part + display name."""
    try:
        csv_text = get_teams_activity_report()
    except Exception as exc:
        print(f"WARNING: Teams activity report skipped: {exc}", file=sys.stderr)
        return {}

    result = {}
    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        for row in reader:
            upn = clean(row.get("User Principal Name") or row.get("userPrincipalName") or "")
            if not upn:
                continue
            local = email_local(upn)
            display = clean(row.get("Display Name") or "")
            entry = {
                "upn": upn,
                "displayName": display,
                "meetingHours": round(num(row.get("Audio Duration In Seconds")) / 3600, 2),
                "videoCallHours": round(num(row.get("Video Duration In Seconds")) / 3600, 2),
                "screenShareHours": round(num(row.get("Screen Share Duration In Seconds")) / 3600, 2),
                "callCount": int(num(row.get("Call Count"))),
                "meetingCount": int(num(row.get("Meeting Count") or row.get("Meetings Attended Count"))),
                "messagesCount": int(num(row.get("Team Chat Message Count"))) + int(num(row.get("Private Chat Message Count"))),
                "teamMessages": int(num(row.get("Team Chat Message Count"))),
                "privateMessages": int(num(row.get("Private Chat Message Count"))),
            }
            if local:
                result[local] = entry
            if display:
                result[f"name:{normalize_name(display)}"] = entry
    except Exception as exc:
        print(f"WARNING: Teams activity CSV parse failed: {exc}", file=sys.stderr)
    print(f"Teams activity report loaded: {len([k for k in result if not k.startswith('name:')])} users")
    return result


def load_github_contributions() -> dict:
    """Load github-data.json and return dict keyed by normalized name/login."""
    if not GITHUB_DATA_FILE.exists():
        print("WARNING: github-data.json not found, GitHub contributions skipped", file=sys.stderr)
        return {}
    try:
        data = json.loads(GITHUB_DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"WARNING: github-data.json unreadable: {exc}", file=sys.stderr)
        return {}

    result = {}
    for contrib in data.get("contributors", []):
        login = clean(contrib.get("login", ""))
        if not login:
            continue
        score = int(contrib.get("commits", 0)) + int(contrib.get("prs", 0)) * 2 + int(contrib.get("done", 0))
        entry = {
            "login": login,
            "commits": contrib.get("commits", 0),
            "prs": contrib.get("prs", 0),
            "done": contrib.get("done", 0),
            "total": contrib.get("total", 0),
            "contributionScore": score,
        }
        result[normalize_name(login)] = entry
    print(f"GitHub contributions loaded: {len(result)} contributors")
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


def previous_full_month_range(reference=None):
    reference = reference or datetime.now()
    first_this_month = reference.replace(day=1)
    last_previous_month = first_this_month - timedelta(days=1)
    start = last_previous_month.replace(day=1).strftime("%Y-%m-%d")
    end = last_previous_month.strftime("%Y-%m-%d")
    return start, end


def resolve_greythr_date_range(target_period: str):
    start = ""
    end = ""
    args = sys.argv[1:]
    for idx, arg in enumerate(args):
        if arg == "--greythr-start" and idx + 1 < len(args):
            start = clean(args[idx + 1])
        elif arg.startswith("--greythr-start="):
            start = clean(arg.split("=", 1)[1])
        elif arg == "--greythr-end" and idx + 1 < len(args):
            end = clean(args[idx + 1])
        elif arg.startswith("--greythr-end="):
            end = clean(arg.split("=", 1)[1])
    if start and end:
        return start, end

    if any(arg == "--month" or arg.startswith("--month=") for arg in args):
        start, end = period_to_date_range(target_period)
        if start and end:
            return start, end

    start = clean(os.environ.get("GREYTHR_START_DATE"))
    end = clean(os.environ.get("GREYTHR_END_DATE"))
    if start and end:
        return start, end

    start, end = period_to_date_range(target_period)
    if start and end:
        return start, end

    return previous_full_month_range()


def read_greythr_api(start: str, end: str) -> tuple[defaultdict, dict, dict]:
    """Returns (attendance_counters, master_data, dept_details).
    master_data: {employeeId: {employee_no, name, date_of_joining, employment_type, probation_end}}
    dept_details: {employeeId: {designation, department}} from GreytHR reporting hierarchy
    """
    result = defaultdict(lambda: Counter())
    master = {}
    dept_details: dict = {}
    if not start or not end:
        print("WARNING: GreytHR skipped — could not determine date range", file=sys.stderr)
        return result, master, dept_details
    try:
        raw, master, dept_details = get_greythr_attendance(start, end)
        for emp_no, counter in raw.items():
            result[emp_no] = counter
        print(f"GreytHR attendance loaded: {len(raw)} employees ({start} to {end}), {len(dept_details)} with designations")
    except (GreytHRConfigError, GreytHRAuthError, GreytHRApiError) as exc:
        print(f"WARNING: GreytHR attendance skipped: {exc}", file=sys.stderr)
    return result, master, dept_details


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
    requested_month = ""
    args = sys.argv[1:]
    out_path = OUT  # default output path; overridden by --out
    for idx, arg in enumerate(args):
        if arg == "--month" and idx + 1 < len(args):
            requested_month = clean(args[idx + 1])
        elif arg.startswith("--month="):
            requested_month = clean(arg.split("=", 1)[1])
        elif arg == "--out" and idx + 1 < len(args):
            out_path = Path(args[idx + 1])
        elif arg.startswith("--out="):
            out_path = Path(arg.split("=", 1)[1])
    if requested_month and not re.fullmatch(r"\d{4}-\d{2}", requested_month):
        raise ValueError("--month must use YYYY-MM format")
    target_period = requested_month or (month_counts.most_common(1)[0][0] if month_counts else "")
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
            "email": clean(user.get("email") or user.get("mail") or ""),
            "designation": clean(user.get("designation")) or "Unassigned",
            "team": standardize_team(user.get("team")),
            "active": clean(user.get("is_active")).lower() == "true",
            "teamsId": clean(user.get("ms_teams_id")),
            "sourceKeys": {
                "worklogix": emp_id,
                "greythr": clean(user.get("employee_no")) or clean(user.get("employeeNo")) or emp_id,
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

    greythr_start, greythr_end = resolve_greythr_date_range(target_period)
    greythr, greythr_master, greythr_dept = read_greythr_api(greythr_start, greythr_end)
    # Build name-keyed lookup for joining date matching (CWINE employees only)
    greythr_master_by_name = {
        normalize_name(info.get("name", "")): info
        for info in greythr_master.values()
        if info.get("name")
    }
    teams = read_teams_api(users)

    # Apply designation overrides after all API calls:
    # 1. Teams jobTitle (read_teams_api may have updated users[emp_id]["designation"])
    # 2. GreytHR designation takes final priority (HR system of record)
    for emp_id, emp in employees.items():
        user = users.get(emp_id, {})
        teams_desig = clean(user.get("designation"))
        if teams_desig:
            emp["designation"] = teams_desig
        gt_info = greythr_dept.get(emp_id) or greythr_dept.get(emp.get("sourceKeys", {}).get("greythr", ""))
        gt_desig = clean((gt_info or {}).get("designation"))
        if gt_desig:
            emp["designation"] = gt_desig
    presence_month = to_presence_month_label(target_period) or to_presence_month_label(greythr_start)
    attendance = read_biometric_api(presence_month)
    teams_activity = read_teams_activity_report()
    github_contributions = load_github_contributions()

    def greythr_for_employee(emp_id, emp):
        keys = [
            emp_id,
            emp.get("sourceKeys", {}).get("greythr", ""),
            emp.get("sourceKeys", {}).get("biometric", ""),
            f"name:{normalize_name(emp.get('name'))}",
        ]
        return next((greythr[key] for key in keys if key and greythr.get(key)), Counter())

    # Build per-project and per-project-per-member task stats from daily rows.
    project_task_stats = defaultdict(lambda: {"total": 0, "completed": 0, "approved": 0, "hoursWorked": 0.0})
    project_member_stats = defaultdict(lambda: defaultdict(lambda: {"total": 0, "completed": 0, "hoursWorked": 0.0}))
    for row in daily:
        proj_id = clean(row.get("project_id"))
        emp_id = clean(row.get("employee_id"))
        if not proj_id:
            continue
        ps = project_task_stats[proj_id]
        ps["total"] += 1
        if clean(row.get("status", "")).lower() == "completed":
            ps["completed"] += 1
        if clean(row.get("approval_status", "")).lower() == "approved":
            ps["approved"] += 1
        working_hours_raw = row.get("working_hours")
        task_hours = 0.0
        if isinstance(working_hours_raw, (int, float)):
            task_hours = num(working_hours_raw)
        else:
            parsed = parse_jsonish(working_hours_raw, {})
            if isinstance(parsed, dict):
                task_hours = sum(num(d.get("hours") if isinstance(d, dict) else d) for d in parsed.values())
            elif isinstance(parsed, (int, float)):
                task_hours = num(parsed)
        ps["hoursWorked"] += task_hours
        if emp_id and emp_id in allowed_employee_ids:
            ms = project_member_stats[proj_id][emp_id]
            ms["total"] += 1
            if clean(row.get("status", "")).lower() == "completed":
                ms["completed"] += 1
            ms["hoursWorked"] += task_hours

    # Build PM → project completion stats from tasks in the target month.
    # project_manager_map: project_id → manager employee_id (from Worklogix managed_by field)
    project_manager_map = {
        clean(p.get("id")): clean(p.get("managed_by"))
        for p in projects
        if clean(p.get("id")) and clean(p.get("managed_by"))
    }
    pm_project_stats = defaultdict(lambda: {"total": 0, "completed": 0, "approved": 0, "onTime": 0, "hasDueDates": False})
    # Task Approval Speed (Management KPI, 10%): how quickly each manager reviews/approves
    # tasks submitted by their team, bucketed per the framework's turnaround table.
    pm_approval_scores = defaultdict(list)
    for row in daily:
        proj_id = clean(row.get("project_id"))
        pm_id = project_manager_map.get(proj_id)
        if not pm_id or pm_id not in allowed_employee_ids:
            continue
        ps = pm_project_stats[pm_id]
        ps["total"] += 1
        is_completed = clean(row.get("status", "")).lower() == "completed"
        if is_completed:
            ps["completed"] += 1
        is_approved = clean(row.get("approval_status", "")).lower() == "approved"
        if is_approved:
            ps["approved"] += 1
            approval_score = approval_turnaround_score(row.get("created_at"), row.get("updated_at"))
            if approval_score is not None:
                pm_approval_scores[pm_id].append(approval_score)
        # Project Delivery (Management KPI, 25%): "Projects Delivered On Time / Projects
        # Assigned" — evaluated at task granularity since projects have no due date field,
        # only individual tasks do. Falls back to plain completion rate for managers whose
        # projects have no due-date data at all, so on-time tracking never unfairly zeroes them out.
        due_date = clean(row.get("due_date"))
        completion_date = clean(row.get("completion_date"))
        if due_date and completion_date:
            ps["hasDueDates"] = True
            due_dt = pd.to_datetime(due_date, errors="coerce")
            completed_dt = pd.to_datetime(completion_date, errors="coerce")
            if is_completed and pd.notna(due_dt) and pd.notna(completed_dt) and completed_dt <= due_dt:
                ps["onTime"] += 1

    # Build employee id → name map for PM name lookup in project cards.
    emp_id_to_name = {
        emp_id: clean(u.get("name"))
        for emp_id, u in users.items()
        if emp_id and clean(u.get("name"))
    }

    project_cards = []
    for row in projects:
        members = parse_jsonish(row.get("project_member"), [])
        active_members = [
            m for m in members
            if isinstance(m, dict) and clean(m.get("user_id")) in allowed_employee_ids
        ] if isinstance(members, list) else []
        if not active_members:
            continue
        proj_id = clean(row.get("id"))
        ps = project_task_stats.get(proj_id, {})
        pm_emp_id = project_manager_map.get(proj_id)
        member_rows = project_member_stats.get(proj_id, {})
        # Include ALL active members — default to 0 for those who haven't logged tasks.
        # Without this, managers can't see which assigned members are inactive.
        all_member_ids = [clean(m.get("user_id")) for m in active_members if isinstance(m, dict) and clean(m.get("user_id"))]
        member_stats_list = sorted(
            [
                {
                    "id": mid,
                    "name": emp_id_to_name.get(mid, mid),
                    "tasksTotal": member_rows[mid]["total"] if mid in member_rows else 0,
                    "tasksCompleted": member_rows[mid]["completed"] if mid in member_rows else 0,
                    "hoursWorked": round(member_rows[mid]["hoursWorked"], 1) if mid in member_rows else 0.0,
                }
                for mid in all_member_ids
            ],
            key=lambda x: -x["tasksTotal"],
        )
        project_cards.append({
            "id": proj_id,
            "name": clean(row.get("name")),
            "status": clean(row.get("status")),
            "members": len(active_members),
            "estimatedHours": round(sum(num(m.get("hours_estimated")) for m in active_members), 1),
            "hoursWorked": round(ps.get("hoursWorked", 0.0), 1),
            "tasksTotal": ps.get("total", 0),
            "tasksCompleted": ps.get("completed", 0),
            "tasksApproved": ps.get("approved", 0),
            "manager": emp_id_to_name.get(pm_emp_id, "") if pm_emp_id else "",
            "memberStats": member_stats_list,
        })

    def get_teams_activity_for(emp):
        local = email_local(emp.get("email", ""))
        if local and local in teams_activity:
            return teams_activity[local]
        name_key = f"name:{normalize_name(emp.get('name', ''))}"
        return teams_activity.get(name_key)

    def get_github_for(emp):
        # Direct lookup (works if login == normalize_name(emp name))
        norm = normalize_name(emp.get("name", ""))
        if norm in github_contributions:
            return github_contributions[norm]
        name_lower = (emp.get("name", "") or "").lower()
        name_words = re.sub(r"[^a-z ]", "", name_lower).split()
        for entry in github_contributions.values():
            login = entry.get("login", "")
            login_stripped = re.sub(r"[0-9]", "", login.lower())
            # All-parts match: split on hyphens/underscores, every part >=4 chars in name
            parts = [p for p in re.split(r"[-_]", login_stripped) if len(p) >= 4]
            if parts and all(p in name_lower for p in parts):
                return entry
            # Prefix fallback: any name word >=5 chars is a prefix of (or matches start of) the login
            login_flat = login_stripped.replace("-", "").replace("_", "")
            if any(len(w) >= 5 and (login_flat.startswith(w) or w.startswith(login_flat)) for w in name_words):
                return entry
        return None

    work_scores = [e.get("worklogixScore", {}).get("final", 0) for e in employees.values()]
    team_active = [teams[eid]["isActive"] for eid in employees if teams[eid]]
    office_hours = [attendance[eid]["officeHours"] for eid in employees if attendance[eid]]
    work_item_counts = [work_item_stats[eid]["workItems"] for eid in employees if work_item_stats[eid]]
    absence_counts = [
        greythr_for_employee(eid, emp)["A"]
        for eid, emp in employees.items()
        if greythr_for_employee(eid, emp)
    ]
    efficiency_hours_map = {
        eid: (attendance.get(eid, Counter())["officeHours"] or work_item_stats[eid]["workHours"])
        for eid in employees
        if work_item_stats[eid]["workItems"]
    }
    all_efficiencies = [
        work_item_stats[eid]["weightedPointsCompleted"] / max(1, efficiency_hours_map[eid])
        for eid in efficiency_hours_map
    ]
    # Punctuality: avg daily office hours as proxy when check-in time is unavailable
    avg_office_hours_list = [
        attendance[eid]["officeHours"] / max(1, attendance[eid]["validOfficeDays"])
        for eid in employees
        if attendance[eid]["validOfficeDays"]
    ]
    # Collaboration: messages + meeting count weighted signal
    all_collab_signals = [
        ta["messagesCount"] + ta["meetingCount"] * 2
        for emp in employees.values()
        for ta in [get_teams_activity_for(emp)]
        if ta
    ] or [0, 1]
    # Meeting Score sub-component of Teams Collaboration: raw meeting counts for minmax normalisation
    all_meeting_counts = [
        ta["meetingCount"]
        for emp in employees.values()
        for ta in [get_teams_activity_for(emp)]
        if ta
    ] or [0, 1]
    # GitHub: raw contribution scores for minmax normalisation
    all_github_scores = [
        gc["contributionScore"]
        for emp in employees.values()
        for gc in [get_github_for(emp)]
        if gc
    ] or [0, 1]

    employee_rows = []
    for emp_id, emp in employees.items():
        stats = work_item_stats[emp_id]
        gh = greythr_for_employee(emp_id, emp)
        _wl_uid = clean(emp.get("user_id", ""))
        bio = attendance.get(emp_id) or attendance.get(_wl_uid) or attendance.get(f"name:{normalize_name(emp.get('name',''))}") or Counter()
        present_days = bio["biometricDays"] or gh["P"]
        tm = teams[emp_id]
        monthly_final = emp.get("worklogixScore", {}).get("final", 0)
        efficiency_hours = efficiency_hours_map.get(emp_id, stats["workHours"])
        raw_efficiency = stats["weightedPointsCompleted"] / max(1, efficiency_hours)
        efficiency_driver = minmax(raw_efficiency, all_efficiencies) if stats["workItems"] else 50
        if monthly_final:
            worklogix_score = monthly_final
            has_real_worklogix = True
        elif stats["workItems"]:
            weighted_completion_rate = stats["weightedPointsCompleted"] / max(1, stats["totalWeightedPoints"])
            approval_rate = stats["approval:approved"] / max(1, stats["workItems"])
            efficiency_signal = efficiency_driver / 100
            worklogix_score = (weighted_completion_rate * 55 + approval_rate * 25 + efficiency_signal * 20)
            has_real_worklogix = True
        else:
            worklogix_score = 50
            has_real_worklogix = False
        attendance_score = 100 - minmax(gh["A"], absence_counts, invert=False) if gh else minmax(bio["officeHours"], office_hours)
        _wl_completion = emp.get("worklogixScore", {}).get("completion")
        if _wl_completion:
            task_completion_score = _wl_completion
        elif stats["workItems"]:
            task_completion_score = stats["status:Completed"] / max(1, stats["workItems"]) * 100
        else:
            task_completion_score = None  # no Worklogix data — excluded from formula

        # Punctuality: use biometric check-in data if available, else avg office hours proxy
        punct_raw = bio.get("punctualityScore")
        if punct_raw is not None:
            punctuality_score = punct_raw
        elif bio["validOfficeDays"]:
            avg_hrs = bio["officeHours"] / bio["validOfficeDays"]
            punctuality_score = minmax(avg_hrs, avg_office_hours_list) if avg_office_hours_list else 50
        else:
            punctuality_score = 50

        # Collaboration: Teams activity messages + meetings if available.
        # No match = no paid license (personal Teams) → neutral 50, not penalised.
        # The old presence (isActive) fallback gave 0 for offline users, which
        # incorrectly pushed support/management staff into Disengaged.
        ta = get_teams_activity_for(emp)
        if ta:
            collab_signal = ta["messagesCount"] + ta["meetingCount"] * 2
            collaboration_score = minmax(collab_signal, all_collab_signals)
        else:
            collaboration_score = 50

        # GitHub contribution
        gc = get_github_for(emp)
        github_score = minmax(gc["contributionScore"], all_github_scores) if gc else 0

        sources = {
            "worklogix": emp_id in allowed_employee_ids,
            "worklogixActivity": has_real_worklogix,
            "greythr": bool(gh),
            "biometrics": bool(attendance.get(emp_id) or attendance.get(_wl_uid) or attendance.get(f"name:{normalize_name(emp.get('name',''))}")),
            "teams": bool(tm),
            "github": gc is not None,
        }
        role_cat = get_role_category(emp.get("designation", ""))
        in_worklogix = emp_id in allowed_employee_ids
        # Confidence uses only the 4 core sources — worklogixActivity and github
        # are informational tags and must NOT dilute the confidence score.
        core_sources = {k: sources[k] for k in ("worklogix", "greythr", "biometrics", "teams")}
        if role_cat == "technical" or in_worklogix:
            relevant = core_sources
        else:
            relevant = {k: v for k, v in core_sources.items() if k != "worklogix"}
        source_confidence = round(sum(relevant.values()) / len(relevant) * 100)
        # gh is truthy even when all entries are "Blank" (no real record).
        # Require at least one meaningful status (P/A/OFF/H/Leave) to count as real data.
        # validOfficeDays comes from Teams online presence — not physical attendance.
        # Only biometricDays (actual swipe) counts as confirmed physical presence.
        gh_has_real_data = bool(gh) and (gh["P"] + gh["A"] + gh["OFF"] + gh["H"] + gh["Leave"]) > 0
        has_attendance_data = gh_has_real_data or bio["biometricDays"] > 0
        # --- KPI Calculation Framework: category-specific formulas ---
        # Attendance / Punctuality / Collaboration are computed the same way for every
        # category (they share identical formulas in the framework); only the weights
        # and the extra category-specific sub-metrics differ below.
        attendance_pct = compute_attendance_pct(gh, bio, attendance_score)
        punctuality_pct = compute_punctuality_pct(bio, punctuality_score)
        teams_collab_pct = compute_collaboration_pct(bio, ta, all_meeting_counts, collaboration_score)
        assigned_tasks = stats["workItems"]
        completed_tasks = stats["status:Completed"]
        approved_tasks = stats["approval:approved"]
        task_completion_pct = (
            round(min(100.0, completed_tasks / assigned_tasks * 100), 1) if assigned_tasks else None
        )

        pm_project_score = None
        productivity_score = None
        code_contribution_score = None
        project_delivery_score = None
        task_approval_speed_score = None
        kpi = None
        band = ""
        weights_used = {}
        insufficient_reason = None
        if role_cat == "executive":
            band = "Executive"
        elif not has_attendance_data:
            # No GreytHR or biometric record — attendance would default to 0,
            # making the KPI unfairly low. Flag as Insufficient Data instead.
            band = "Insufficient Data"
            insufficient_reason = "no-attendance"
        elif source_confidence >= 50:
            has_github = gc is not None

            if role_cat == "management":
                # Management KPI = Team Avg KPI 35% + Project Delivery 25% + Approval Speed 10%
                #                 + Attendance 10% + Punctuality 5% + Collaboration 10% + Planner Completion 5%
                # Team Average KPI needs every other employee's KPI, so it's filled in
                # during the post-loop pass below; here we score everything else and
                # redistribute its 35% weight for a preliminary value.
                ps = pm_project_stats.get(emp_id)
                if ps and ps["total"] > 0:
                    project_delivery_score = round(
                        min(100.0, (ps["onTime"] if ps["hasDueDates"] else ps["completed"]) / ps["total"] * 100), 1
                    )
                approval_scores = pm_approval_scores.get(emp_id)
                task_approval_speed_score = round(statistics.mean(approval_scores), 1) if approval_scores else None
                pm_project_score = project_delivery_score  # kept for the executive/UI "project performance" driver
                kpi, weights_used = weighted_score([
                    ("projectDelivery", project_delivery_score, 25),
                    ("taskApprovalSpeed", task_approval_speed_score, 10),
                    ("attendance", attendance_pct, 10),
                    ("punctuality", punctuality_pct, 5),
                    ("collaboration", teams_collab_pct, 10),
                    ("plannerCompletion", task_completion_pct, 5),
                ])
            elif role_cat == "intern":
                # Intern KPI = Task Completion 30% + Punctuality 20% + Collaboration 20% + Mentor Feedback 30%.
                # Mentor Feedback isn't collected anywhere in this pipeline — its weight is redistributed.
                kpi, weights_used = weighted_score([
                    ("taskCompletion", task_completion_pct, 30),
                    ("punctuality", punctuality_pct, 20),
                    ("collaboration", teams_collab_pct, 20),
                    ("mentorFeedback", None, 30),
                ])
            elif role_cat == "support":
                # Support KPI = Attendance 25% + Punctuality 15% + Collaboration 20%
                #             + Task Completion 30% + Manager Ratings 10%.
                # Manager Ratings isn't collected anywhere in this pipeline — its weight is redistributed.
                kpi, weights_used = weighted_score([
                    ("attendance", attendance_pct, 25),
                    ("punctuality", punctuality_pct, 15),
                    ("collaboration", teams_collab_pct, 20),
                    ("taskCompletion", task_completion_pct, 30),
                    ("managerRatings", None, 10),
                ])
            else:
                # Technical KPI = Productivity 55% + Code Contribution 5% + Attendance 15%
                #               + Punctuality 15% + Teams Collaboration 10%.
                # Productivity = Task Completion Efficiency 60% + Approval Rate 15% + Work Efficiency 25%.
                if task_completion_pct is not None:
                    approval_rate = round(min(100.0, approved_tasks / completed_tasks * 100), 1) if completed_tasks else 0.0
                    productivity_score = round(
                        task_completion_pct * 0.60 + approval_rate * 0.15 + efficiency_driver * 0.25, 1
                    )
                code_contribution_score = round(github_score, 1) if has_github else None
                kpi, weights_used = weighted_score([
                    ("productivity", productivity_score, 55),
                    ("codeContribution", code_contribution_score, 5),
                    ("attendance", attendance_pct, 15),
                    ("punctuality", punctuality_pct, 15),
                    ("collaboration", teams_collab_pct, 10),
                ])

            if kpi is not None:
                band = band_for_kpi(kpi)
            else:
                band = "Insufficient Data"
                insufficient_reason = "no-scoreable-metrics"

        # Quadrant: 2D grid of productivity vs attendance
        # Executives are excluded; management/support/intern use collaboration as productivity proxy
        if role_cat in ("management", "support", "intern"):
            prod_high = collaboration_score >= 60
        else:
            prod_high = worklogix_score >= 60
        att_high = attendance_score >= 60
        quadrant = quadrant_for(prod_high, att_high) if kpi is not None else ""

        score_drivers = {
            "productivity": round(productivity_score, 1) if productivity_score is not None else None,
            "codeContribution": code_contribution_score,
            "attendance": round(attendance_pct, 1),
            "taskCompletion": task_completion_pct,
            "punctuality": round(punctuality_pct, 1),
            "collaboration": round(teams_collab_pct, 1),
            "github": round(github_score, 1),
            "projectDelivery": project_delivery_score,
            "taskApprovalSpeed": task_approval_speed_score,
            "plannerCompletion": task_completion_pct if role_cat == "management" else None,
            "managerRatings": None,
            "mentorFeedback": None,
            "pmProjectScore": round(pm_project_score, 1) if pm_project_score is not None else None,
        }
        gap_analysis = build_gap_analysis(
            sources, source_confidence,
            {k: v for k, v in score_drivers.items() if isinstance(v, (int, float))},
            kpi,
        )
        employee_rows.append({
            **emp,
            "kpi": kpi,
            "band": band,
            "quadrant": quadrant,
            "roleCategory": role_cat,
            # Diagnostic only — NOT nested in scoreDrivers, which the dashboard renders
            # generically as a list of 0-100 percentage bars (a dict value would break that).
            "weightsApplied": weights_used,
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
                # GreytHR half-session totals always equal the calendar days in the period.
                # Use this as a hard cap so biometric rows leaked from adjacent months
                # (e.g. validOfficeDays=33 in a 30-day June) are trimmed.
                **( lambda c: {
                    "present": min(present_days, c) if c else present_days,
                    "absent": gh["A"],
                    "off": gh["OFF"],
                    "holidays": gh["H"],
                    "leave": gh["Leave"],
                    "blank": gh["Blank"],
                    "calendarDays": c,
                    "biometricDays": min(bio["biometricDays"], c) if c else bio["biometricDays"],
                    "validOfficeDays": min(bio["validOfficeDays"], c) if c else bio["validOfficeDays"],
                    "officeHours": round(bio["officeHours"], 1),
                    "avgOfficeHours": round(
                        bio["officeHours"] / max(1, min(bio["validOfficeDays"], c) if c else bio["validOfficeDays"]), 1
                    ),
                })(round(gh["P"] + gh["A"] + gh["OFF"] + gh["H"] + gh["Leave"] + gh["Blank"]) if gh else 0),
                "avgCheckinHour": bio.get("avgCheckinHour"),
                "avgCheckoutHour": bio.get("avgCheckoutHour"),
                "officeLocation": bio.get("officeLocation", ""),
                "punctualityScore": bio.get("punctualityScore"),
                "teamsAvailableHours": round(bio.get("teamsAvailableHours", bio["officeHours"]), 1),
                "teamsAwayHours": round(bio.get("teamsAwayHours", 0), 1),
                "teamsOfflineHours": round(bio.get("teamsOfflineHours", 0), 1),
            },
            "teams": {
                "status": tm.get("status", ""),
                "workLocation": tm.get("workLocation", ""),
                "isActive": tm["isActive"],
                "isAway": tm["isAway"],
                "isOffline": tm["isOffline"],
                "isOutOfOffice": tm["isOutOfOffice"],
                "reports": tm["reports"],
                "activityMatched": ta is not None,
                "meetingHours": ta["meetingHours"] if ta else 0,
                "videoCallHours": ta["videoCallHours"] if ta else 0,
                "screenShareHours": ta["screenShareHours"] if ta else 0,
                "callCount": ta["callCount"] if ta else 0,
                "meetingCount": ta["meetingCount"] if ta else 0,
                "messagesCount": ta["messagesCount"] if ta else 0,
                "teamMessages": ta["teamMessages"] if ta else 0,
                "privateMessages": ta["privateMessages"] if ta else 0,
            },
            "github": {
                "login": gc["login"],
                "commits": gc["commits"],
                "prs": gc["prs"],
                "done": gc["done"],
                "total": gc["total"],
                "contributionScore": gc["contributionScore"],
            } if gc else None,
            "scoreDrivers": score_drivers,
            "missingSources": gap_analysis["missingSources"],
            "laggingDrivers": gap_analysis["laggingDrivers"],
            "gapReason": gap_analysis["gapReason"],
            "insufficientReason": insufficient_reason,
            **({
                "dateOfJoining": gm["date_of_joining"],
                "employmentType": gm["employment_type"],
            } if (gm := greythr_master_by_name.get(normalize_name(emp.get("name", "")))) else {}),
        })

    # --- Executive KPI: average KPI of direct reportees (from Teams org chart) ---
    try:
        teams_org_users = get_teams_users_with_manager()
        # Build Teams user ID → our employee ID (primary: teamsId match)
        teams_id_to_emp_id = {
            emp["teamsId"].lower(): eid
            for eid, emp in employees.items()
            if emp.get("teamsId")
        }
        # Fallback: for employees with no teamsId, match by name prefix
        # e.g. Worklogix "Christy" matches Teams "Christy Arulraj"
        emp_norm_name_to_id = {
            normalize_name(emp.get("name", "")): eid
            for eid, emp in employees.items()
            if not emp.get("teamsId")
        }
        def resolve_emp_id(teams_user: dict) -> str | None:
            tid = teams_user.get("id", "").lower()
            if tid in teams_id_to_emp_id:
                return teams_id_to_emp_id[tid]
            # Name-based fallback: check if any no-teamsId employee name
            # is a prefix of this Teams user's displayName
            t_norm = normalize_name(teams_user.get("displayName", ""))
            for norm_name, eid in emp_norm_name_to_id.items():
                if norm_name and t_norm.startswith(norm_name):
                    return eid
            return None

        # Build manager employee ID → list of reportee employee IDs
        mgr_to_reportees = defaultdict(list)
        for u in teams_org_users:
            if not u.get("manager"):
                continue
            reportee_emp_id = resolve_emp_id(u)
            mgr_emp_id = resolve_emp_id(u["manager"])
            if reportee_emp_id and mgr_emp_id:
                mgr_to_reportees[mgr_emp_id].append(reportee_emp_id)
        # Build emp_id → kpi from already-computed rows
        emp_id_to_kpi = {
            row["id"]: row["kpi"]
            for row in employee_rows
            if row.get("kpi") is not None
        }
        # Update executive rows with their team's average KPI.
        # band stays "Executive" — we never show Critical/Good for a CEO.
        # teamAvgKpi is stored as a driver and shown separately in the detail view.
        for row in employee_rows:
            if row.get("roleCategory") != "executive":
                continue
            reportee_ids = mgr_to_reportees.get(row["id"], [])
            scored_kpis = [emp_id_to_kpi[rid] for rid in reportee_ids if rid in emp_id_to_kpi]
            if scored_kpis:
                team_avg = round(sum(scored_kpis) / len(scored_kpis), 1)
                row["scoreDrivers"]["teamAvgKpi"] = team_avg
                row["scoreDrivers"]["reporteeCount"] = len(scored_kpis)
            # kpi stays None, band stays "Executive"

        # Management KPI, pass 2: Team Average KPI (35%) is the average of every direct
        # report's KPI, which is only known once every employee has been scored above.
        # Recompute each manager's KPI now that it's available, using the same
        # weighted_score redistribution rule for whichever components (Project
        # Delivery, Task Approval Speed, Team Avg KPI itself) don't apply to them.
        for row in employee_rows:
            if row.get("roleCategory") != "management":
                continue
            reportee_ids = list(dict.fromkeys(mgr_to_reportees.get(row["id"], [])))
            scored_kpis = [emp_id_to_kpi[rid] for rid in reportee_ids if rid in emp_id_to_kpi]
            team_avg_kpi = round(sum(scored_kpis) / len(scored_kpis), 1) if scored_kpis else None
            sd = row["scoreDrivers"]
            new_kpi, weights_used = weighted_score([
                ("teamAverageKpi", team_avg_kpi, 35),
                ("projectDelivery", sd.get("projectDelivery"), 25),
                ("taskApprovalSpeed", sd.get("taskApprovalSpeed"), 10),
                ("attendance", sd.get("attendance"), 10),
                ("punctuality", sd.get("punctuality"), 5),
                ("collaboration", sd.get("collaboration"), 10),
                ("plannerCompletion", sd.get("plannerCompletion"), 5),
            ])
            if team_avg_kpi is not None:
                sd["teamAvgKpi"] = team_avg_kpi
                sd["reporteeCount"] = len(scored_kpis)
            if new_kpi is None:
                continue
            row["kpi"] = new_kpi
            row["scoreDrivers"]["pmProjectScore"] = sd.get("projectDelivery")
            row["weightsApplied"] = weights_used
            row["band"] = band_for_kpi(new_kpi)
            col = sd.get("collaboration") or 0
            att = sd.get("attendance") or 0
            row["quadrant"] = quadrant_for(col >= 60, att >= 60)

        # Build reverse map: employee ID → manager employee ID
        emp_id_to_manager_id = {}
        for u in teams_org_users:
            if not u.get("manager"):
                continue
            reportee_emp_id = resolve_emp_id(u)
            mgr_emp_id = resolve_emp_id(u["manager"])
            if reportee_emp_id and mgr_emp_id:
                emp_id_to_manager_id[reportee_emp_id] = mgr_emp_id

        # Build quick lookup: emp_id → row (for name/band/kpi in directReports)
        id_to_row = {row["id"]: row for row in employee_rows}

        # Stamp managerName and directReports onto every employee row
        for row in employee_rows:
            eid = row["id"]
            mgr_id = emp_id_to_manager_id.get(eid)
            if mgr_id and mgr_id in id_to_row:
                row["managerId"]   = mgr_id
                row["managerName"] = id_to_row[mgr_id]["name"]
            else:
                row["managerId"]   = None
                row["managerName"] = None
            reportee_ids = list(dict.fromkeys(mgr_to_reportees.get(eid, [])))  # deduplicate, preserve order
            row["directReports"] = [
                {
                    "id":   rid,
                    "name": id_to_row[rid]["name"],
                    "band": id_to_row[rid].get("band", ""),
                    "kpi":  id_to_row[rid].get("kpi"),
                    "designation": id_to_row[rid].get("designation", ""),
                }
                for rid in reportee_ids
                if rid in id_to_row
            ]

    except (TeamsApiError, TeamsAuthError) as exc:
        print(f"WARNING: Executive team KPI skipped: {exc}", file=sys.stderr)

    employee_rows.sort(key=lambda item: item["kpi"] if item["kpi"] is not None else -1, reverse=True)

    # Preserve per-employee graph data (Planner/Calendar/SharePoint) from the last graph refresh
    graph_data_file = PROJECT / "data" / "graph-activity.json"
    if graph_data_file.exists():
        try:
            graph_data = json.loads(graph_data_file.read_text(encoding="utf-8"))
            graph_by_id = {
                clean(ge.get("id")): ge
                for ge in graph_data.get("employees", [])
                if clean(ge.get("id"))
            }
            for emp in employee_rows:
                ge = graph_by_id.get(clean(emp.get("id")))
                if ge:
                    emp["graphActivity"] = {
                        k: ge[k]
                        for k in ("matched", "userId", "email", "planner", "calendar", "sharePoint")
                        if k in ge
                    }
        except Exception as exc:
            print(f"WARNING: graph-activity.json merge skipped: {exc}", file=sys.stderr)

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
            "period": f"{greythr_start} to {greythr_end}",
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "dataMode": "Worklogix API + GreytHR API + Biometrics API + Teams API + GitHub",
            "sourceFiles": {
                "worklogix": "api",
                "greythr": "api",
                "biometrics": "api",
                "teams": "api",
                "github": "file",
            },
            "weights": {
                "productivity": 55,
                "attendance": 15,
                "punctuality": 15,
                "collaboration": 10,
                "githubContribution": 5,
            },
            "kpiFramework": {
                "technical": {
                    "productivity": 55, "codeContribution": 5, "attendance": 15,
                    "punctuality": 15, "collaboration": 10,
                },
                "support": {
                    "attendance": 25, "punctuality": 15, "collaboration": 20,
                    "taskCompletion": 30, "managerRatings": 10,
                },
                "management": {
                    "teamAverageKpi": 35, "projectDelivery": 25, "taskApprovalSpeed": 10,
                    "attendance": 10, "punctuality": 5, "collaboration": 10, "plannerCompletion": 5,
                },
                "intern": {
                    "taskCompletion": 30, "punctuality": 20, "collaboration": 20, "mentorFeedback": 30,
                },
                "note": (
                    "Weights shown are the framework's target weights. managerRatings, "
                    "taskApprovalSpeed (when timestamps are unavailable), and mentorFeedback "
                    "have no data source in this pipeline; their weight is redistributed "
                    "proportionally across the other components for each affected employee "
                    "— see scoreDrivers.weightsApplied per employee for the actual weights used."
                ),
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
            "riskCount": sum(1 for e in scored_rows if e["band"] == "Critical"),
            "watchCount": sum(1 for e in scored_rows if e["band"] == "Needs Improvement"),
            "highPerformerCount": sum(1 for e in scored_rows if e["band"] in ("Excellent", "Good")),
            "ghostWorkerCount": sum(1 for e in scored_rows if e["quadrant"] == "Ghost Worker"),
            "presentIdleCount": sum(1 for e in scored_rows if e["quadrant"] == "Present but Idle"),
            "disengagedCount": sum(1 for e in scored_rows if e["quadrant"] == "Disengaged"),
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
        "employees": [{**e, "team": TEAM_OVERRIDES.get(e["id"], e.get("team", ""))} for e in employee_rows],
        "projects": sorted(project_cards, key=lambda p: (p["members"], p["estimatedHours"]), reverse=True),
        "bands": dict(Counter(e["band"] or "Insufficient Data" for e in employee_rows)),
        "quadrants": dict(Counter(e["quadrant"] for e in employee_rows if e["quadrant"])),
    }
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} with {len(employee_rows)} employees")


if __name__ == "__main__":
    main()
