from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .teams_auth import TeamsAuthError, get_token


GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


class TeamsApiError(RuntimeError):
    pass


class TeamsApiClient:
    def __init__(self):
        self.access_token = get_token()

    def _headers(self, accept="application/json"):
        return {
            "Accept": accept,
            "Authorization": f"Bearer {self.access_token}",
        }

    def _handle_http_error(self, exc: HTTPError, label: str):
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 401:
            raise TeamsAuthError(f"Teams {label} API returned 401. Check the access token.") from exc
        if exc.code == 403:
            raise TeamsAuthError(f"Teams {label} API returned 403. App does not have permission.") from exc
        if exc.code == 404:
            raise TeamsApiError(f"Teams {label} endpoint not found.") from exc
        if exc.code == 400:
            raise TeamsApiError(f"Teams {label} API returned 400. Response: {body}") from exc
        raise TeamsApiError(f"Teams {label} API failed with HTTP {exc.code}: {body}") from exc

    def post_json(self, path: str, payload: dict, label: str):
        url = f"{GRAPH_BASE_URL}{path}"
        http_request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={**self._headers(), "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(http_request, timeout=30) as response:
                body = response.read().decode("utf-8")
                if not body.strip():
                    raise TeamsApiError(f"Teams {label} API returned empty response.")
                return json.loads(body)
        except HTTPError as exc:
            self._handle_http_error(exc, label)
        except URLError as exc:
            raise TeamsApiError(f"Unable to reach Teams {label} API: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TeamsApiError(f"Teams {label} API timed out after 30 seconds.") from exc
        except json.JSONDecodeError as exc:
            raise TeamsApiError(f"Teams {label} API returned invalid JSON.") from exc

    def get_json(self, path: str, label: str):
        url = f"{GRAPH_BASE_URL}{path}"
        http_request = Request(url, headers=self._headers(), method="GET")
        try:
            with urlopen(http_request, timeout=30) as response:
                body = response.read().decode("utf-8")
                if not body.strip():
                    raise TeamsApiError(f"Teams {label} API returned empty response.")
                return json.loads(body)
        except HTTPError as exc:
            self._handle_http_error(exc, label)
        except URLError as exc:
            raise TeamsApiError(f"Unable to reach Teams {label} API: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TeamsApiError(f"Teams {label} API timed out after 30 seconds.") from exc
        except json.JSONDecodeError as exc:
            raise TeamsApiError(f"Teams {label} API returned invalid JSON.") from exc

    def get_csv(self, path: str, label: str) -> str:
        url = f"{GRAPH_BASE_URL}{path}"
        http_request = Request(url, headers=self._headers(accept="text/csv"), method="GET")
        try:
            with urlopen(http_request, timeout=60) as response:
                return response.read().decode("utf-8-sig")
        except HTTPError as exc:
            self._handle_http_error(exc, label)
        except URLError as exc:
            raise TeamsApiError(f"Unable to reach Teams {label} API: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TeamsApiError(f"Teams {label} API timed out after 60 seconds.") from exc

    def get_presences_by_user_id(self, ids: list[str]):
        if not ids:
            raise TeamsApiError("At least one Teams user id is required.")
        return self.post_json(
            "/communications/getPresencesByUserId",
            {"ids": ids},
            "getPresencesByUserId",
        )

    def get_activity_report(self, period: str = "D30") -> str:
        """Fetch Teams user activity report as CSV (requires Reports.Read.All permission).

        period: D7, D30, D90, or D180
        Returns CSV text with per-user message counts, call/meeting counts, audio/video hours.
        """
        return self.get_csv(
            f"/reports/getTeamsUserActivityUserDetail(period='{period}')",
            "TeamsActivityReport",
        )

    def get_users(self, select: str = "id,userPrincipalName,displayName,mail,mailNickname,employeeId,accountEnabled") -> list[dict]:
        """Fetch all Azure AD users (requires User.Read.All permission)."""
        users = []
        path = f"/users?$select={select}&$top=999"
        while path:
            data = self.get_json(path, "users")
            users.extend(data.get("value", []))
            next_link = data.get("@odata.nextLink", "")
            path = next_link.replace(GRAPH_BASE_URL, "") if next_link else None
        return users

    def get_users_with_manager(self) -> list[dict]:
        """Fetch all Azure AD users with their manager expanded (User.Read.All — no extra permissions needed)."""
        select = "id,userPrincipalName,displayName,mail,mailNickname,employeeId,accountEnabled,jobTitle,department"
        users = []
        path = f"/users?$select={select}&$expand=manager($select=id,displayName,mail,userPrincipalName)&$top=999"
        while path:
            data = self.get_json(path, "usersWithManager")
            users.extend(data.get("value", []))
            next_link = data.get("@odata.nextLink", "")
            path = next_link.replace(GRAPH_BASE_URL, "") if next_link else None
        return users

    def get_direct_reports(self, user_id: str) -> list[dict]:
        """Fetch direct reports for a given Azure AD user (User.Read.All)."""
        select = "id,displayName,mail,userPrincipalName,jobTitle,department"
        try:
            data = self.get_json(f"/users/{user_id}/directReports?$select={select}", "directReports")
            return data.get("value", [])
        except (TeamsApiError, TeamsAuthError):
            return []


def get_presences_by_user_id(ids: list[str]):
    return TeamsApiClient().get_presences_by_user_id(ids)


def get_teams_activity_report(period: str = "D30") -> str:
    return TeamsApiClient().get_activity_report(period)


def get_teams_users() -> list[dict]:
    return TeamsApiClient().get_users()


def get_teams_users_with_manager() -> list[dict]:
    return TeamsApiClient().get_users_with_manager()


def get_teams_direct_reports(user_id: str) -> list[dict]:
    return TeamsApiClient().get_direct_reports(user_id)
