from __future__ import annotations

import base64
import json
import os
import re
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
    """Return {employeeId: {employee_no, name, date_of_joining, employment_type, probation_end}} for active employees."""
    employees = {}
    page = 0
    while True:
        data = _api_get(
            f"{API_BASE}/employee/v2/employees",
            token,
            domain,
            params={"page": page, "size": 25},
        )
        today = __import__("datetime").date.today().isoformat()
        for emp in data.get("data", []):
            if emp.get("leftorg"):
                continue
            leaving = str(emp.get("leavingDate") or "").strip()
            if leaving and leaving <= today:
                continue
            emp_id = str(emp.get("employeeId", "")).strip()
            if not emp_id:
                continue
            employees[emp_id] = {
                "employee_no":    str(emp.get("employeeNo", "")).strip(),
                "name":           str(emp.get("name", "")).strip(),
                "date_of_joining": str(emp.get("dateOfJoin", "")).strip(),
                "employment_type": str(emp.get("employmentType", "") or emp.get("empType", "") or "").strip(),
                "probation_end":  str(emp.get("probationEndDate", "") or "").strip(),
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

def get_attendance_muster(token: str, domain: str, start: str, end: str, active_ids: set | None = None) -> list[dict]:
    """Return attendance records with pagination. Filters by active_ids if provided."""
    records = []
    page = 0
    size = 25
    while True:
        data = _api_get(
            f"{API_BASE}/attendance/v2/employee/muster",
            token,
            domain,
            params={"start": start, "end": end, "page": page, "size": size},
        )
        for emp in data.get("data", []):
            if active_ids and str(emp.get("employeeId", "")).strip() not in active_ids:
                continue
            records.append(emp)
        if not data.get("pages", {}).get("hasNext"):
            break
        page += 1
    return records


# ==========================
# HIGH-LEVEL FETCH
# ==========================

def _normalise_attendance_label(value: str) -> str:
    label = str(value or "").strip().upper()
    label = label.replace(" ", "").replace("-", "")
    aliases = {
        "": "Blank",
        "NULL": "Blank",
        "NONE": "Blank",
        "NAN": "Blank",
        "PRESENT": "P",
        "ABSENT": "A",
        "HOLIDAY": "H",
        "WO": "OFF",
        "W/O": "OFF",
        "WEEKOFF": "OFF",
        "WEEKLYOFF": "OFF",
        "OFFDAY": "OFF",
        "OFF": "OFF",
    }
    return aliases.get(label, label)


def _attendance_bucket(label: str) -> str:
    label = _normalise_attendance_label(label)
    leave_codes = {
        "CL", "SL", "EL", "LOP", "ML", "PL", "CO", "LWP", "OD", "WFH",
        "COMP", "COMPOFF", "LEAVE", "PAIDLEAVE", "UNPAIDLEAVE",
    }
    if label in {"P", "A", "H", "OFF", "Blank"}:
        return label
    if label in leave_codes:
        return "Leave"
    return "Leave"


def _normalise_match_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def get_greythr_attendance(start: str, end: str) -> tuple[dict[str, Counter], dict[str, dict], dict[str, dict]]:
    """Return ({employeeNo: Counter(bucket: days)}, master_data, dept_details).

    Calls get_employee_master, get_department_details, and get_attendance_muster
    separately then merges them.

    GreytHR muster is session based. Counting a whole day as one combined label
    misclassifies half-day records such as P/A or P/CL, so each session is
    counted as 0.5 day and rolled up into dashboard buckets:
    P, A, H, OFF, Leave, Blank.
    """
    token, domain = get_token()

    master = get_employee_master(token, domain)
    dept_details: dict[str, dict] = {}
    try:
        raw_dept = get_department_details(token, domain)
        dept_details = dict(raw_dept)
        # Also index by employee_no so callers can look up by CWINI code
        for gt_id, emp_info in master.items():
            emp_no = emp_info.get("employee_no", "")
            if emp_no and gt_id in raw_dept:
                dept_details[emp_no] = raw_dept[gt_id]
    except GreytHRApiError:
        pass
    active_ids = set(master.keys())
    records = get_attendance_muster(token, domain, start, end, active_ids)

    raw_by_employee_id: dict[str, Counter] = defaultdict(Counter)
    for emp in records:
        emp_id = str(emp.get("employeeId", "")).strip()
        if not emp_id:
            continue
        for rec in emp.get("records", []):
            summary = rec.get("summary", {})
            sessions = [
                summary.get("session1Label", ""),
                summary.get("session2Label", ""),
            ]
            for session_label in sessions:
                bucket = _attendance_bucket(session_label)
                raw_by_employee_id[emp_id][bucket] += 0.5

    result: dict[str, Counter] = {}
    for emp_id, counter in raw_by_employee_id.items():
        info = master.get(emp_id, {})
        aliases = {
            emp_id,
            info.get("employee_no", ""),
            f"name:{_normalise_match_key(info.get('name', ''))}",
        }
        for alias in aliases:
            alias = str(alias or "").strip()
            if alias and alias != "name:":
                result[alias] = Counter(counter)

    # Return attendance counters, master data, and department/designation details
    return result, master, dept_details
