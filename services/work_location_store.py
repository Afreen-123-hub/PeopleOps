"""Per-month cache of where each employee worked, used by the "Work location" card.

Built from two read-only GreytHR sources:
  * raw swipes  (/attendance/v2/employee/{id}/swipes?systemSwipes=true)
      biometric door swipe -> office, Web/Mobile Sign In -> home
  * attendance muster, only for the day's status label (A, CL, H, OFF, ...) of
    people who have no swipe at all.

Kept separate from the main attendance pipeline: nothing here touches
peopleops-data.json or data/months/*.json. Each month is stored as
data/worklocation/YYYY-MM.json.

GreytHR only returns swipes one employee at a time, so a month refresh is ~one
call per employee and takes about a minute. Requests therefore never wait for it:
get_month() returns whatever is cached and refreshes in a background thread, and
start_background_refresher() keeps the current month warm from server start.
Once a month is cached, routine refreshes re-fetch only the last few days.
"""
from __future__ import annotations

import json
import os
import re
import threading
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = PROJECT_ROOT / "data" / "worklocation"

# The month in progress is refreshed in the background once its cache is this old.
OPEN_MONTH_MAX_AGE = 30 * 60
# A routine refresh of the current month re-fetches only this many recent days;
# a full re-fetch still happens when the cached full fetch is older than FULL_REFRESH_AGE
# (so leave applied or approved later for earlier days is picked up).
RECENT_DAYS = 3
FULL_REFRESH_AGE = 12 * 3600
# Parallel swipe requests. Measured on a 93-person month: 8 -> ~115s, 24 -> ~56s,
# 48 -> ~107s (GreytHR slows down under more load), so 24.
WORKERS = 24

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_guard = threading.Lock()
_refreshing: set[str] = set()
_last_error: dict[str, str] = {}
_progress: dict[str, tuple[int, int]] = {}  # month -> (employees fetched, total) while a refresh runs


def _cache_path(month: str) -> Path:
    return CACHE_DIR / f"{month}.json"


def read_cache(month: str) -> dict | None:
    try:
        payload = json.loads(_cache_path(month).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) and isinstance(payload.get("days"), dict) else None


def _is_fresh(payload: dict, month: str) -> bool:
    try:
        fetched = datetime.fromisoformat(payload["fetchedAt"])
    except (KeyError, ValueError, TypeError):
        return False
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    year, mon = int(month[:4]), int(month[5:7])
    month_end = datetime(year, mon, monthrange(year, mon)[1], 23, 59, 59, tzinfo=timezone.utc)
    if fetched > month_end:  # fetched after the month closed, so it can't change any more
        return True
    return (datetime.now(timezone.utc) - fetched).total_seconds() < OPEN_MONTH_MAX_AGE


def _hhmm(punch: str) -> str:
    # punchDateTime is local (IST) time, e.g. "2026-09-21T09:05:26.050902"
    return str(punch or "")[11:16]


def _summarise_swipes(swipes: list[dict]) -> dict[str, dict]:
    """{date: {bi, bo, door, wi, wo, mob}} from one employee's raw swipes.

    bi/bo = first/last biometric swipe, wi/wo = first/last web or mobile sign-in.
    A biometric swipe is one with no swipeCaptureType (it carries an access card and
    an office door name); "Web Sign In" and "Mobile Sign In" are the remote ones.
    A single swipe (or several in the same minute) gives an in-time only, so "out" is left empty.
    """
    by_day: dict[str, dict[str, list]] = {}
    for s in swipes:
        day = str(s.get("attendanceDate") or "")[:10]
        punch = str(s.get("punchDateTime") or "")
        if not day or not punch:
            continue
        kind = str(s.get("swipeCaptureType") or "").strip()
        bucket = by_day.setdefault(day, {"bio": [], "remote": [], "mob": False})
        if kind:
            bucket["remote"].append(punch)
            if "mobile" in kind.lower():
                bucket["mob"] = True
        else:
            bucket["bio"].append((punch, str(s.get("doorName") or "").strip()))

    out: dict[str, dict] = {}
    for day, b in by_day.items():
        rec: dict = {}
        if b["bio"]:
            bio = sorted(b["bio"])
            rec["bi"] = _hhmm(bio[0][0])
            if _hhmm(bio[-1][0]) != rec["bi"]:  # a second swipe in the same minute is not a check-out
                rec["bo"] = _hhmm(bio[-1][0])
            door = bio[0][1]
            rec["door"] = door[5:] if door.startswith("CW - ") else door
        if b["remote"]:
            remote = sorted(b["remote"])
            rec["wi"] = _hhmm(remote[0])
            if _hhmm(remote[-1]) != rec["wi"]:
                rec["wo"] = _hhmm(remote[-1])
            if b["mob"]:
                rec["mob"] = 1
        out[day] = rec
    return out


def _day_status(summary: dict) -> str:
    """GreytHR's label for the day, e.g. "P", "A", "CL", "H", "OFF", or "CL/P" for a half day."""
    from services.greythr_api_client import _normalise_attendance_label

    labels = []
    for key in ("session1Label", "session2Label"):
        raw = str(summary.get(key) or "").strip()
        label = _normalise_attendance_label(raw) if raw else ""
        if not label or label == "Blank":
            continue
        shown = label if label in {"P", "A", "H", "OFF", "WFH"} else raw  # keep leave codes as GreytHR spells them
        if shown not in labels:
            labels.append(shown)
    return "/".join(labels)


def _age_seconds(stamp) -> float:
    try:
        when = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return float("inf")
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - when).total_seconds()


def refresh_month(month: str, full: bool = False) -> dict:
    """Fetch the month from GreytHR and write the cache file. Raises on GreytHR errors.

    When the month is already cached and its last full fetch is recent, only the last
    RECENT_DAYS days are fetched and merged in, which is much quicker. full=True
    always fetches the whole month."""
    from services.greythr_api_client import (
        API_BASE, _api_get, get_attendance_muster, get_employee_master, get_token,
    )

    if not _MONTH_RE.fullmatch(month):
        raise ValueError("Month must use YYYY-MM format.")
    year, mon = int(month[:4]), int(month[5:7])
    start = f"{month}-01"
    end = min(date(year, mon, monthrange(year, mon)[1]), date.today()).isoformat()
    if end < start:
        raise ValueError("That month hasn't started yet.")
    month_start = start

    cached = None if full else read_cache(month)
    if cached and _age_seconds(cached.get("fullAt")) < FULL_REFRESH_AGE:
        recent = (date.fromisoformat(end) - timedelta(days=RECENT_DAYS - 1)).isoformat()
        start = max(start, recent)
    else:
        cached = None

    token, domain = get_token()
    master = get_employee_master(token, domain)

    def swipes_for(emp_id: str):
        try:
            data = _api_get(
                f"{API_BASE}/attendance/v2/employee/{emp_id}/swipes",
                token, domain,
                params={"start": start, "end": end, "systemSwipes": "true"},
            )
            return emp_id, _summarise_swipes(data.get("list") or [])
        except Exception:
            return emp_id, None

    ids = list(master)
    results: dict[str, dict] = {}
    failed: list[str] = []
    _progress[month] = (0, len(ids))
    with ThreadPoolExecutor(WORKERS) as pool:
        for n, (emp_id, days) in enumerate(pool.map(swipes_for, ids), 1):
            (failed.append(emp_id) if days is None else results.__setitem__(emp_id, days))
            _progress[month] = (n, len(ids))
    for emp_id in list(failed):  # one retry, one at a time, for calls that timed out
        _, days = swipes_for(emp_id)
        if days is not None:
            results[emp_id] = days
            failed.remove(emp_id)
    if ids and len(failed) > len(ids) // 2:
        raise RuntimeError(f"GreytHR swipes failed for {len(failed)} of {len(ids)} employees")

    days: dict[str, dict[str, dict]] = {}
    for emp in get_attendance_muster(token, domain, start, end, set(ids)):
        emp_id = str(emp.get("employeeId", "")).strip()
        for rec in emp.get("records", []):
            summary = rec.get("summary") or {}
            day = str(summary.get("attendanceDate") or "")[:10]
            status = _day_status(summary)
            if day and status:
                days.setdefault(day, {}).setdefault(emp_id, {})["s"] = status
    for emp_id, per_day in results.items():
        for day, rec in per_day.items():
            if rec:
                days.setdefault(day, {}).setdefault(emp_id, {}).update(rec)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if cached:  # partial refresh: keep earlier days from the cache, replace the re-fetched ones
        kept = {day: recs for day, recs in cached["days"].items() if day < start}
        days = {**kept, **days}
    payload = {
        "month": month,
        "fetchedAt": now,
        "fullAt": cached.get("fullAt") if cached else now,
        "people": [
            {"id": emp_id, "no": info.get("employee_no", ""), "name": info.get("name") or emp_id}
            for emp_id, info in master.items()
        ],
        "days": days,
        "missing": failed,  # employees whose swipes could not be fetched this time
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _cache_path(month).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, _cache_path(month))  # atomic: readers never see a half-written file
    print(f"[work-location] {month} refreshed {start}..{end}" + (" (recent days)" if start > month_start else ""), flush=True)
    return payload


def _refresh_in_background(month: str) -> None:
    with _guard:
        if month in _refreshing:
            return
        _refreshing.add(month)

    def run():
        try:
            refresh_month(month)
            _last_error.pop(month, None)
        except Exception as exc:
            _last_error[month] = f"{type(exc).__name__}: {exc}"
            print(f"[work-location] {month} refresh failed: {_last_error[month]}", flush=True)
        finally:
            _progress.pop(month, None)
            with _guard:
                _refreshing.discard(month)

    threading.Thread(target=run, name=f"work-location-{month}", daemon=True).start()


def get_month(month: str) -> dict:
    """Return the cached month straight away. If it's missing or stale, start a background
    refresh and say so, so the page can show what it has and check back shortly."""
    if not _MONTH_RE.fullmatch(month):
        raise ValueError("Month must use YYYY-MM format.")
    cached = read_cache(month)
    if cached and _is_fresh(cached, month):
        return cached
    _refresh_in_background(month)
    if cached:
        return {**cached, "refreshing": True}
    done, total = _progress.get(month, (0, 0))
    return {"month": month, "building": True, "error": _last_error.get(month), "done": done, "total": total}


def start_background_refresher() -> None:
    """Keep the current month cached from server start, so the card rarely has to wait.
    Refreshes right away, then every OPEN_MONTH_MAX_AGE while the server runs."""
    def loop():
        import time
        while True:
            _refresh_in_background(date.today().strftime("%Y-%m"))
            time.sleep(OPEN_MONTH_MAX_AGE)

    threading.Thread(target=loop, name="work-location-refresher", daemon=True).start()
