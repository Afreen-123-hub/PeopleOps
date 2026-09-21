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
