"""Per-month cache of GreytHR leave types, used by the "Type of leaves taken" card.

Kept separate from the main attendance pipeline: nothing here touches
peopleops-data.json or data/months/*.json. Each month is stored as
data/leave/YYYY-MM.json.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from calendar import monthrange
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEAVE_DIR = PROJECT_ROOT / "data" / "leave"

# A month still in progress is re-fetched after this long; a finished month is fetched once.
OPEN_MONTH_MAX_AGE = 6 * 3600

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}


def _lock_for(month: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(month, threading.Lock())


def _cache_path(month: str) -> Path:
    return LEAVE_DIR / f"{month}.json"


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


def refresh_month(month: str) -> dict:
    """Fetch the month from GreytHR and write the cache file. Raises on GreytHR errors."""
    from services.greythr_api_client import get_leave_days

    if not _MONTH_RE.fullmatch(month):
        raise ValueError("Month must use YYYY-MM format.")
    year, mon = int(month[:4]), int(month[5:7])
    start, end = f"{month}-01", f"{month}-{monthrange(year, mon)[1]:02d}"
    days, people = get_leave_days(start, end)
    payload = {
        "month": month,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "days": days,
        "people": people,
    }
    LEAVE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _cache_path(month).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, _cache_path(month))  # atomic: readers never see a half-written file
    return payload


def get_month(month: str) -> dict:
    """Return the cached month when fresh, otherwise fetch it. If GreytHR fails, fall
    back to a stale cache when there is one rather than showing nothing."""
    if not _MONTH_RE.fullmatch(month):
        raise ValueError("Month must use YYYY-MM format.")
    cached = read_cache(month)
    if cached and _is_fresh(cached, month):
        return cached
    with _lock_for(month):
        cached = read_cache(month)  # another request may have just refreshed it
        if cached and _is_fresh(cached, month):
            return cached
        try:
            return refresh_month(month)
        except Exception:
            if cached:
                return {**cached, "stale": True}
            raise


# ---------- work from home ----------
# GreytHR has no WFH leave code for this company, so home days come from the Work location card's swipe data.
# They are added when a month is served, never written to data/leave/*.json (that folder is committed to a public repo).
_NON_LEAVE = {"P", "A", "H", "OFF", "WFH"}


def _is_home_day(rec: dict) -> bool:
    """The Work location card's own rule for "work from home", so both cards always agree: a web or mobile
    sign-in with no biometric (office door) swipe. With no swipe at all, GreytHR's own WFH label counts too,
    but a leave code on that day means leave, not home."""
    if rec.get("bi"):
        return False
    if rec.get("wi"):
        return True
    parts = [p for p in str(rec.get("s") or "").split("/") if p]
    if any(p.upper() not in _NON_LEAVE for p in parts):
        return False
    return "WFH" in parts


def with_wfh(payload: dict, month: str) -> dict:
    """Return the payload plus work-from-home days (code "WFH", 1 day each) for the month.

    Reads only what the Work location card has already cached: it never starts a GreytHR refresh (a month is
    about one call per employee). `wfh` says whether that data was there: "ready", or "unavailable" when it
    hasn't been built for this month, so the card can show "-" instead of a misleading 0."""
    out = {**payload, "wfh": "unavailable"}
    try:
        from services import work_location_store
        from services.greythr_api_client import _normalise_match_key
        cached = work_location_store.read_cache(month)
    except Exception:
        return out
    if not cached:
        out["wfh"] = _wfh_pending_state(month)  # "building" (queued or being fetched) or "unavailable" (failed just now)
        progress = _wfh_progress(month)
        if progress:
            out["wfhProgress"] = progress
        return out

    keys_by_id: dict[str, tuple[dict, list[str]]] = {}
    for person in cached.get("people") or []:
        emp_id = str(person.get("id") or "").strip()
        keys: list[str] = []
        for key in (emp_id, str(person.get("no") or "").strip(), "name:" + _normalise_match_key(person.get("name", ""))):
            if key and key != "name:" and key not in keys:
                keys.append(key)
        if emp_id and keys:
            keys_by_id[emp_id] = (person, keys)

    home: dict[str, set[str]] = {}
    for day, recs in (cached.get("days") or {}).items():
        for emp_id, rec in (recs or {}).items():
            if emp_id in keys_by_id and _is_home_day(rec or {}):
                home.setdefault(emp_id, set()).add(day)

    days = dict(payload.get("days") or {})  # new outer dict; the cached payload itself is never modified
    people = list(payload.get("people") or [])
    known = {k for p in people for k in p.get("keys", [])}
    for emp_id, dates in home.items():
        person, keys = keys_by_id[emp_id]
        base = next((days[k] for k in keys if k in days), {})
        merged = {d: dict(codes) for d, codes in base.items()}
        for d in dates:
            merged.setdefault(d, {})["WFH"] = 1.0
        for key in keys:
            days[key] = merged
        if not any(k in known for k in keys):  # home days only: still list them so "people not in the dashboard" can find them
            people.append({"name": person.get("name") or emp_id, "no": person.get("no", ""), "keys": keys})
            known.update(keys)
    out.update(days=days, people=people, wfh="ready", wfhAsOf=cached.get("fetchedAt"))
    return out


# ---------- building older months' work-from-home data ----------
# The Work location card only keeps the current month warm. For any other month the swipes have to be fetched from
# GreytHR (about one call per employee, ~40s a month). Do that here, ONE month at a time and never while the card's own
# refresher is running (GreytHR slows down when several months are fetched at once), so opening a person's history
# fills in every month by itself. The result lives in the Work location card's own cache (data/worklocation/, never
# committed); on Render that folder is emptied on each restart, so months are simply rebuilt when they are next opened.
WFH_RETRY_AFTER = 600          # after a failed build, don't try that month again for 10 minutes
_wfh_lock = threading.Lock()
_wfh_queue: list[str] = []     # months waiting to be built, in the order they were asked for
_wfh_current: str | None = None
_wfh_failed: dict[str, float] = {}
_wfh_worker_running = False


def _wfh_progress(month: str):
    """[employees fetched, total] while that month is being fetched, else None."""
    try:
        from services import work_location_store
        done, total = work_location_store._progress.get(month, (0, 0))
        return [done, total] if total else None
    except Exception:
        return None


def _wfh_worker() -> None:
    global _wfh_current, _wfh_worker_running
    while True:
        with _wfh_lock:
            if not _wfh_queue:
                _wfh_worker_running = False
                _wfh_current = None
                return
            month = _wfh_queue.pop(0)
            _wfh_current = month
        try:
            from services import work_location_store as wl
            waited = 0
            while getattr(wl, "_refreshing", None) and waited < 900:  # the card's own refresher is busy: wait for it
                time.sleep(2)
                waited += 2
            if wl.read_cache(month) is None:
                wl.refresh_month(month)
                print(f"[leave-types] work-from-home data built for {month}", flush=True)
        except Exception as exc:
            with _wfh_lock:
                _wfh_failed[month] = time.time()
            print(f"[leave-types] work-from-home build for {month} failed: {type(exc).__name__}: {exc}", flush=True)
        finally:
            with _wfh_lock:
                _wfh_current = None


def _wfh_pending_state(month: str) -> str:
    """Queue the month for building (once) and report "building", or "unavailable" if it just failed."""
    global _wfh_worker_running
    with _wfh_lock:
        failed = _wfh_failed.get(month)
        if failed and time.time() - failed < WFH_RETRY_AFTER:
            return "unavailable"
        if month != _wfh_current and month not in _wfh_queue:
            _wfh_queue.append(month)
        if not _wfh_worker_running:
            _wfh_worker_running = True
            threading.Thread(target=_wfh_worker, name="wfh-builder", daemon=True).start()
    return "building"


def wfh_statuses(months: list[str]) -> dict[str, dict]:
    """{month: {"wfh": "ready" | "building" | "unavailable", "progress": [done, total]?}}, small and cheap, so the
    card can check on months that are being built without downloading them again."""
    out: dict[str, dict] = {}
    try:
        from services import work_location_store
    except Exception:
        return {m: {"wfh": "unavailable"} for m in months if _MONTH_RE.fullmatch(m)}
    for month in months[:24]:
        if not _MONTH_RE.fullmatch(month):
            continue
        if work_location_store.read_cache(month):
            out[month] = {"wfh": "ready"}
            continue
        state = _wfh_pending_state(month)
        out[month] = {"wfh": state}
        progress = _wfh_progress(month)
        if progress:
            out[month]["progress"] = progress
    return out
