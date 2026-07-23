from __future__ import annotations

import json
import re
import threading
from pathlib import Path

DATA_FILE        = Path(__file__).resolve().parents[2] / "data" / "peopleops-data.json"
MONTHS_DIR       = Path(__file__).resolve().parents[2] / "data" / "months"
GITHUB_DATA_FILE = Path(__file__).resolve().parents[2] / "data" / "github-data.json"
GRAPH_DATA_FILE  = Path(__file__).resolve().parents[2] / "data" / "graph-activity.json"

# Thread-local storage so concurrent requests each use their own month data
_tl = threading.local()

_PRONOUN_TRIGGERS = ("their", "them", "these people", "those people", "the same")

# Maps lowercase month tokens → (full name, month number)
_MONTH_MAP: dict[str, tuple[str, int]] = {
    "january": ("January", 1),   "jan": ("January", 1),
    "february": ("February", 2), "feb": ("February", 2),
    "march": ("March", 3),       "mar": ("March", 3),
    "april": ("April", 4),       "apr": ("April", 4),
    "may": ("May", 5),
    "june": ("June", 6),         "jun": ("June", 6),
    "july": ("July", 7),         "jul": ("July", 7),
    "august": ("August", 8),     "aug": ("August", 8),
    "september": ("September", 9), "sep": ("September", 9), "sept": ("September", 9),
    "october": ("October", 10),  "oct": ("October", 10),
    "november": ("November", 11),"nov": ("November", 11),
    "december": ("December", 12),"dec": ("December", 12),
}


def _extract_requested_ym(question: str) -> tuple[str, str] | None:
    """Return (YYYY-MM key, 'Month YYYY' display) if a specific month is named in the question."""
    from datetime import datetime
    q = question.lower()
    year_m = re.search(r'\b(20\d{2})\b', q)
    year = int(year_m.group(1)) if year_m else datetime.now().year
    for token, (full_name, month_num) in _MONTH_MAP.items():
        if re.search(r'\b' + re.escape(token) + r'\b', q):
            return f"{year}-{month_num:02d}", f"{full_name} {year}"
    return None


def _extract_requested_period(question: str) -> str | None:
    """Return 'Month YYYY' display string if a month is named — used for mismatch messages."""
    result = _extract_requested_ym(question)
    return result[1] if result else None


def _load() -> dict:
    """Load peopleops data — uses thread-local month override if set by route()."""
    override = getattr(_tl, "month_data", None)
    if override is not None:
        return override
    return json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))


def _available_months() -> list[str]:
    """Return sorted list of available month keys, e.g. ['2026-05', '2026-06']."""
    if not MONTHS_DIR.exists():
        return []
    return sorted([
        p.stem for p in MONTHS_DIR.glob("*.json")
        if re.match(r"^\d{4}-\d{2}$", p.stem)
    ])


def _load_month_file(ym_key: str) -> dict | None:
    """Load data for a specific YYYY-MM key. Returns None if file doesn't exist."""
    path = MONTHS_DIR / f"{ym_key}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return None


def _data_period() -> str:
    """Returns human-readable period string, e.g. 'June 2026'."""
    try:
        meta = _load().get("meta", {})
        period = meta.get("period", "")
        if period:
            start = period.split(" to ")[0].strip()
            from datetime import datetime
            dt = datetime.strptime(start, "%Y-%m-%d")
            return dt.strftime("%B %Y")
    except Exception:
        pass
    return ""


def _load_graph() -> dict:
    if not GRAPH_DATA_FILE.exists():
        return {}
    try:
        return json.loads(GRAPH_DATA_FILE.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return {}


def _query_employee(question: str) -> dict | None:
    q = re.sub(r"[^a-z0-9@.]+", " ", question.lower())
    employees = _load().get("employees", [])
    matches = []
    for employee in employees:
        values = [
            str(employee.get("id", "")).lower(),
            str(employee.get("name", "")).lower(),
            str(employee.get("email", "")).lower(),
            str(employee.get("graphActivity", {}).get("email", "")).lower(),
        ]
        score = 0
        for value in values:
            if value and value in q:
                score = max(score, len(value.split()) + 5)
            else:
                score = max(score, sum(1 for word in value.split() if len(word) > 2 and word in q))
        if score:
            matches.append((score, employee))
    return max(matches, key=lambda item: item[0])[1] if matches else None


def _compact_employee(employee: dict) -> dict:
    planner = employee.get("graphActivity", {}).get("planner", {})
    calendar = employee.get("graphActivity", {}).get("calendar", {})
    return {
        "id": employee.get("id"),
        "name": employee.get("name"),
        "team": employee.get("team"),
        "designation": employee.get("designation"),
        "active": employee.get("active"),
        "kpi": employee.get("kpi"),
        "band": employee.get("band"),
        "sourceConfidence": employee.get("sourceConfidence"),
        "gapReason": employee.get("gapReason", ""),
        "laggingDrivers": employee.get("laggingDrivers", []),
        "scoreDrivers": employee.get("scoreDrivers", {}),
        "worklogix": employee.get("worklogix", {}),
        "attendance": {k: v for k, v in employee.get("attendance", {}).items() if k != "off"},
        "teams": employee.get("teams", {}),
        "planner": {
            "assigned": planner.get("assigned", 0),
            "completed": planner.get("completed", 0),
            "inProgress": planner.get("inProgress", 0),
            "notStarted": planner.get("notStarted", 0),
            "onTimeRate": planner.get("onTimeRate"),
            "overdueOpen": planner.get("overdueOpen", 0),
        },
        "calendar": {
            "events": calendar.get("events", 0),
            "meetingHours": calendar.get("meetingHours", 0),
        },
    }


def _compact_site(site: dict) -> dict:
    return {
        "id": site.get("id"),
        "displayName": site.get("displayName"),
        "webUrl": site.get("webUrl"),
        "owner": site.get("owner"),
        "lastActivity": site.get("lastActivity"),
        "lists": site.get("lists", [])[:8],
        "files": site.get("files", [])[:8],
        "listCount": len(site.get("lists", [])),
        "fileCount": len(site.get("files", [])),
    }


def _safe_calendar_event(event: dict) -> dict:
    return {
        "id": event.get("id"),
        "subject": event.get("subject"),
        "start": event.get("start"),
        "end": event.get("end"),
        "organizer": event.get("organizer"),
        "attendees": event.get("attendees", [])[:5],
        "location": event.get("location"),
        "meetingLink": event.get("meetingLink"),
        "categories": event.get("categories", []),
        "isCancelled": event.get("isCancelled", False),
        "durationMinutes": event.get("durationMinutes"),
        "description": re.sub(
            r"(?im)(passcode|password|meeting id)\s*:\s*[^\r\n]+",
            r"\1: [redacted]",
            str(event.get("description", ""))[:220],
        ),
    }


def _extract_names_from_history(history: list) -> list[str]:
    """Pull employee names from the most recent assistant reply in history."""
    last_reply = ""
    for msg in reversed(history or []):
        if msg.get("role") == "assistant":
            last_reply = msg.get("content", "")
            break
    if not last_reply:
        return []
    # Match "1. Name S — ..." or "1. Name S\n   Team:"
    names = re.findall(
        r'^\d+\.\s+([A-Za-z][^\n—–|/]{2,45}?)(?:\s*—|\s*\n\s+Team:)',
        last_reply,
        re.MULTILINE,
    )
    return [n.strip() for n in names if n.strip()]


def _filter_by_names(employees: list[dict], names: list[str]) -> list[dict]:
    """Return only employees whose name partially matches any name in the list."""
    result = []
    for emp in employees:
        emp_lower = emp.get("name", "").lower()
        for n in names:
            n_lower = n.lower()
            if n_lower in emp_lower or emp_lower in n_lower:
                result.append(emp)
                break
    return result


def _filter_by_team(employees: list[dict], question: str) -> list[dict]:
    """Filter employee list to a specific team if the question names one."""
    q = question.lower()
    team_names = sorted(
        {(e.get("team") or "").strip() for e in employees if e.get("team")},
        key=len,
        reverse=True,
    )
    for team in team_names:
        if team and team.lower() in q:
            return [e for e in employees if (e.get("team") or "").strip().lower() == team.lower()]
    return employees


def get_performance_data(question: str = "", history: list | None = None) -> dict:
    data = _load()
    employees = data.get("employees", [])
    q = question.lower()
    records = [
        {
            "id": e.get("id"),
            "name": e.get("name"),
            "team": e.get("team"),
            "designation": e.get("designation"),
            "kpi": e.get("kpi"),
            "band": e.get("band"),
            "sourceConfidence": e.get("sourceConfidence"),
            "scoreDrivers": e.get("scoreDrivers", {}),
            "gapReason": e.get("gapReason"),
            "laggingDrivers": e.get("laggingDrivers", []),
        }
        for e in employees
    ]
    records = _filter_by_team(records, question)

    # Resolve pronouns from conversation history
    if any(w in q for w in _PRONOUN_TRIGGERS) and history:
        names = _extract_names_from_history(history)
        if names:
            filtered = _filter_by_names(records, names)
            if filtered:
                shown = len(filtered)
                return {
                    "_note": f"Show KPI/performance for ONLY these {shown} employees from the previous reply.",
                    "employees": filtered,
                    "footer": "",
                }

    _LOW_KEYWORDS = ("low perform", "poor perform", "bottom perform", "worst perform",
                     "critical", "needs improvement", "need improvement",
                     "bottom", "worst", "struggling", "underperform")
    _HIGH_KEYWORDS = ("top perform", "best perform", "high perform", "good perform",
                      "top", "best", "highest", "star")
    is_low_question  = any(kw in q for kw in _LOW_KEYWORDS)
    is_high_question = any(kw in q for kw in _HIGH_KEYWORDS)

    if is_low_question:
        # Show Critical + Needs Improvement bands sorted by KPI ascending (worst first)
        low_bands = {"Critical", "Needs Improvement"}
        low_records = [e for e in records if e.get("band") in low_bands]
        if low_records:
            records = low_records
        records.sort(
            key=lambda e: e.get("kpi") if e.get("kpi") is not None else 999
        )
    else:
        # Default: highest KPI first
        records.sort(
            key=lambda e: e.get("kpi") if e.get("kpi") is not None else -1,
            reverse=True,
        )
    requested = re.search(r"\b(?:top|bottom|show)\s+(\d+)\b", q)
    limit = int(requested.group(1)) if requested else 10
    if any(keyword in q for keyword in _SHOW_ALL_KEYWORDS):
        limit = min(len(records), 50)
    selected = records[:max(1, min(limit, 50))]
    return {
        "overview": data.get("overview", {}),
        "_note": f"List only these {len(selected)} performance records.",
        "employees": selected,
        "footer": f"...and {len(records) - len(selected)} more."
        if len(records) > len(selected) else "",
    }


_ATTENDANCE_LIMIT = 10


def get_attendance_data(question: str = "", history: list | None = None) -> dict:
    data = _load()
    q = question.lower()

    employees = [
        {
            "name": e.get("name"),
            "team": e.get("team"),
            "band": e.get("band", ""),
            "present": e.get("attendance", {}).get("present", 0),
            "absent":  e.get("attendance", {}).get("absent", 0),
            "leave":   e.get("attendance", {}).get("leave", 0),
            "biometricDays": e.get("attendance", {}).get("biometricDays", 0),
            "avgOfficeHours": e.get("attendance", {}).get("avgOfficeHours"),
            "punctualityScore": e.get("attendance", {}).get("punctualityScore"),
        }
        for e in data.get("employees", [])
    ]
    employees = _filter_by_team(employees, question)

    # "Show their attendance" — filter to names from previous reply
    if any(w in q for w in _PRONOUN_TRIGGERS) and history:
        names = _extract_names_from_history(history)
        if names:
            filtered = _filter_by_names(employees, names)
            if filtered:
                shown = len(filtered)
                return {
                    "_note": f"List ONLY these {shown} employees — they were mentioned in the previous answer.",
                    "employees": filtered,
                    "footer": "",
                }

    # Executives follow different presence patterns (travel, remote office) —
    # exclude them from absence ranking unless the question names them specifically
    is_specific_person = bool(_query_employee(question))
    if not is_specific_person:
        employees = [e for e in employees if e.get("band") != "Executive"]

    # Add combined total for LLM to display
    for e in employees:
        e["totalAbsence"] = e["absent"] + e["leave"]

    # Filter and sort based on question intent
    if any(w in q for w in ("absent", "miss", "missing")):
        # Only show employees with MORE than 3 days absent+leave — real attendance concerns
        employees = [e for e in employees if e["totalAbsence"] > 3]
        employees.sort(key=lambda e: e["totalAbsence"], reverse=True)
    elif any(w in q for w in ("perfect", "present", "best attendance", "most present")):
        employees = [e for e in employees if e["absent"] == 0 and e["leave"] == 0]
        employees.sort(key=lambda e: e["present"], reverse=True)
    else:
        employees.sort(key=lambda e: e["totalAbsence"], reverse=True)

    show_all = any(kw in q for kw in _SHOW_ALL_KEYWORDS)
    total = len(employees)
    shown_list = employees if show_all else employees[:_ATTENDANCE_LIMIT]
    shown = len(shown_list)
    remaining = total - shown
    footer = f"...and {remaining} more." if remaining > 0 else ""

    if not shown_list:
        return {
            "_note": "No employees exceeded 3 days of absence/leave this period. Attendance is healthy.",
            "employees": [],
            "footer": "",
        }

    return {
        "_note": (
            f"List ONLY these {shown} employees — all have more than 3 days absent or on leave. "
            "Show each person's absent days, leave days, and totalAbsence. Do not add or invent names."
        ),
        "employees": shown_list,
        "footer": footer,
    }


_SHOW_ALL_KEYWORDS = ("show all", "see all", "show more", "show remaining", "show rest")
_AVAILABILITY_LIMIT = 10
_AVAILABILITY_STATUS_WORDS = ("online", "offline", "available", "busy", "away", "active", "presence")


def _name_score(full_name: str, query_name: str) -> int:
    """Return how many query words appear in full_name (case-insensitive)."""
    fn = full_name.lower()
    return sum(1 for w in query_name.split() if w in fn)


def _fetch_live_presence(name: str) -> str | None:
    """Call Teams API live for a single employee's real-time presence status."""
    import sys
    from pathlib import Path
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    graph = _load_graph()
    graph_emp = next(
        (e for e in graph.get("employees", [])
         if _name_score(e.get("name", ""), name) > 0),
        None,
    )
    if not graph_emp:
        return None
    user_id = graph_emp.get("userId")
    if not user_id:
        return None
    try:
        from services.teams_api_client import get_presences_by_user_id
        result = get_presences_by_user_id([user_id])
        presences = result.get("value", [])
        if presences:
            return presences[0].get("availability") or presences[0].get("activity")
    except Exception:
        pass
    return None


def get_availability_data(question: str = "") -> dict:
    import re
    data = _load()
    q = question.lower()

    all_records = [
        {
            "name": e.get("name"),
            "team": e.get("team"),
            "status": e.get("teams", {}).get("status", "Unknown"),
            "_teams": e.get("teams", {}),
        }
        for e in data.get("employees", [])
    ]
    all_records = _filter_by_team(all_records, question)

    def _single_presence_result(query_name: str, note_suffix: str = "") -> dict | None:
        scored = [(r, _name_score(r["name"], query_name)) for r in all_records]
        best_score = max((s for _, s in scored), default=0)
        if best_score == 0:
            return None
        match = max(scored, key=lambda x: x[1])[0]
        live = _fetch_live_presence(query_name)
        status = live if live else match["status"]
        source = " (live)" if live else " (last known)"
        return {
            "_note": f"Real-time presence for '{match['name']}'{note_suffix}. Status is{source}.",
            "employees": [{"name": match["name"], "team": match["team"], "status": status}],
            "footer": "",
        }

    # Detect "is [name] [status]?" — single-person lookup
    m = re.search(
        r'\bis\s+([a-z][\w\s]{2,35}?)\s+(?:' + '|'.join(_AVAILABILITY_STATUS_WORDS) + r')',
        q,
    )
    if m:
        result = _single_presence_result(m.group(1).strip())
        if result:
            return result

    # Also detect "[name]'s status / [name] teams status" or "how many meetings [name]"
    m2 = re.search(r"([a-z][\w\s]{2,35}?)(?:'s)?\s+(?:teams?\s+)?status", q)
    if m2:
        result = _single_presence_result(m2.group(1).strip())
        if result:
            return result

    # Group / list query — filter by status keyword
    if any(w in q for w in ("online", "active", "available")):
        status_filter = lambda t: bool(t.get("isActive"))
    elif any(w in q for w in ("away", "brb", "be right back")):
        status_filter = lambda t: t.get("status") in ("Away", "BeRightBack") or bool(t.get("isAway"))
    elif "offline" in q:
        status_filter = lambda t: t.get("status") == "Offline" or bool(t.get("isOffline"))
    elif "busy" in q:
        status_filter = lambda t: t.get("status") == "Busy"
    else:
        status_filter = lambda t: bool(t.get("status"))

    filtered = [
        {"name": r["name"], "team": r["team"], "status": r["status"]}
        for r in all_records
        if status_filter(r["_teams"])
    ]

    total = len(filtered)
    show_all = any(kw in q for kw in _SHOW_ALL_KEYWORDS)
    employees = filtered if show_all else filtered[:_AVAILABILITY_LIMIT]

    shown = len(employees)
    remaining = total - shown
    footer = f"...and {remaining} more." if remaining > 0 else ""
    return {
        "_note": f"List ONLY these {shown} employees exactly as given. Do not add, repeat, or invent any names.",
        "employees": employees,
        "footer": footer,
    }


_TASK_LIMIT = 10


def get_task_data(question: str = "", history: list | None = None) -> dict:
    data = _load()
    q = question.lower()

    employees = [
        {
            "name": e.get("name"),
            "team": e.get("team"),
            "designation": e.get("designation"),
            "tasksCompleted": e.get("worklogix", {}).get("completed", 0),
            "totalTasks":     e.get("worklogix", {}).get("workItems", 0),
            "pendingTasks": (
                e.get("worklogix", {}).get("todo", 0)
                + e.get("worklogix", {}).get("inProgress", 0)
                + e.get("worklogix", {}).get("pending", 0)
            ),
            "inProgress": e.get("worklogix", {}).get("inProgress", 0),
            "todo": e.get("worklogix", {}).get("todo", 0),
        }
        for e in data.get("employees", [])
        if e.get("worklogix")
    ]
    employees = _filter_by_team(employees, question)

    # "Show their task progress" — filter to names from previous reply
    if any(w in q for w in _PRONOUN_TRIGGERS) and history:
        names = _extract_names_from_history(history)
        if names:
            filtered = _filter_by_names(employees, names)
            if filtered:
                shown = len(filtered)
                return {
                    "_note": f"List ONLY these {shown} employees — they were mentioned in the previous answer.",
                    "employees": filtered,
                    "footer": "",
                }

    if any(w in q for w in ("pending", "incomplete", "not done", "blocked")):
        employees = [e for e in employees if e["pendingTasks"] > 0 or e["tasksCompleted"] < e["totalTasks"]]
        employees.sort(key=lambda e: e["pendingTasks"], reverse=True)
    elif any(w in q for w in ("complet", "done", "finish", "progress")):
        employees.sort(key=lambda e: e["tasksCompleted"], reverse=True)
    else:
        employees.sort(key=lambda e: e["tasksCompleted"], reverse=True)

    show_all = any(kw in q for kw in _SHOW_ALL_KEYWORDS)
    total = len(employees)
    shown_list = employees if show_all else employees[:_TASK_LIMIT]
    shown = len(shown_list)
    remaining = total - shown
    footer = f"...and {remaining} more." if remaining > 0 else ""

    return {
        "_note": f"List ONLY these {shown} employees exactly as given. Do not add, repeat, or invent names.",
        "employees": shown_list,
        "footer": footer,
    }


_GITHUB_TASK_LIMIT = 8


def get_github_data(question: str = "") -> dict:
    if not GITHUB_DATA_FILE.exists():
        return {"_note": "No GitHub data available yet. Ask the admin to refresh it.", "projects": [], "contributors": []}
    try:
        raw = json.loads(GITHUB_DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"_note": "GitHub data could not be read.", "projects": [], "contributors": []}

    projects     = raw.get("projects", [])
    contributors = raw.get("contributors", [])
    q = question.lower()

    # Summarise projects for context; limit tasks per project to keep prompt short
    summarised = []
    for proj in projects:
        stats = proj.get("stats", {})
        items = proj.get("items", [])
        show_all = any(kw in q for kw in _SHOW_ALL_KEYWORDS)
        sample_items = items if show_all else items[:_GITHUB_TASK_LIMIT]
        remaining = len(items) - len(sample_items)
        summarised.append({
            "name":  proj.get("name"),
            "stats": stats,
            "items": sample_items,
            "footer": f"...and {remaining} more tasks." if remaining > 0 else "",
        })

    total_tasks = sum(p.get("stats", {}).get("total", 0) for p in projects)
    total_done  = sum(p.get("stats", {}).get("done", 0) for p in projects)

    return {
        "_note": (
            "Answer using ONLY the GitHub project data provided. "
            "For task lists, increment the number for each item (1, 2, 3 …). "
            "If footer is non-empty, copy it exactly after the last item."
        ),
        "summary": {
            "projects": len(projects),
            "contributors": len(contributors),
            "totalTasks": total_tasks,
            "doneTasks":  total_done,
        },
        "projects":     summarised,
        "contributors": contributors,
        "lastUpdated":  raw.get("lastUpdated"),
    }


def get_efficiency_data() -> dict:
    data = _load()
    return {
        "employees": [
            {
                "id": e.get("id"),
                "name": e.get("name"),
                "team": e.get("team"),
                "worklogix": e.get("worklogix", {}),
                "attendance": {
                    "officeHours": e.get("attendance", {}).get("officeHours"),
                    "avgOfficeHours": e.get("attendance", {}).get("avgOfficeHours"),
                    "teamsAvailableHours": e.get("attendance", {}).get("teamsAvailableHours"),
                },
                "scoreDrivers": e.get("scoreDrivers", {}),
            }
            for e in data.get("employees", [])
        ]
    }


def get_risk_insight_data(question: str = "") -> dict:
    """Employees with multiple performance risk signals for management attention."""
    data = _load()
    employees = data.get("employees", [])

    risk_records = []
    for e in employees:
        kpi = e.get("kpi")
        band = e.get("band", "")
        att = e.get("attendance", {})
        wl = e.get("worklogix", {})
        teams_data = e.get("teams", {})
        lagging = e.get("laggingDrivers", [])
        gap = e.get("gapReason", "")
        has_data = e.get("has_attendance_data", True)

        if not has_data and kpi is None:
            continue
        if band == "Executive":
            continue

        risks = []
        if kpi is not None and kpi < 60:
            risks.append(f"KPI {kpi} — Critical band")
        elif band == "Needs Improvement" and kpi is not None:
            risks.append(f"KPI {kpi} — Needs Improvement")
        absent = att.get("absent", 0)
        if absent >= 4:
            risks.append(f"Absent {absent} days")
        completed = wl.get("completed", 0)
        pending = wl.get("todo", 0) + wl.get("inProgress", 0) + wl.get("pending", 0)
        true_total = completed + pending
        if true_total >= 3 and pending / true_total > 0.5:
            completion_pct = round(completed / true_total * 100)
            risks.append(f"Only {completion_pct}% tasks completed ({completed} done, {pending} pending)")
        # Only surface lagging drivers when KPI is already below 70 — prevents
        # flagging employees who simply lack a data source (e.g. no GitHub account)
        if kpi is not None and kpi < 70 and len(lagging) >= 2:
            risks.append(f"Lagging: {', '.join(lagging[:3])}")

        if risks:
            risk_records.append({
                "name": e.get("name"),
                "team": e.get("team"),
                "designation": e.get("designation"),
                "kpi": kpi,
                "band": band,
                "riskFactors": risks,
                "riskCount": len(risks),
                "absent": absent,
                "tasksCompleted": completed,
                "totalTasks": true_total,
                "pendingTasks": pending,
                "gapReason": gap,
                "teamsStatus": teams_data.get("status", ""),
                "teamsAvailableHours": att.get("teamsAvailableHours"),
            })

    risk_records = _filter_by_team(risk_records, question)
    risk_records.sort(key=lambda x: (-x["riskCount"], x["kpi"] if x["kpi"] is not None else 999))

    total = len(risk_records)
    show_all = any(kw in question.lower() for kw in _SHOW_ALL_KEYWORDS)
    shown = total if show_all else min(total, 10)
    return {
        "_note": f"These {shown} employees have performance risk signals needing management attention. Present each with their specific issues clearly.",
        "totalAtRisk": total,
        "employees": risk_records[:shown],
        "footer": f"...and {total - shown} more employees with risk signals." if total > shown else "",
        "overview": data.get("overview", {}),
    }


def get_team_summary_data(question: str = "") -> dict:
    """Aggregate performance stats per team for comparison and health overview."""
    data = _load()
    employees = data.get("employees", [])

    teams: dict[str, dict] = {}
    for e in employees:
        team = (e.get("team") or "Unknown").strip()
        if team not in teams:
            teams[team] = {
                "name": team,
                "count": 0,
                "kpis": [],
                "absentTotal": 0,
                "tasksCompleted": 0,
                "tasksTotal": 0,
                "highPerformers": 0,
                "meetsExpectation": 0,
                "needsImprovement": 0,
                "lowPerformers": 0,
                "insufficientData": 0,
            }
        t = teams[team]
        t["count"] += 1
        kpi = e.get("kpi")
        if kpi is not None:
            t["kpis"].append(kpi)
        band = e.get("band", "")
        if band in ("Excellent", "Good"):
            t["highPerformers"] += 1
        elif band == "Average":
            t["meetsExpectation"] += 1
        elif band == "Needs Improvement":
            t["needsImprovement"] += 1
        elif band == "Critical":
            t["lowPerformers"] += 1
        else:
            t["insufficientData"] += 1
        att = e.get("attendance", {})
        t["absentTotal"] += att.get("absent", 0)
        wl = e.get("worklogix", {})
        t["tasksCompleted"] += wl.get("completed", 0)
        t["tasksTotal"] += wl.get("workItems", 0)

    summaries = []
    for team_name, t in teams.items():
        avg_kpi = round(sum(t["kpis"]) / len(t["kpis"]), 1) if t["kpis"] else None
        summaries.append({
            "team": team_name,
            "headcount": t["count"],
            "avgKpi": avg_kpi,
            "highPerformers": t["highPerformers"],
            "meetsExpectation": t["meetsExpectation"],
            "needsImprovement": t["needsImprovement"],
            "lowPerformers": t["lowPerformers"],
            "insufficientData": t["insufficientData"],
            "totalAbsent": t["absentTotal"],
            "avgAbsent": round(t["absentTotal"] / t["count"], 1) if t["count"] else 0,
            "tasksCompleted": t["tasksCompleted"],
            "tasksTotal": t["tasksTotal"],
            "taskCompletionRate": round(t["tasksCompleted"] / t["tasksTotal"] * 100, 1) if t["tasksTotal"] else None,
        })

    summaries.sort(key=lambda x: x["avgKpi"] if x["avgKpi"] is not None else 0, reverse=True)

    # If specific teams are mentioned in the question, filter to those
    q = question.lower()
    specific = [s for s in summaries if s["team"].lower() in q]
    if specific:
        summaries = specific

    return {
        "_note": "Team-level aggregated performance data. Use for team health comparisons and overview.",
        "teams": summaries,
        "overview": data.get("overview", {}),
    }


def get_planner_data(question: str = "", history: list | None = None) -> dict:
    graph = _load_graph()
    employee = _query_employee(question)
    q = question.lower()

    # Resolve pronouns from conversation history
    if not employee and any(w in q for w in _PRONOUN_TRIGGERS) and history:
        names = _extract_names_from_history(history)
        for name in names:
            emp = _query_employee(name)
            if emp:
                employee = emp
                break
    plans = graph.get("planner", {}).get("plans", [])
    tasks = [
        task
        for plan in plans
        for task in plan.get("tasks", [])
    ]
    if employee:
        user_id = employee.get("graphActivity", {}).get("userId")
        tasks = [task for task in tasks if user_id in task.get("assigneeIds", [])]
    if "overdue" in q:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        def overdue(task):
            due = str(task.get("dueDateTime") or "")
            try:
                return task.get("status") != "Completed" and datetime.fromisoformat(due.replace("Z", "+00:00")) < now
            except ValueError:
                return False
        tasks = [task for task in tasks if overdue(task)]
    elif "completed" in q or "done" in q:
        tasks = [task for task in tasks if task.get("status") == "Completed"]
    elif "not started" in q:
        tasks = [task for task in tasks if task.get("status") == "Not started"]
    elif "in progress" in q:
        tasks = [task for task in tasks if task.get("status") == "In progress"]

    show_all = any(keyword in q for keyword in _SHOW_ALL_KEYWORDS)
    limit = min(len(tasks), 30) if show_all else 8
    selected = tasks[:limit]
    plan_summaries = [
        {
            "id": plan.get("id"),
            "title": plan.get("title"),
            "groupName": plan.get("groupName"),
            "taskCount": len(plan.get("tasks", [])),
            "summary": plan.get("summary", {}),
        }
        for plan in plans
    ][:30]

    if "plan" in q and "task" not in q:
        return {
            "_note": "Use only these Microsoft Planner plan summaries.",
            "employee": _compact_employee(employee) if employee else None,
            "plans": plan_summaries,
            "summary": graph.get("overview", {}),
        }

    return {
        "_note": (
            "List only the matching Microsoft Planner tasks below. "
            "Do not replace tasks with plan summaries or Worklogix tasks."
        ),
        "employee": _compact_employee(employee) if employee else None,
        "tasks": selected,
        "footer": f"...and {len(tasks) - len(selected)} more Planner tasks." if len(tasks) > len(selected) else "",
        "summary": graph.get("overview", {}),
    }


def get_calendar_data(question: str = "") -> dict:
    from datetime import datetime, timedelta
    graph = _load_graph()
    employee = _query_employee(question)
    q = question.lower()
    records = graph.get("employees", [])
    single_person = bool(employee)

    # Build raw event list from ALL employees (needed for attendee-scan for single-person)
    all_raw_events = [
        {
            **_safe_calendar_event(event),
            "employeeId": record.get("id"),
            "employeeName": record.get("name"),
        }
        for record in records
        for event in record.get("calendar", {}).get("items", [])
    ]

    if single_person:
        # For a named person: find all meetings they organised OR appear as attendee in
        emp_name_lower = employee.get("name", "").lower()
        emp_name_words = [w for w in emp_name_lower.split() if len(w) > 1]
        def _is_person_event(ev: dict) -> bool:
            org = str(ev.get("organizer", "")).lower()
            attendees = " ".join(str(a) for a in ev.get("attendees", [])).lower()
            emp_name = ev.get("employeeName", "").lower()
            haystack = f"{org} {attendees} {emp_name}"
            return any(w in haystack for w in emp_name_words)
        # Deduplicate by (subject, start) across all employees, keeping only person's events
        seen_single: dict[tuple, dict] = {}
        for ev in all_raw_events:
            if not _is_person_event(ev):
                continue
            key = (str(ev.get("subject", "")).lower().strip(), str(ev.get("start", ""))[:16])
            if key not in seen_single:
                seen_single[key] = ev
        events = list(seen_single.values())
    else:
        # Group query: deduplicate by (subject, start) across all employees
        seen: dict[tuple, dict] = {}
        for ev in all_raw_events:
            key = (str(ev.get("subject", "")).lower().strip(), str(ev.get("start", ""))[:16])
            if key not in seen:
                seen[key] = {**ev, "_attendeeNames": [ev["employeeName"]]}
            else:
                seen[key]["_attendeeNames"].append(ev["employeeName"])
        events = list(seen.values())

    # Date filter
    if "today" in q or "tomorrow" in q:
        target = datetime.now().date() + (timedelta(days=1) if "tomorrow" in q else timedelta())
        events = [e for e in events if str(e.get("start", ""))[:10] == target.isoformat()]
        date_label = target.strftime("%A, %d %B %Y")
    else:
        date_label = None

    # Cancelled filter — by default exclude cancelled for group/today queries
    want_cancelled = "cancel" in q
    if want_cancelled:
        events = [e for e in events if e.get("isCancelled")]
    elif "today" in q or "tomorrow" in q:
        events = [e for e in events if not e.get("isCancelled")]

    # Keyword filter for group queries
    terms = [
        word for word in re.findall(r"[a-z0-9]+", q)
        if len(word) > 3 and word not in {
            "calendar", "events", "event", "meeting", "meetings", "show",
            "employee", "today", "tomorrow", "their", "with", "what", "scheduled",
        }
    ]
    if terms and not single_person and not ("today" in q or "tomorrow" in q):
        filtered = [
            e for e in events
            if any(term in " ".join([
                str(e.get("subject", "")),
                str(e.get("organizer", "")),
                str(e.get("employeeName", "")),
                str(e.get("location", "")),
            ]).lower() for term in terms)
        ]
        if filtered:
            events = filtered

    events.sort(key=lambda e: str(e.get("start", "")))
    show_all = any(keyword in q for keyword in _SHOW_ALL_KEYWORDS)
    limit = 30 if show_all else 12
    selected = events[:limit]

    note = "Calendar timestamps are India Standard Time (IST). Use ONLY these events — do not invent meetings. Never expose passcodes."
    if date_label:
        note += f" These are the real meetings for {date_label}."
    if not events:
        note += " No meetings found for this query — say so clearly."

    return {
        "_note": note,
        "timeZone": graph.get("meta", {}).get("calendarTimeZone"),
        "date": date_label,
        "employee": _compact_employee(employee) if employee else None,
        "events": selected,
        "totalFound": len(events),
        "footer": f"...and {len(events) - len(selected)} more meetings." if len(events) > len(selected) else "",
    }


def get_sharepoint_data(question: str = "") -> dict:
    graph = _load_graph()
    q = question.lower()
    sites = graph.get("sharePoint", {}).get("sites", [])
    terms = [
        word for word in re.findall(r"[a-z0-9]+", q)
        if len(word) > 3 and word not in {
            "sharepoint", "share", "point", "site", "sites", "file",
            "files", "list", "lists", "show",
        }
    ]
    if terms:
        filtered = [
            site for site in sites
            if any(term in " ".join([
                str(site.get("displayName", "")),
                str(site.get("webUrl", "")),
                " ".join(str(item.get("name", "")) for item in site.get("files", [])),
                " ".join(str(item.get("displayName", "")) for item in site.get("lists", [])),
            ]).lower() for term in terms)
        ]
        if filtered:
            sites = filtered
    return {
        "_note": (
            "This is tenant SharePoint resource data, not per-employee activity. "
            "Never claim a person viewed or edited a file unless that fact is explicitly present."
        ),
        "summary": graph.get("overview", {}),
        "sites": [_compact_site(site) for site in sites[:12]],
        "footer": f"...and {len(sites) - 12} more SharePoint sites." if len(sites) > 12 else "",
    }


def get_employee_360_data(question: str = "") -> dict:
    employee = _query_employee(question)
    if not employee:
        return {"_note": "No matching employee was found in PeopleOPS.", "employee": None}
    graph = _load_graph()
    team = str(employee.get("team") or "").lower()
    sites = graph.get("sharePoint", {}).get("sites", [])
    related_sites = [
        site for site in sites
        if team and any(word in f"{site.get('displayName', '')} {site.get('webUrl', '')}".lower()
                            for word in re.findall(r"[a-z0-9]+", team) if len(word) > 2)
    ]

    # Calculate health verdict from all available signals
    kpi = employee.get("kpi")
    band = employee.get("band", "")
    att = employee.get("attendance", {})
    wl = employee.get("worklogix", {})
    lagging = employee.get("laggingDrivers", [])
    has_data = employee.get("has_attendance_data", True)
    absent = att.get("absent", 0)
    pending = wl.get("todo", 0) + wl.get("inProgress", 0) + wl.get("pending", 0)
    completed_tasks = wl.get("completed", 0)
    true_total = completed_tasks + pending

    risk_signals = []
    if kpi is not None and kpi < 60:
        risk_signals.append(f"KPI {kpi} — below threshold")
    if band in ("Critical", "Needs Improvement") and not any("KPI" in r for r in risk_signals):
        risk_signals.append(f"Band: {band}")
    if absent >= 3:
        risk_signals.append(f"{absent} days absent")
    if true_total > 0 and pending / true_total > 0.5:
        risk_signals.append(f"High pending tasks ({pending} pending, {completed_tasks} done)")
    if len(lagging) >= 2:
        risk_signals.append(f"Multiple lagging drivers: {', '.join(lagging[:3])}")

    if not has_data or (kpi is None and not att.get("biometricDays")):
        health_verdict = "Insufficient Data"
    elif risk_signals:
        health_verdict = "Needs Attention"
    else:
        health_verdict = "Working Well"

    return {
        "_note": (
            "Give a complete unified employee profile. Start your reply with the healthVerdict. "
            "Use all available data sources. "
            "SharePoint sites listed are team-relevant tenant resources, not proof of personal access."
        ),
        "employee": _compact_employee(employee),
        "healthVerdict": health_verdict,
        "riskSignals": risk_signals,
        "plannerTasks": employee.get("graphActivity", {}).get("planner", {}).get("tasks", [])[:5],
        "calendarEvents": [
            _safe_calendar_event(event)
            for event in employee.get("graphActivity", {}).get("calendar", {}).get("items", [])[:3]
        ],
        "sharePointResources": [
            {
                "displayName": site.get("displayName"),
                "webUrl": site.get("webUrl"),
                "owner": site.get("owner"),
                "lastActivity": site.get("lastActivity"),
            }
            for site in (related_sites or sites)[:2]
        ],
        "dataSources": [
            "Worklogix", "GreytHR", "Biometrics", "Microsoft Teams",
            "Microsoft Planner", "Microsoft Calendar", "Microsoft SharePoint",
            "GitHub (available separately when identity mapping exists)",
        ],
    }


def get_general_data() -> dict:
    data = _load()
    graph = _load_graph()
    employees = data.get("employees", [])

    # Build a quick team snapshot for context
    teams: dict[str, dict] = {}
    for e in employees:
        team = (e.get("team") or "Unknown").strip()
        if team not in teams:
            teams[team] = {"count": 0, "kpis": [], "atRisk": 0, "highP": 0}
        t = teams[team]
        t["count"] += 1
        kpi = e.get("kpi")
        if kpi is not None:
            t["kpis"].append(kpi)
        band = e.get("band", "")
        if band in ("Excellent", "Good"):
            t["highP"] += 1
        if band in ("Critical", "Needs Improvement") or (kpi is not None and kpi < 60):
            t["atRisk"] += 1

    team_snapshot = [
        {
            "team": name,
            "headcount": t["count"],
            "avgKpi": round(sum(t["kpis"]) / len(t["kpis"]), 1) if t["kpis"] else None,
            "highPerformers": t["highP"],
            "atRisk": t["atRisk"],
        }
        for name, t in teams.items()
    ]
    team_snapshot.sort(key=lambda x: x["avgKpi"] if x["avgKpi"] is not None else 0, reverse=True)

    return {
        "meta": data.get("meta", {}),
        "overview": data.get("overview", {}),
        "graphOverview": graph.get("overview", {}),
        "teamSnapshot": team_snapshot,
        "availableSources": [
            "Worklogix", "GreytHR", "Biometrics", "Microsoft Teams",
            "Microsoft Planner", "Microsoft Calendar", "Microsoft SharePoint",
            "GitHub",
        ],
        "bands": data.get("bands", {}),
        "employees": [
            {
                "id": e.get("id"),
                "name": e.get("name"),
                "team": e.get("team"),
                "designation": e.get("designation"),
                "band": e.get("band"),
                "kpi": e.get("kpi"),
            }
            for e in employees
        ],
    }


_EMPLOYEE_HOLISTIC_KEYWORDS = (
    "working well", "doing well", "how is", "how are", "is active", "active enough",
    "was active", "hours active", "how active", "how many hours",
    "performing", "contributing", "concern about", "worried about", "productive",
    "tell me about", "overview of", "profile of", "deep dive", "detail", "profile",
    "about", "summary", "data", "information", "info", "status of",
)

# Question starters that signal a list (do NOT redirect these to employee360)
_LIST_STARTERS = ("who ", "show ", "list ", "which ", "give me", "find ")


def route(category: str, question: str = "", history: list | None = None, active_month: str | None = None) -> dict:
    _tl.month_data = None  # reset any previous month override

    try:
        if category != "calendar":
            # Detect requested month — from question text first, then dashboard's active month
            req = _extract_requested_ym(question)
            if not req and active_month:
                # No month in the question → use whichever month the dashboard has loaded
                from datetime import datetime as _dt
                try:
                    ym = active_month[:7]  # "YYYY-MM"
                    dt = _dt.strptime(ym, "%Y-%m")
                    req = (ym, dt.strftime("%B %Y"))
                except (ValueError, IndexError):
                    req = None
            if req:
                ym_key, display_name = req
                month_data = _load_month_file(ym_key)
                if month_data is not None:
                    _tl.month_data = month_data  # all _load() calls will use this month
                else:
                    # Month asked for but no data file — tell user what is available
                    available = _available_months()
                    from datetime import datetime
                    available_display = [
                        datetime.strptime(m, "%Y-%m").strftime("%B %Y")
                        for m in available
                    ]
                    if available_display:
                        avail_str = " | ".join(available_display)
                        msg = (
                            f"{display_name} data is not loaded.\n"
                            f"Months available: {avail_str}\n"
                            f"To load {display_name}: go to the Attendance panel on the dashboard, "
                            f"select {display_name} in the month picker and click 'Load month'."
                        )
                    else:
                        msg = (
                            f"{display_name} data is not loaded and no monthly data exists yet.\n"
                            f"To load data: go to the Attendance panel, select a month and click 'Load month'."
                        )
                    _tl.month_data = None
                    return {"_periodMismatch": msg, "dataPeriod": display_name}

        data = _route_inner(category, question, history)
    finally:
        _tl.month_data = None  # always clean up

    if category == "calendar":
        try:
            graph_meta = _load_graph().get("meta", {})
            start = graph_meta.get("periodStart", "")
            if start:
                from datetime import datetime
                dt = datetime.strptime(start, "%Y-%m-%d")
                data["dataPeriod"] = dt.strftime("%B %Y")
        except Exception:
            pass
    else:
        period = _data_period()
        if period:
            data["dataPeriod"] = period

    return data


def _route_inner(category: str, question: str = "", history: list | None = None) -> dict:
    # New management intelligence categories
    if category == "risk_insight":
        return get_risk_insight_data(question)
    if category == "team_summary":
        return get_team_summary_data(question)

    # Explicit source categories
    if category == "employee360":
        return get_employee_360_data(question)
    if category == "planner":
        return get_planner_data(question, history)
    if category == "calendar":
        return get_calendar_data(question)
    if category == "sharepoint":
        return get_sharepoint_data(question)
    if category == "github":
        return get_github_data(question)

    q = question.lower().strip()
    is_list_question = any(q.startswith(s) for s in _LIST_STARTERS)

    # Detect "compare [name] and [name]" — return only those two employees
    compare_m = re.search(r'\bcompare\b.{1,40}\band\b', q)
    if compare_m:
        data = _load()
        all_emps = data.get("employees", [])
        # Find the two names in the question
        emp1 = _query_employee(re.sub(r'\band\b.*', '', compare_m.group(0).replace('compare', '')).strip())
        emp2 = _query_employee(re.sub(r'.*\band\b', '', compare_m.group(0)).strip())
        pair = [e for e in all_emps if e.get("id") in {
            (emp1 or {}).get("id"), (emp2 or {}).get("id")
        }]
        if len(pair) == 2:
            return {
                "_note": "Compare these two employees side by side — KPI, band, attendance, tasks. End with '→ [who is stronger and why]'.",
                "employees": [_compact_employee(e) for e in pair],
                "footer": "",
            }
        return get_performance_data(question, history)

    # Detect band distribution queries — return band counts across ALL employees
    if any(p in q for p in ("how many in each", "band distribution", "each band", "breakdown by band", "band breakdown", "count by band", "how many employees in each", "band count")):
        data = _load()
        from collections import Counter
        band_counts: Counter = Counter()
        band_members: dict[str, list[str]] = {}
        for e in data.get("employees", []):
            b = e.get("band") or "Insufficient Data"
            band_counts[b] += 1
            band_members.setdefault(b, []).append(e.get("name", ""))
        band_order = ["Excellent", "Good", "Average", "Needs Improvement", "Critical", "Insufficient Data", "Executive"]
        summary = [
            {"band": b, "count": band_counts[b], "employees": band_members[b][:5]}
            for b in band_order if b in band_counts
        ]
        return {
            "_note": "Show band distribution. Format: **[Band]**: [count] employees — [names]. End with → insight.",
            "totalEmployees": sum(band_counts.values()),
            "bandSummary": summary,
            "footer": "",
        }

    # For any non-graph category: if a specific employee is named and this is NOT
    # a list question, redirect to employee360 so Tara has full context
    if not is_list_question:
        employee = _query_employee(question)
        if employee and any(keyword in q for keyword in _EMPLOYEE_HOLISTIC_KEYWORDS):
            return get_employee_360_data(question)

    # Pronoun follow-up for performance ("show their KPI score")
    if any(w in q for w in _PRONOUN_TRIGGERS) and history:
        names = _extract_names_from_history(history)
        if names and len(names) == 1:
            # Single-person pronoun — redirect to employee360 for that person
            emp = _query_employee(names[0])
            if emp:
                return get_employee_360_data(names[0])

    if category == "availability":
        return get_availability_data(question)
    if category == "attendance":
        return get_attendance_data(question, history)
    if category == "task":
        return get_task_data(question, history)
    if category == "performance":
        return get_performance_data(question, history)
    if category == "efficiency":
        return get_efficiency_data()
    return get_general_data()
