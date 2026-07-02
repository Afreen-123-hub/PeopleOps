from __future__ import annotations

import argparse
import calendar
import json
import sys
from pathlib import Path

PROJECT   = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT / "data" / "github-data.json"
sys.path.insert(0, str(PROJECT))

from services.github_api_client import GitHubApiError, build_github_data


def refresh(month: str = ""):
    since = until = ""
    if month:
        try:
            year, m = map(int, month.split("-"))
            last_day = calendar.monthrange(year, m)[1]
            since = f"{year}-{m:02d}-01T00:00:00Z"
            until = f"{year}-{m:02d}-{last_day}T23:59:59Z"
        except ValueError:
            print(f"ERROR: Invalid month format '{month}' — expected YYYY-MM")
            sys.exit(1)

    try:
        data = build_github_data(since=since, until=until)
    except GitHubApiError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    proj_count    = len(data.get("projects", []))
    contrib_count = len(data.get("contributors", []))
    period        = data.get("period", {})
    print(f"GitHub data saved: {proj_count} projects, {contrib_count} contributors "
          f"({period.get('since','')} to {period.get('until','')})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Refresh GitHub data for a given month")
    parser.add_argument("--month", default="", help="Month to fetch (YYYY-MM). Defaults to previous month.")
    args = parser.parse_args()
    refresh(month=args.month)
