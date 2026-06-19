from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PROJECT_ROOT.parent
ENV_FILES = (WORKSPACE_ROOT / ".env", PROJECT_ROOT / ".env")
PLACEHOLDER_VALUES = {
    "PUT_TEAMS_TENANT_ID_HERE",
    "PUT_TEAMS_CLIENT_ID_HERE",
    "PUT_TEAMS_CLIENT_SECRET_HERE",
}
DEFAULT_SCOPE = "https://graph.microsoft.com/.default"


class TeamsConfigError(RuntimeError):
    pass


class TeamsAuthError(RuntimeError):
    pass


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_teams_env() -> None:
    for env_file in ENV_FILES:
        load_env_file(env_file)


def get_required_env(name: str) -> str:
    load_teams_env()
    value = os.environ.get(name, "").strip()
    if not value or value in PLACEHOLDER_VALUES:
        raise TeamsConfigError(
            f"Set {name} in .env with a real value instead of the placeholder."
        )
    return value


def get_scope() -> str:
    load_teams_env()
    return os.environ.get("TEAMS_GRAPH_SCOPE", DEFAULT_SCOPE).strip() or DEFAULT_SCOPE


def get_token() -> str:
    tenant_id = get_required_env("TEAMS_TENANT_ID")
    client_id = get_required_env("TEAMS_CLIENT_ID")
    client_secret = get_required_env("TEAMS_CLIENT_SECRET")
    scope = get_scope()

    token_url = (
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    )
    form_data = urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": scope,
        }
    ).encode("utf-8")

    # Teams access token generation happens here using only .env values.
    http_request = Request(
        token_url,
        data=form_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with urlopen(http_request, timeout=30) as response:
            body = response.read().decode("utf-8")
            data = json.loads(body) if body else {}
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 400:
            raise TeamsAuthError(
                f"Teams token request failed with HTTP 400. Check tenant, client id, secret, and scope. Response: {body}"
            ) from exc
        if exc.code == 401:
            raise TeamsAuthError(
                "Teams token request failed with HTTP 401. Check client credentials."
            ) from exc
        if exc.code == 403:
            raise TeamsAuthError(
                "Teams token request failed with HTTP 403. Application access is forbidden."
            ) from exc
        if exc.code == 404:
            raise TeamsAuthError(
                "Teams token endpoint not found. Check TEAMS_TENANT_ID."
            ) from exc
        raise TeamsAuthError(
            f"Teams token request failed with HTTP {exc.code}: {body}"
        ) from exc
    except URLError as exc:
        raise TeamsAuthError(
            f"Unable to reach Microsoft token API: {exc.reason}"
        ) from exc
    except TimeoutError as exc:
        raise TeamsAuthError("Teams token request timed out after 30 seconds.") from exc
    except json.JSONDecodeError as exc:
        raise TeamsAuthError("Teams token API returned invalid JSON.") from exc

    access_token = data.get("access_token")
    if not access_token:
        raise TeamsAuthError(
            "Teams token request succeeded but access_token was not found in the response."
        )
    return access_token
