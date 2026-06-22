from __future__ import annotations

import base64
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


# ==========================
# CONFIGURATION
# ==========================

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PROJECT_ROOT.parent
ENV_FILES = (WORKSPACE_ROOT / ".env", PROJECT_ROOT / ".env")
PLACEHOLDER_VALUES = {
    "PUT_GREYTHR_USERNAME_HERE",
    "PUT_GREYTHR_PASSWORD_HERE",
    "PUT_GREYTHR_DOMAIN_HERE",
}

API_BASE = "https://api.greythr.com"


class GreytHRConfigError(RuntimeError):
    pass


class GreytHRAuthError(RuntimeError):
    pass


class GreytHRApiError(RuntimeError):
    pass


# ==========================
# AUTH HELPERS
# ==========================

def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _load_greythr_env() -> None:
    for env_file in ENV_FILES:
        _load_env_file(env_file)


def _get_required_env(name: str) -> str:
    _load_greythr_env()
    value = os.environ.get(name, "").strip()
    if not value or value in PLACEHOLDER_VALUES:
        raise GreytHRConfigError(f"Set {name} in .env with a real value.")
    return value


def get_token() -> tuple[str, str]:
    """Return (access_token, domain) using credentials from .env."""
    domain = _get_required_env("GREYTHR_DOMAIN")
    username = _get_required_env("GREYTHR_USERNAME")
    password = _get_required_env("GREYTHR_PASSWORD")
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
    return token, domain


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


# ==========================
# EMPLOYEE MASTER
# ==========================

def get_employee_master(token: str, domain: str) -> dict[str, dict]:
    """Return {employeeId: {employee_no, name, date_of_joining}} for active employees."""
    employees = {}
    page = 0
    while True:
        data = _api_get(
            f"{API_BASE}/employee/v2/employees",
            token,
            domain,
            params={"page": page, "size": 25},
        )
        for emp in data.get("data", []):
            if emp.get("leftorg"):
                continue
            emp_id = str(emp.get("employeeId", "")).strip()
            if not emp_id:
                continue
            employees[emp_id] = {
                "employee_no": str(emp.get("employeeNo", "")).strip(),
                "name": str(emp.get("name", "")).strip(),
                "date_of_joining": str(emp.get("dateOfJoin", "")).strip(),
            }
        if not data.get("pages", {}).get("hasNext"):
            break
        page += 1
    return employees


# ==========================
# DEPARTMENT & DESIGNATION
# ==========================

def get_department_details(token: str, domain: str) -> dict[str, dict]:
    """Return {employeeId: {department, designation}} from reporting hierarchy."""
    core_base = f"https://{domain}"
    data = _api_get(
        f"{core_base}/core-hr/v1/employees/reporting-hierarchy",
        token,
        domain,
        params={"display": "all", "page": 0, "size": 30000},
    )
    result = {}
    for emp in data.get("data", []):
        emp_id = str(emp.get("id", "")).strip()
        if emp_id:
            result[emp_id] = {
                "department": str(emp.get("department", "") or "").strip(),
                "designation": str(emp.get("designation", "") or "").strip(),
            }
    return result


# ==========================
# ATTENDANCE
# ==========================

def get_attendance_muster(token: str, domain: str, start: str, end: str) -> list[dict]:
    """Return raw attendance records list from the muster endpoint."""
    data = _api_get(
        f"{API_BASE}/attendance/v2/employee/muster",
        token,
        domain,
        params={"start": start, "end": end},
    )
    return data.get("data", [])


# ==========================
# HIGH-LEVEL FETCH
# ==========================

def get_greythr_attendance(start: str, end: str) -> dict[str, Counter]:
    """Return {employeeNo: Counter(label: count)} for the given date range.

    Calls get_employee_master, get_department_details, and get_attendance_muster
    separately then merges them. Labels: P=Present, A=Absent, H=Holiday,
    OFF/WO=WeekOff, CL/SL/EL/LOP/ML/PL/CO=leave types.
    """
    token, domain = get_token()

    master = get_employee_master(token, domain)
    try:
        get_department_details(token, domain)  # available for future enrichment
    except GreytHRApiError:
        pass
    records = get_attendance_muster(token, domain, start, end)

    emp_no_map = {emp_id: info["employee_no"] for emp_id, info in master.items()}

    result: dict[str, Counter] = defaultdict(Counter)
    for emp in records:
        emp_id = str(emp.get("employeeId", "")).strip()
        emp_no = emp_no_map.get(emp_id, "").strip()
        if not emp_no:
            continue
        for rec in emp.get("records", []):
            label = rec.get("summary", {}).get("session1Label", "") or "Blank"
            result[emp_no][label] += 1

    return result
