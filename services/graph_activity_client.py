from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .teams_auth import TeamsAuthError, get_graph_token


GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"


class GraphActivityError(RuntimeError):
    pass


class GraphActivityClient:
    def __init__(self):
        self.access_token = get_graph_token()

    def _get_csv(self, url_or_path: str, label: str) -> str:
        url = url_or_path if url_or_path.startswith("http") else f"{GRAPH_BASE_URL}{url_or_path}"
        request = Request(
            url,
            headers={
                "Accept": "text/csv",
                "Authorization": f"Bearer {self.access_token}",
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=60) as response:
                return response.read().decode("utf-8-sig")
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code in (401, 403):
                raise TeamsAuthError(
                    f"Microsoft Graph {label} returned HTTP {exc.code}. "
                    f"Check application permissions and admin consent. Response: {body}"
                ) from exc
            raise GraphActivityError(
                f"Microsoft Graph {label} failed with HTTP {exc.code}: {body}"
            ) from exc
        except URLError as exc:
            raise GraphActivityError(
                f"Unable to reach Microsoft Graph {label}: {exc.reason}"
            ) from exc
        except TimeoutError as exc:
            raise GraphActivityError(
                f"Microsoft Graph {label} timed out after 60 seconds."
            ) from exc

    def _get_json(
        self,
        url_or_path: str,
        label: str,
        extra_headers: dict | None = None,
    ) -> dict:
        url = url_or_path if url_or_path.startswith("http") else f"{GRAPH_BASE_URL}{url_or_path}"
        request = Request(
            url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.access_token}",
                **(extra_headers or {}),
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=45) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code in (401, 403):
                raise TeamsAuthError(
                    f"Microsoft Graph {label} returned HTTP {exc.code}. "
                    f"Check application permissions and admin consent. Response: {body}"
                ) from exc
            raise GraphActivityError(
                f"Microsoft Graph {label} failed with HTTP {exc.code}: {body}"
            ) from exc
        except URLError as exc:
            raise GraphActivityError(
                f"Unable to reach Microsoft Graph {label}: {exc.reason}"
            ) from exc
        except TimeoutError as exc:
            raise GraphActivityError(
                f"Microsoft Graph {label} timed out after 45 seconds."
            ) from exc
        except json.JSONDecodeError as exc:
            raise GraphActivityError(
                f"Microsoft Graph {label} returned invalid JSON."
            ) from exc

    def get_collection(
        self,
        path: str,
        label: str,
        limit: int | None = None,
        extra_headers: dict | None = None,
    ) -> list[dict]:
        rows = []
        next_url = path
        while next_url:
            payload = self._get_json(next_url, label, extra_headers=extra_headers)
            rows.extend(payload.get("value", []))
            if limit and len(rows) >= limit:
                return rows[:limit]
            next_url = payload.get("@odata.nextLink")
        return rows

    def get_users(self) -> list[dict]:
        return self.get_collection(
            "/users?$select=id,displayName,mail,userPrincipalName,mailNickname,"
            "employeeId,accountEnabled&$top=999",
            "users",
        )

    def get_groups(self) -> list[dict]:
        return self.get_collection(
            "/groups?$select=id,displayName,mail&$top=999",
            "groups",
        )

    def get_group_plans(self, group_id: str) -> list[dict]:
        return self.get_collection(
            f"/groups/{quote(group_id)}/planner/plans",
            "Planner plans",
        )

    def get_plan_tasks(self, plan_id: str) -> list[dict]:
        return self.get_collection(
            f"/planner/plans/{quote(plan_id)}/tasks?"
            "$select=id,title,percentComplete,startDateTime,dueDateTime,"
            "completedDateTime,assignments,bucketId,priority",
            "Planner tasks",
        )

    def get_calendar_view(self, user_id: str, start: str, end: str) -> list[dict]:
        query = urlencode(
            {
                "startDateTime": start,
                "endDateTime": end,
                "$select": "id,subject,start,end,organizer,isAllDay,showAs,webLink,"
                "attendees,location,onlineMeeting,bodyPreview,categories,isCancelled",
                "$top": "100",
            }
        )
        return self.get_collection(
            f"/users/{quote(user_id)}/calendar/calendarView?{query}",
            "Calendar",
            extra_headers={"Prefer": 'outlook.timezone="India Standard Time"'},
        )

    def get_sharepoint_activity_report(self, period: str = "D30") -> str:
        """Fetch SharePoint user activity report as CSV (requires Reports.Read.All permission).

        period: D7, D30, D90, or D180
        Returns CSV with per-user file views, edits, syncs, and page visits.
        """
        return self._get_csv(
            f"/reports/getSharePointActivityUserDetail(period='{period}')",
            "SharePointActivityReport",
        )

    def search_sites(self, limit: int = 100) -> list[dict]:
        return self.get_collection(
            "/sites?search=*&$select=id,displayName,webUrl,createdBy,lastModifiedDateTime",
            "SharePoint sites",
            limit=limit,
        )

    def get_site_lists(self, site_id: str, limit: int = 50) -> list[dict]:
        return self.get_collection(
            f"/sites/{quote(site_id, safe=',')}/lists?"
            "$select=id,displayName,webUrl,list&$top=50",
            "SharePoint lists",
            limit=limit,
        )

    def get_site_drive_items(self, site_id: str, limit: int = 50) -> list[dict]:
        return self.get_collection(
            f"/sites/{quote(site_id, safe=',')}/drive/root/children?"
            "$select=id,name,webUrl,size,file,folder,lastModifiedDateTime&$top=50",
            "SharePoint files",
            limit=limit,
        )
