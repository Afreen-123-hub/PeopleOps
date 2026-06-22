from __future__ import annotations

import base64
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PROJECT_ROOT.parent
ENV_FILES = (WORKSPACE_ROOT / ".env", PROJECT_ROOT / ".env")
PLACEHOLDER_VALUES = {
    "PUT_GREYTHR_USERNAME_HERE",
    "PUT_GREYTHR_PASSWORD_HERE",
    "PUT_GREYTHR_DOMAIN_HERE",
}


class GreytHRConfigError(RuntimeError):
    pass


class GreytHRAuthError(RuntimeError):
    pass


class GreytHRApiError(RuntimeError):
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


def load_greythr_env() -> None:
    for env_file in ENV_FILES:
        load_env_file(env_file)


def get_required_env(name: str) -> str:
    load_greythr_env()
    value = os.environ.get(name, "").strip()
    if not value or value in PLACEHOLDER_VALUES:
        raise GreytHRConfigError(f"Set {name} in .env with a real value.")
    return value


def _get_token(domain: str, username: str, password: str) -> str:
    token_url = f"https://{domain}/uas/v1/oauth2/client-token"
    credentials = base64.b64encode(f"{username}:{password}".encode()).decode()
    req = Request(
        token_url,
        data=b"",
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise GreytHRAuthError(f"GreytHR token failed HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise GreytHRAuthError(f"GreytHR unreachable: {exc.reason}") from exc
    token = data.get("access_token")
    if not token:
        raise GreytHRAuthError("GreytHR token response missing access_token")
    return token


def _api_get(url: str, token: str, domain: str, params: dict | None = None) -> dict:
    if params:
        url = f"{url}?{urlencode(params)}"
    req = Request(url, headers={"ACCESS-TOKEN": token, "x-greythr-domain": domain})
    try:
        with urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise GreytHRApiError(f"GreytHR API HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise GreytHRApiError(f"GreytHR API unreachable: {exc.reason}") from exc


def get_greythr_attendance(start: str, end: str) -> dict[str, Counter]:
    """Return {employeeNo: Counter(label: count)} for the given date range.

    Labels from GreytHR session1Label: P=Present, A=Absent, H=Holiday,
    OFF=WeekOff, WO=WeekOff, CL/SL/EL/LOP/ML/PL/CO=leave types.
    """
    domain = get_required_env("GREYTHR_DOMAIN")
    username = get_required_env("GREYTHR_USERNAME")
    password = get_required_env("GREYTHR_PASSWORD")
    token = _get_token(domain, username, password)

    emp_no_map: dict[str, str] = {}
    page = 0
    while True:
        data = _api_get(
            "https://api.greythr.com/employee/v2/employees",
            token,
            domain,
            params={"page": page, "size": 25},
        )
        for emp in data.get("data", []):
            if emp.get("leftorg"):
                continue
            emp_id = str(emp.get("employeeId", "")).strip()
            emp_no = str(emp.get("employeeNo", "")).strip()
            if emp_id and emp_no:
                emp_no_map[emp_id] = emp_no
        if not data.get("pages", {}).get("hasNext"):
            break
        page += 1

    muster = _api_get(
        "https://api.greythr.com/attendance/v2/employee/muster",
        token,
        domain,
        params={"start": start, "end": end},
    )

    result: dict[str, Counter] = defaultdict(Counter)
    for emp in muster.get("data", []):
        emp_id = str(emp.get("employeeId", "")).strip()
        emp_no = emp_no_map.get(emp_id, "").strip()
        if not emp_no:
            continue
        for rec in emp.get("records", []):
            label = rec.get("summary", {}).get("session1Label", "") or "Blank"
            result[emp_no][label] += 1

    return result
