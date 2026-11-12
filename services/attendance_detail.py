"""Build one employee's daily attendance table from the existing work-location cache.

This module does not fetch or alter GreytHR data.  It turns the cache already maintained by
``work_location_store`` into the small, employee-scoped response used by the profile dialog.
"""
from __future__ import annotations

import re
from datetime import date


_LEAVE_NAMES = {
    "CL": "Casual Leave",
    "SL": "Sick Leave",
    "EL": "Earned Leave",
    "LOP": "Loss of Pay",
    "LWP": "Leave Without Pay",
    "ML": "Maternity Leave",
    "PL": "Paternity Leave",
}


def _key(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _person_for(payload: dict, employee: dict) -> dict | None:
    source_keys = employee.get("sourceKeys") or {}
    ids = {
        _key(employee.get("id")),
        _key(source_keys.get("greythr")),
        _key(source_keys.get("biometric")),
    } - {""}
    name = _key(employee.get("name"))
    for person in payload.get("people", []):
        if ids.intersection({_key(person.get("id")), _key(person.get("no"))}):
            return person
    return next((p for p in payload.get("people", []) if name and _key(p.get("name")) == name), None)


def _status(raw: str, has_swipe: bool) -> tuple[str, str]:
    parts = [p.strip() for p in str(raw or "").split("/") if p.strip()]
    upper = [p.upper() for p in parts]
    if not parts:
        return ("Present", "present") if has_swipe else ("No record", "none")
    if all(p in {"OFF", "WO", "W/O", "WEEKOFF", "WEEKLYOFF"} for p in upper):
        return "Weekly off", "off"
    if upper == ["P"]:
        return "Present", "present"
    if upper == ["A"]:
        return "Absent", "absent"
    if upper == ["H"]:
        return "Holiday", "holiday"
    if upper == ["WFH"]:
        return "Work from Home", "present"

    shown = []
    tones = set()
    for original, value in zip(parts, upper):
        if value == "P":
            shown.append("Present")
            tones.add("present")
        elif value == "A":
            shown.append("Absent")
            tones.add("absent")
        elif value == "H":
            shown.append("Holiday")
            tones.add("holiday")
        elif value == "WFH":
            shown.append("Work from Home")
            tones.add("present")
        else:
            shown.append(_LEAVE_NAMES.get(value, original))
            tones.add("leave")
    tone = "absent" if "absent" in tones else "leave" if "leave" in tones else next(iter(tones), "none")
    return " / ".join(shown), tone


def _work_mode(record: dict, employee: dict) -> str:
    if not record:
        return "—"
    if record.get("bi"):
        location = str(record.get("door") or (employee.get("attendance") or {}).get("officeLocation") or "Office")
    elif record.get("wi"):
        return "Work from Home"
    else:
        location = str((employee.get("attendance") or {}).get("officeLocation") or "")
    aliases = {
        "codework-beta": "Beta Office",
        "codework beta": "Beta Office",
        "beta": "Beta Office",
        "cplc-alpha": "CPLC-Alpha",
    }
    return aliases.get(location.strip().lower(), location.strip()) or "—"


def _worked_minutes(start: str, end: str) -> int | None:
    try:
        sh, sm = map(int, start.split(":"))
        eh, em = map(int, end.split(":"))
    except (AttributeError, TypeError, ValueError):
        return None
    minutes = (eh * 60 + em) - (sh * 60 + sm)
    return minutes if minutes >= 0 else None


def build_employee_detail(payload: dict, employee: dict, today: date | None = None) -> dict:
    """Return working-day rows for ``employee`` from a work-location month payload."""
    today = today or date.today()
    person = _person_for(payload, employee)
    if not person:
        return {"month": payload.get("month", ""), "rows": [], "matched": False}

    internal_id = str(person.get("id", ""))
    rows = []
    # Profiles are reviewed for the latest activity first, so show the newest working day
    # at the top while preserving the source records themselves unchanged.
    for day, people in sorted((payload.get("days") or {}).items(), reverse=True):
        try:
            parsed = date.fromisoformat(day)
        except (TypeError, ValueError):
            continue
        if parsed.weekday() >= 5:  # approved profile view: omit Saturday and Sunday rows
            continue
        record = (people or {}).get(internal_id) or {}
        status, tone = _status(record.get("s", ""), bool(record.get("bi") or record.get("wi")))
        if tone == "off":
            continue
        login = record.get("bi") or record.get("wi") or ""
        logout = record.get("bo") or record.get("wo") or ""
        if parsed == today:
            if record.get("wi") and tone == "present":
                status = "Work from Home"
            elif login and tone == "present":
                status = "Checked in"
            elif not record:
                status, tone = "Not checked in", "none"
        rows.append({
            "date": day,
            "login": login,
            "logout": logout,
            "workMode": _work_mode(record, employee),
            "status": status,
            "tone": tone,
            "workedMinutes": _worked_minutes(login, logout),
        })
    return {
        "month": payload.get("month", ""),
        "fetchedAt": payload.get("fetchedAt"),
        "refreshing": bool(payload.get("refreshing")),
        "matched": True,
        "rows": rows,
    }
