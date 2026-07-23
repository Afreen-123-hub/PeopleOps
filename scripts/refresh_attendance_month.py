"""Refresh attendance data for a given month.

Only calls GreytHR (attendance records) and the biometric presence API.
Does NOT call Worklogix, so it's fast and reliable even when Worklogix is slow.

Usage:
    python scripts/refresh_attendance_month.py --month 2026-05
"""
from __future__ import annotations

import json
import re
import sys
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT / "data" / "peopleops-data.json"
sys.path.insert(0, str(PROJECT))

from services.greythr_api_client import (
    GreytHRApiError, GreytHRAuthError, GreytHRConfigError, get_greythr_attendance,
)
from services.worklogix_api_client import get_worklogix_employee_presence_report

OFFICE_START_HOUR = 9.0
LATE_GRACE_MINUTES = 15


def _clean(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.upper() in {"NULL", "NAN", "NONE"} else text


def _parse_time_ampm(s: str):
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


def _parse_duration_string(value):
    if not value:
        return 0.0
    text = str(value).lower()
    h = re.search(r"(\d+)\s*hour", text)
    m = re.search(r"(\d+)\s*min", text)
    return (float(h.group(1)) if h else 0.0) + (float(m.group(1)) if m else 0.0) / 60


def _extract_rows(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "result", "results", "rows", "records"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def _period_to_date_range(month: str):
    for fmt in ("%Y-%m", "%b %Y", "%B %Y"):
        try:
            dt = datetime.strptime(month, fmt)
            start = dt.replace(day=1).strftime("%Y-%m-%d")
            end = dt.replace(day=monthrange(dt.year, dt.month)[1]).strftime("%Y-%m-%d")
            return start, end
        except ValueError:
            continue
    return "", ""


def _to_presence_label(month: str) -> str:
    for fmt in ("%Y-%m", "%Y-%m-%d", "%b %Y", "%B %Y"):
        try:
            return datetime.strptime(month, fmt).strftime("%b %Y")
        except ValueError:
            continue
    return ""


def _fetch_greythr(start: str, end: str) -> dict:
    try:
        result = get_greythr_attendance(start, end)
        print(f"GreytHR attendance loaded: {len(result)} entries ({start} to {end})")
        return result
    except (GreytHRConfigError, GreytHRAuthError, GreytHRApiError) as exc:
        print(f"WARNING: GreytHR skipped: {exc}", file=sys.stderr)
        return {}


def _fetch_biometric(presence_month: str) -> defaultdict:
    result: defaultdict = defaultdict(Counter)
    checkin_times: dict[str, list] = defaultdict(list)
    checkout_times: dict[str, list] = defaultdict(list)
    try:
        payload = get_worklogix_employee_presence_report(month=presence_month)
    except Exception as exc:
        print(f"WARNING: biometric skipped: {exc}", file=sys.stderr)
        return result

    for row in _extract_rows(payload):
        emp_id = _clean(row.get("user_id"))
        if not emp_id:
            continue
        bio = row.get("biometric_in_office_status") or {}
        if bio:
            result[emp_id]["biometricDays"] += 1
            time_range = _clean(bio.get("time", ""))
            if " - " in time_range:
                cin_str, cout_str = time_range.split(" - ", 1)
                cin = _parse_time_ampm(cin_str)
                cout = _parse_time_ampm(cout_str)
                if cin is not None:
                    checkin_times[emp_id].append(cin)
                if cout is not None:
                    checkout_times[emp_id].append(cout)
            loc = _clean(bio.get("location", ""))
            if loc:
                result[emp_id][f"loc:{loc}"] += 1
        presence = row.get("microsoft_teams_presence") or {}
        avail = _parse_duration_string(presence.get("available"))
        away = _parse_duration_string(presence.get("away"))
        offline = _parse_duration_string(presence.get("offline") or presence.get("offline_presence"))
        if avail > 0:
            result[emp_id]["officeHours"] += avail
            result[emp_id]["validOfficeDays"] += 1
        result[emp_id]["teamsAvailableHours"] += avail
        result[emp_id]["teamsAwayHours"] += away
        result[emp_id]["teamsOfflineHours"] += offline

    grace = LATE_GRACE_MINUTES / 60
    for emp_id, times in checkin_times.items():
        on_time = sum(1 for t in times if t <= OFFICE_START_HOUR + grace)
        result[emp_id]["punctualityScore"] = round((on_time / len(times)) * 100, 1)
        result[emp_id]["avgCheckinHour"] = round(sum(times) / len(times), 2)
    for emp_id, times in checkout_times.items():
        result[emp_id]["avgCheckoutHour"] = round(sum(times) / len(times), 2)
    for emp_id, counts in result.items():
        loc_counts = {k[4:]: v for k, v in counts.items() if k.startswith("loc:")}
        if loc_counts:
            result[emp_id]["officeLocation"] = max(loc_counts, key=loc_counts.get)
    return result


def _norm_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def main():
    args = sys.argv[1:]
    month = ""
    for idx, arg in enumerate(args):
        if arg == "--month" and idx + 1 < len(args):
            month = args[idx + 1].strip()
        elif arg.startswith("--month="):
            month = arg.split("=", 1)[1].strip()

    if not month:
        print("ERROR: --month YYYY-MM is required", file=sys.stderr)
        sys.exit(1)
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        print("ERROR: --month must use YYYY-MM format", file=sys.stderr)
        sys.exit(1)

    if not DATA_FILE.exists():
        print("ERROR: peopleops-data.json not found. Run generate_peopleops_data.py first.", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"ERROR: Could not read peopleops-data.json: {exc}", file=sys.stderr)
        sys.exit(1)

    start, end = _period_to_date_range(month)
    if not start:
        print(f"ERROR: Could not parse month '{month}'", file=sys.stderr)
        sys.exit(1)

    presence_month = _to_presence_label(month)
    greythr = _fetch_greythr(start, end)
    biometric = _fetch_biometric(presence_month)

    updated = 0
    for emp in data.get("employees", []):
        emp_id = _clean(emp.get("id", ""))
        source_keys = emp.get("sourceKeys", {})
        greythr_key = _clean(source_keys.get("greythr", "")) or emp_id
        biometric_key = _clean(source_keys.get("biometric", "")) or emp_id
        name_key = f"name:{_norm_key(emp.get('name', ''))}"

        gh = (
            greythr.get(emp_id)
            or greythr.get(greythr_key)
            or greythr.get(biometric_key)
            or greythr.get(name_key)
            or Counter()
        )
        bio = biometric.get(emp_id) or biometric.get(biometric_key) or Counter()

        c = round(gh["P"] + gh["A"] + gh["OFF"] + gh["H"] + gh["Leave"] + gh["Blank"]) if gh else 0
        # Cap biometric at calendarDays — API sometimes returns duplicate records per day
        bio_days = min(bio["biometricDays"], c) if c and bio["biometricDays"] else bio["biometricDays"]
        present_days = bio_days or (gh["P"] if gh else 0)
        valid_days = min(bio["validOfficeDays"], c) if c else bio["validOfficeDays"]

        emp["attendance"] = {
            "present": present_days,
            "absent": gh["A"],
            "off": gh["OFF"],
            "holidays": gh["H"],
            "leave": gh["Leave"],
            "blank": gh["Blank"],
            "calendarDays": c,
            "biometricDays": min(bio["biometricDays"], c) if c else bio["biometricDays"],
            "validOfficeDays": valid_days,
            "officeHours": round(bio["officeHours"], 1),
            "avgOfficeHours": round(bio["officeHours"] / max(1, valid_days), 1),
            "avgCheckinHour": bio.get("avgCheckinHour"),
            "avgCheckoutHour": bio.get("avgCheckoutHour"),
            "officeLocation": bio.get("officeLocation", ""),
            "punctualityScore": bio.get("punctualityScore"),
            "teamsAvailableHours": round(bio.get("teamsAvailableHours", bio["officeHours"]), 1),
            "teamsAwayHours": round(bio.get("teamsAwayHours", 0), 1),
            "teamsOfflineHours": round(bio.get("teamsOfflineHours", 0), 1),
        }
        updated += 1

    data.setdefault("meta", {})["period"] = f"{start} to {end}"
    data["meta"]["attendanceRefreshedAt"] = datetime.now().isoformat(timespec="seconds")

    DATA_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Updated attendance for {updated} employees ({month})")

    # Also save a month-specific copy so Tara can answer multi-month questions
    months_dir = PROJECT / "data" / "months"
    months_dir.mkdir(exist_ok=True)
    month_file = months_dir / f"{month}.json"
    month_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Saved month snapshot → data/months/{month}.json")


if __name__ == "__main__":
    main()
