from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from services.worklogix_api_client import WorklogixApiClient
from services.worklogix_auth import login
from services.worklogix_api_client import WorklogixAuthError
from services.worklogix_transformer import extract_rows


def print_preview(label, rows):
    print(f"{label} success")
    print(f"{label} row count: {len(rows)}")
    print(f"{label} first sample record: {rows[0] if rows else {}}")


def first_employee_user_id(rows):
    for row in rows:
        if isinstance(row, dict):
            for key in ("user_id", "id", "employee_id", "emp_id", "code"):
                value = row.get(key)
                if value not in (None, ""):
                    return str(value)
    return ""


def main():
    try:
        token = login()
        if not token:
            raise RuntimeError("jwt_token was not returned")
        print("login success")

        client = WorklogixApiClient()

        employees = extract_rows(client.get_worklogix_employees())
        if not employees:
            raise RuntimeError("employee API returned no rows")
        print_preview("employee API fetch", employees)
        user_id = first_employee_user_id(employees)
        if not user_id:
            raise RuntimeError("employee API did not include a usable user_id")

        tasks = extract_rows(client.get_worklogix_tasks())
        if not tasks:
            raise RuntimeError("task API returned no rows")
        print_preview("task API fetch", tasks)

        daily_updates = extract_rows(client.get_worklogix_daily_updates())
        if not daily_updates:
            raise RuntimeError("daily update API returned no rows")
        print_preview("daily update API fetch", daily_updates)

        sample_month = "2026-06"
        try:
            monthly_updates = extract_rows(
                client.get_worklogix_monthly_updates(sample_month, user_id)
            )
            print("monthly update API tested with month and user_id")
            print(f"monthly update API row count: {len(monthly_updates)}")
            if monthly_updates:
                print(f"monthly update API first sample record: {monthly_updates[0]}")
            else:
                print(
                    "monthly update API returned no data for the selected month and user_id"
                )
        except WorklogixAuthError as exc:
            if "403" in str(exc):
                print("monthly update API skipped due to permission issue")
            else:
                raise

        print("Worklogix API integration successful with available endpoints")
    except Exception as exc:
        raise SystemExit(f"FAIL Worklogix API test: {exc}") from exc


if __name__ == "__main__":
    main()
