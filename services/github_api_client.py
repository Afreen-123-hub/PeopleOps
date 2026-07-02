from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
GITHUB_REST_URL    = "https://api.github.com"
GITHUB_ORG         = "CodeWork-ai"

ENV_FILES = (
    Path(__file__).resolve().parents[3] / ".env",
    Path(__file__).resolve().parents[2] / ".env",
)


class GitHubApiError(RuntimeError):
    pass


def _load_env() -> None:
    for path in ENV_FILES:
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _get_token() -> str:
    _load_env()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        raise GitHubApiError("GITHUB_TOKEN not set in .env")
    return token


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_get_token()}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _graphql(query: str) -> dict:
    payload = json.dumps({"query": query}).encode("utf-8")
    req = Request(GITHUB_GRAPHQL_URL, data=payload, headers=_headers(), method="POST")
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if "errors" in result:
                raise GitHubApiError(f"GraphQL errors: {result['errors']}")
            return result.get("data", {})
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise GitHubApiError(f"GitHub GraphQL HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise GitHubApiError(f"GitHub unreachable: {exc.reason}") from exc


def _rest_get(path: str) -> dict | list:
    url = f"{GITHUB_REST_URL}{path}"
    req = Request(url, headers=_headers(), method="GET")
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise GitHubApiError(f"GitHub REST HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise GitHubApiError(f"GitHub unreachable: {exc.reason}") from exc


# ── GraphQL fragments ────────────────────────────────────────────────────────

_ITEMS_QUERY = """
{{
  organization(login: "{org}") {{
    projectV2(number: {number}) {{
      title
      items(first: 100) {{
        nodes {{
          type
          content {{
            ... on Issue {{
              title
              state
              url
              createdAt
              closedAt
              assignees(first: 5) {{ nodes {{ login name }} }}
            }}
            ... on PullRequest {{
              title
              state
              url
              createdAt
              closedAt
              assignees(first: 5) {{ nodes {{ login name }} }}
            }}
            ... on DraftIssue {{
              title
              createdAt
              assignees(first: 5) {{ nodes {{ login name }} }}
            }}
          }}
          fieldValues(first: 15) {{
            nodes {{
              ... on ProjectV2ItemFieldSingleSelectValue {{
                name
                field {{ ... on ProjectV2SingleSelectField {{ name }} }}
              }}
              ... on ProjectV2ItemFieldTextValue {{
                text
                field {{ ... on ProjectV2Field {{ name }} }}
              }}
              ... on ProjectV2ItemFieldDateValue {{
                date
                field {{ ... on ProjectV2Field {{ name }} }}
              }}
            }}
          }}
        }}
      }}
    }}
  }}
}}
"""


def _parse_item(node: dict) -> dict | None:
    content = node.get("content")
    if not content:
        return None

    title    = content.get("title", "Untitled")
    state    = content.get("state", "")
    url      = content.get("url", "")
    created  = content.get("createdAt", "")
    closed   = content.get("closedAt", "")
    assignees = [
        a.get("name") or a.get("login", "")
        for a in content.get("assignees", {}).get("nodes", [])
        if a.get("login")
    ]

    status   = ""
    priority = ""
    size     = ""
    start    = ""
    end      = ""

    for fv in node.get("fieldValues", {}).get("nodes", []):
        if not fv:
            continue
        field_name = (fv.get("field") or {}).get("name", "")
        if field_name == "Status":
            status = fv.get("name", "")
        elif field_name == "Priority":
            priority = fv.get("name", "")
        elif field_name == "Size":
            size = fv.get("name", "")
        elif field_name == "Start date":
            start = fv.get("date", "")
        elif field_name == "End date":
            end = fv.get("date", "")

    if not status:
        if state == "CLOSED":
            status = "Done"
        elif state == "OPEN":
            status = "In Progress"
        else:
            status = "Todo"

    return {
        "title":     title,
        "status":    status,
        "priority":  priority,
        "size":      size,
        "assignees": assignees,
        "state":     state,
        "url":       url,
        "createdAt": created,
        "closedAt":  closed,
        "startDate": start,
        "endDate":   end,
    }


def _project_stats(items: list[dict]) -> dict:
    stats = {"total": len(items), "done": 0, "inProgress": 0, "todo": 0, "backlog": 0, "production": 0}
    for item in items:
        s = (item.get("status") or "").lower()
        if s == "done":
            stats["done"] += 1
        elif s in ("in progress",):
            stats["inProgress"] += 1
        elif s == "todo":
            stats["todo"] += 1
        elif s == "backlog":
            stats["backlog"] += 1
        elif s == "production":
            stats["production"] += 1
    return stats


def fetch_all_projects() -> list[dict]:
    # Step 1 — get all project numbers (include closed flag to filter client-side)
    data = _graphql(f"""
    {{
      organization(login: "{GITHUB_ORG}") {{
        projectsV2(first: 50) {{
          nodes {{ number title closed }}
        }}
      }}
    }}
    """)
    all_nodes = data.get("organization", {}).get("projectsV2", {}).get("nodes", [])
    # Only open projects; skip personal/untitled boards (title starts with "@")
    project_list = [
        p for p in all_nodes
        if not p.get("closed", False) and not p.get("title", "").startswith("@")
    ]

    projects = []
    for proj in project_list:
        number = proj["number"]
        try:
            detail = _graphql(_ITEMS_QUERY.format(org=GITHUB_ORG, number=number))
            pv2 = detail.get("organization", {}).get("projectV2") or {}
            raw_items = pv2.get("items", {}).get("nodes", [])
            items = [i for i in (_parse_item(n) for n in raw_items) if i]
            projects.append({
                "number": number,
                "title":  proj["title"],
                "items":  items,
                "stats":  _project_stats(items),
            })
        except GitHubApiError:
            # Still include the project but with no items so it appears in the UI
            projects.append({
                "number": number,
                "title":  proj["title"],
                "items":  [],
                "stats":  _project_stats([]),
            })

    return projects


def fetch_commits_per_contributor(repos: list[str], since: str = "", until: str = "") -> dict[str, int]:
    counts: dict[str, int] = {}
    date_params = ""
    if since:
        date_params += f"&since={since}"
    if until:
        date_params += f"&until={until}"
    for repo in repos:
        try:
            page = 1
            while True:
                commits = _rest_get(
                    f"/repos/{GITHUB_ORG}/{repo}/commits?per_page=100&page={page}{date_params}"
                )
                if not isinstance(commits, list) or not commits:
                    break
                for c in commits:
                    login = (c.get("author") or {}).get("login", "")
                    if login:
                        counts[login] = counts.get(login, 0) + 1
                if len(commits) < 100:
                    break
                page += 1
        except GitHubApiError:
            continue
    return counts


def fetch_prs_per_contributor(repos: list[str], since: str = "", until: str = "") -> dict[str, dict]:
    """Returns {login: {"prs": int, "merged": int}} filtered to the given period."""
    since_date = since[:10] if since else ""
    until_date = until[:10] if until else ""
    counts: dict[str, dict] = {}
    for repo in repos:
        try:
            prs = _rest_get(
                f"/repos/{GITHUB_ORG}/{repo}/pulls?state=all&per_page=100"
            )
            if not isinstance(prs, list):
                continue
            for pr in prs:
                login = (pr.get("user") or {}).get("login", "")
                if not login:
                    continue
                created  = (pr.get("created_at") or "")[:10]
                merged_at = (pr.get("merged_at") or "")[:10]
                in_period = (
                    (not since_date or created >= since_date) and
                    (not until_date or created <= until_date)
                )
                if in_period:
                    if login not in counts:
                        counts[login] = {"prs": 0, "merged": 0}
                    counts[login]["prs"] += 1
                    if merged_at and (not since_date or merged_at >= since_date) and (not until_date or merged_at <= until_date):
                        counts[login]["merged"] += 1
        except GitHubApiError:
            continue
    return counts


def fetch_loc_per_contributor(repos: list[str], since_ts: int, until_ts: int) -> dict[str, dict]:
    """Lines of code added/deleted per contributor using GitHub weekly contributor stats.
    since_ts / until_ts are Unix timestamps (start of week granularity).
    Returns: {login: {"additions": int, "deletions": int}}
    """
    import time
    counts: dict[str, dict] = {}
    for repo in repos:
        try:
            stats = None
            for _ in range(3):
                raw = _rest_get(f"/repos/{GITHUB_ORG}/{repo}/stats/contributors")
                if isinstance(raw, list):
                    stats = raw
                    break
                time.sleep(2)
            if not stats:
                continue
            for contributor in stats:
                login = (contributor.get("author") or {}).get("login", "")
                if not login:
                    continue
                for week in contributor.get("weeks", []):
                    w = week.get("w", 0)
                    if since_ts <= w <= until_ts:
                        if login not in counts:
                            counts[login] = {"additions": 0, "deletions": 0}
                        counts[login]["additions"] += week.get("a", 0)
                        counts[login]["deletions"] += week.get("d", 0)
        except GitHubApiError:
            continue
    return counts


def fetch_org_repos() -> list[str]:
    try:
        repos = _rest_get(f"/orgs/{GITHUB_ORG}/repos?per_page=100&type=all")
        if isinstance(repos, list):
            return [r["name"] for r in repos if not r.get("archived")]
    except GitHubApiError:
        pass
    return []


def build_github_data(since: str = "", until: str = "") -> dict:
    import datetime, calendar

    # Default to previous full month if no period given
    if not since or not until:
        now = datetime.datetime.utcnow()
        year, month = now.year, now.month - 1
        if month == 0:
            month, year = 12, year - 1
        last_day = calendar.monthrange(year, month)[1]
        since = f"{year}-{month:02d}-01T00:00:00Z"
        until = f"{year}-{month:02d}-{last_day}T23:59:59Z"

    since_ts = int(datetime.datetime.strptime(since[:10], "%Y-%m-%d").timestamp())
    until_ts = int(datetime.datetime.strptime(until[:10], "%Y-%m-%d").timestamp())

    print(f"Fetching GitHub data for {since[:10]} to {until[:10]}...")
    projects = fetch_all_projects()
    repos    = fetch_org_repos()
    commits  = fetch_commits_per_contributor(repos, since, until)
    prs      = fetch_prs_per_contributor(repos, since, until)
    loc      = fetch_loc_per_contributor(repos, since_ts, until_ts)

    # Build contributor summary from project assignees
    contrib_map: dict[str, dict] = {}
    for proj in projects:
        for item in proj["items"]:
            for assignee in item["assignees"]:
                if assignee not in contrib_map:
                    pr_data  = prs.get(assignee, {})
                    loc_data = loc.get(assignee, {})
                    contrib_map[assignee] = {
                        "login":      assignee,
                        "projects":   [],
                        "tasks":      [],
                        "total":      0,
                        "done":       0,
                        "inProgress": 0,
                        "commits":    commits.get(assignee, 0),
                        "prs":        pr_data.get("prs", 0),
                        "prsMerged":  pr_data.get("merged", 0),
                        "additions":  loc_data.get("additions", 0),
                        "deletions":  loc_data.get("deletions", 0),
                    }
                c = contrib_map[assignee]
                if proj["title"] not in c["projects"]:
                    c["projects"].append(proj["title"])
                c["tasks"].append({
                    "project":  proj["title"],
                    "title":    item["title"],
                    "status":   item["status"],
                    "priority": item["priority"],
                })
                c["total"] += 1
                s = (item["status"] or "").lower()
                if s == "done":
                    c["done"] += 1
                elif s == "in progress":
                    c["inProgress"] += 1

    # Add contributors who only have commits/PRs (no project tasks)
    for login, count in commits.items():
        if login not in contrib_map:
            pr_data  = prs.get(login, {})
            loc_data = loc.get(login, {})
            contrib_map[login] = {
                "login": login, "projects": [], "tasks": [],
                "total": 0, "done": 0, "inProgress": 0,
                "commits":   count,
                "prs":       pr_data.get("prs", 0),
                "prsMerged": pr_data.get("merged", 0),
                "additions": loc_data.get("additions", 0),
                "deletions": loc_data.get("deletions", 0),
            }

    return {
        "lastUpdated": datetime.datetime.utcnow().isoformat() + "Z",
        "period":      {"since": since[:10], "until": until[:10]},
        "org":         GITHUB_ORG,
        "projects":    projects,
        "contributors": sorted(
            contrib_map.values(),
            key=lambda c: c["commits"] + c["total"],
            reverse=True,
        ),
    }
