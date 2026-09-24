"""Save where each employee worked (office / home) for one or more months to data/worklocation/YYYY-MM.json.

Usage:
    python scripts/refresh_work_location.py                 # current month
    python scripts/refresh_work_location.py --month 2026-08
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from services import work_location_store  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    months = [a.split("=", 1)[1] for a in args if a.startswith("--month=")]
    for i, a in enumerate(args):
        if a == "--month" and i + 1 < len(args):
            months.append(args[i + 1])
    months = months or [date.today().strftime("%Y-%m")]

    failed = 0
    for month in months:
        try:
            payload = work_location_store.refresh_month(month.strip())
            missing = len(payload.get("missing") or [])
            print(f"Work location saved for {month}: {len(payload['people'])} people, "
                  f"{len(payload['days'])} days" + (f", {missing} without swipe data" if missing else ""))
        except Exception as exc:  # keep going so one bad month doesn't block the rest
            failed += 1
            print(f"WARNING: work location skipped for {month}: {exc}", file=sys.stderr)
    return 1 if failed == len(months) else 0


if __name__ == "__main__":
    sys.exit(main())
