"""Save GreytHR leave types for one or more months to data/leave/YYYY-MM.json.

Usage:
    python scripts/refresh_leave_types.py                 # previous + current month
    python scripts/refresh_leave_types.py --month 2026-08
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from services import leave_types_store  # noqa: E402


def _default_months() -> list[str]:
    today = date.today()
    prev = date(today.year - 1, 12, 1) if today.month == 1 else date(today.year, today.month - 1, 1)
    return [prev.strftime("%Y-%m"), today.strftime("%Y-%m")]


def main() -> int:
    args = sys.argv[1:]
    months = [a.split("=", 1)[1] for a in args if a.startswith("--month=")]
    for i, a in enumerate(args):
        if a == "--month" and i + 1 < len(args):
            months.append(args[i + 1])
    months = months or _default_months()

    failed = 0
    for month in months:
        try:
            payload = leave_types_store.refresh_month(month.strip())
            print(f"Leave types saved for {month}: {len(payload['people'])} people with leave or WFH")
        except Exception as exc:  # keep going so one bad month doesn't block the rest
            failed += 1
            print(f"WARNING: leave types skipped for {month}: {exc}", file=sys.stderr)
    return 1 if failed == len(months) else 0


if __name__ == "__main__":
    sys.exit(main())
