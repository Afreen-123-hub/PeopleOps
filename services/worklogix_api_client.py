



from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .worklogix_auth import WorklogixAuthError, login, worklogix_base_url


class WorklogixApiError(RuntimeError):
    pass


class WorklogixApiClient:
    ENDPOINTS = {
        "employees": "/api/v1/users/list_employee",
        "employee_info": "/api/v1/users/list_employee_info",
        "tasks": "/api/v1/tasks/get_all_task",
        "daily_updates": "/api/v1/reports/daily-update",
        "monthly_updates": "/api/v1/reports/monthly-update",
        "projects": "/api/v1/projects/get_all_projects",
        "teams": "/api/v1/teams",

    }

    def __init__(self):
        self.base_url = worklogix_base_url()
        self.jwt_token = login()

    def get_json(self, endpoint_name: str):
        if endpoint_name not in self.ENDPOINTS:
            raise WorklogixApiError(f"Unknown endpoint: {endpoint_name}")

        path = self.ENDPOINTS[endpoint_name]
        return self.get_json_by_path(path, endpoint_name)

    def get_json_by_path(self, path: str, endpoint_name: str | None = None):
        label = endpoint_name or path
        url = f"{self.base_url}{path}"

        http_request = Request(
            url,
            headers={
                "Accept": "application/json",
                # The JWT token from login() is used in all Worklogix GET requests here.
                "Authorization": f"Bearer {self.jwt_token}",
            },
            method="GET",
        )

        try:
            with urlopen(http_request, timeout=30) as response:
                body = response.read().decode("utf-8")

                if not body.strip():
                    raise WorklogixApiError(
                        f"Worklogix {label} API returned empty response."
                    )

                return json.loads(body)

        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")

            if exc.code == 401:
                raise WorklogixAuthError(
                    f"Worklogix {label} API returned 401. Check JWT token."
                ) from exc

            if exc.code == 403:
                raise WorklogixAuthError(
                    f"Worklogix {label} API returned 403. No access permission."
                ) from exc

            if exc.code == 404:
                raise WorklogixApiError(
                    f"Worklogix {label} endpoint not found: {path}"
                ) from exc

            if exc.code == 422:
                raise WorklogixApiError(
                    f"Worklogix {label} API returned 422. Check required query parameters. Response: {body}"
                ) from exc

            raise WorklogixApiError(
                f"Worklogix {label} API failed with HTTP {exc.code}: {body}"
            ) from exc

        except URLError as exc:
            raise WorklogixApiError(
                f"Unable to reach Worklogix {label} API: {exc.reason}"
            ) from exc

        except TimeoutError as exc:
            raise WorklogixApiError(
                f"Worklogix {label} API timed out after 30 seconds."
            ) from exc

        except json.JSONDecodeError as exc:
            raise WorklogixApiError(
                f"Worklogix {label} API returned invalid JSON."
            ) from exc

    def fetch_all(self):
        return {
            name: self.get_json(name)
            for name in self.ENDPOINTS
        }

    def get_worklogix_employees(self):
        return self.get_json("employees")

    def get_worklogix_employee_info(self):
        return self.get_json("employee_info")

    def get_worklogix_tasks(self):
        return self.get_json("tasks")

    def get_worklogix_daily_updates(self):
        return self.get_json("daily_updates")

    def get_worklogix_monthly_updates(self, month: str, user_id: str):
        query = urlencode({"month": month, "user_id": user_id})
        path = f"{self.ENDPOINTS['monthly_updates']}?{query}"
        return self.get_json_by_path(path, "monthly_updates")

    def get_worklogix_projects(self):
        return self.get_json("projects")

    def get_worklogix_teams(self):
        return self.get_json("teams")

    def get_worklogix_employee_presence_report(
        self,
        report_date: str | None = None,
        user_id: str | None = None,
        location: str | None = None,
        min_duration: int | None = None,
        month: str | None = None,
    ):
        query_params = {}

        if report_date:
            query_params["report_date"] = report_date
        if user_id:
            query_params["user_id"] = user_id
        if location:
            query_params["location"] = location
        if min_duration is not None:
            query_params["min_duration"] = min_duration
        if month:
            query_params["month"] = month

        query = urlencode(query_params)
        path = "/api/v1/users/employee_presence_report"
        if query:
            path = f"{path}?{query}"

        return self.get_json_by_path(path, "employee_presence_report")

def get_worklogix_employees():
    return WorklogixApiClient().get_worklogix_employees()


def get_worklogix_employee_info():
    return WorklogixApiClient().get_worklogix_employee_info()


def get_worklogix_tasks():
    return WorklogixApiClient().get_worklogix_tasks()


def get_worklogix_daily_updates():
    return WorklogixApiClient().get_worklogix_daily_updates()


def get_worklogix_monthly_updates(month: str, user_id: str):
    return WorklogixApiClient().get_worklogix_monthly_updates(month, user_id)


def get_worklogix_projects():
    return WorklogixApiClient().get_worklogix_projects()


def get_worklogix_teams():
    return WorklogixApiClient().get_worklogix_teams()

def get_worklogix_employee_presence_report(
    report_date: str | None = None,
    user_id: str | None = None,
    location: str | None = None,
    min_duration: int | None = None,
    month: str | None = None,
):
    return WorklogixApiClient().get_worklogix_employee_presence_report(
        report_date=report_date,
        user_id=user_id,
        location=location,
        min_duration=min_duration,
        month=month,
    )
