"""Role & scope resolution for RBAC.

Given a logged-in identity (employee id and/or email), resolves their role tier and the
set of employee IDs they're allowed to see, from data/org-hierarchy.json plus manual
corrections in data/role-overrides.json.

Why a manual-override file exists: org-hierarchy.json's `designation` field is not a
reliable signal for role tier — e.g. someone titled "Junior Software Tester" or "Software
Developer" can still have direct reports (and even manage another manager), while a
"Director" designation can sit at any depth. The rule below makes a best-effort guess from
hierarchy shape (root of the tree, HR team membership, whether any direct report is
themselves a manager, strong title keywords), but it WILL misclassify edge cases — that's
what data/role-overrides.json is for, and it always wins over the guess.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ORG_FILE = PROJECT_ROOT / "data" / "org-hierarchy.json"
OVERRIDES_FILE = PROJECT_ROOT / "data" / "role-overrides.json"
PEOPLEOPS_FILE = PROJECT_ROOT / "data" / "peopleops-data.json"

Role = Literal["employee", "team_lead", "manager", "dept_head", "hr", "hr_admin", "super_admin"]

# Roles that see the whole company, per the CEO's "HR/Admin retain company-wide access" requirement.
COMPANY_WIDE_ROLES = {"hr", "hr_admin", "super_admin"}

_TITLE_DEPT_HEAD_KEYWORDS = ("director", "head", "vp", "chief")


def _load_json(path: Path, default):
    try:
        text = path.read_text(encoding="utf-8-sig")  # -sig strips a BOM if present (org-hierarchy.json has one)
        return json.loads(text)
    except (OSError, json.JSONDecodeError):
        return default


def _org_employees() -> list[dict]:
    return _load_json(ORG_FILE, {}).get("employees", [])


def _employee_id_for_email(email: str) -> str:
    """org-hierarchy.json has no email field, so a logged-in SSO email is resolved to an
    employee id via peopleops-data.json (the file that actually carries `email`) first."""
    if not email:
        return ""
    wanted = email.strip().lower()
    for emp in _load_json(PEOPLEOPS_FILE, {}).get("employees", []):
        if str(emp.get("email", "")).strip().lower() == wanted:
            return str(emp.get("id", ""))
    return ""


def _overrides() -> dict:
    """{employeeIdOrEmail: {"role": "...", ...}} — hand-maintained corrections. See module
    docstring for why these exist; they always take priority over the rule-based guess."""
    data = _load_json(OVERRIDES_FILE, {})
    return {k: v for k, v in data.items() if not k.startswith("_")}


def _default_role_for(employee: dict, by_id: dict[str, dict]) -> Role:
    """Best-effort guess when there's no manual override. See module docstring for caveats."""
    if not employee.get("isManager"):
        return "employee"
    if not employee.get("managerId"):
        return "super_admin"  # root of the org tree — no one above them

    team = (employee.get("team") or "").lower()
    designation = (employee.get("designation") or "").lower()

    if "hr" in team:
        return "hr"
    if any(kw in designation for kw in _TITLE_DEPT_HEAD_KEYWORDS):
        return "dept_head"

    reports = employee.get("directReports") or []
    manages_a_manager = any(by_id.get(r, {}).get("isManager") for r in reports)
    return "manager" if manages_a_manager else "team_lead"


def _resolve_scope_ids(employee_id: str, by_id: dict[str, dict]) -> list[str]:
    """Self + everyone below this employee in the reporting tree (transitively)."""
    if not employee_id or employee_id not in by_id:
        return [employee_id] if employee_id else []
    seen = {employee_id}
    queue = [employee_id]
    while queue:
        current = queue.pop()
        for emp in by_id.values():
            if emp.get("managerId") == current and emp["id"] not in seen:
                seen.add(emp["id"])
                queue.append(emp["id"])
    return sorted(seen)


def resolve_identity(employee_id: str = "", email: str = "") -> dict:
    """Resolve a logged-in user to {employeeId, role, scope: {type, employeeIds}}.

    If `employee_id` isn't given, it's looked up from `email` via peopleops-data.json
    (org-hierarchy.json has no email field). Accounts that still don't resolve to an
    employee record (e.g. the password-login admin account, or an SSO account not linked
    to an employee) get role "employee" with scope "self" unless an override keyed by
    email says otherwise — callers that need a different fallback (e.g. server.py treating
    the password-login admin account as super_admin) should check for that case explicitly
    rather than relying on this function to guess.
    """
    if not employee_id and email:
        employee_id = _employee_id_for_email(email)

    employees = _org_employees()
    by_id = {e["id"]: e for e in employees}
    overrides = _overrides()

    employee = by_id.get(employee_id)
    override = overrides.get(employee_id) or (overrides.get(email) if email else None) or {}

    if override.get("role"):
        role: Role = override["role"]
    elif employee:
        role = _default_role_for(employee, by_id)
    else:
        role = "employee"

    if role in COMPANY_WIDE_ROLES:
        scope_ids = [e["id"] for e in employees]
        scope_type = "company"
    elif role == "employee":
        scope_ids = [employee_id] if employee_id else []
        scope_type = "self"
    else:
        scope_ids = _resolve_scope_ids(employee_id, by_id)
        scope_type = "reports"

    return {
        "employeeId": employee_id,
        "role": role,
        "scope": {"type": scope_type, "employeeIds": scope_ids},
    }


def _lower_set(ids) -> set[str]:
    return {str(i).strip().lower() for i in ids}


def filter_employees(records: list[dict], scope: dict, id_key: str = "id") -> list[dict]:
    """Scope a list of employee-shaped records (dicts with an id field) down to `scope`.
    Matches case-insensitively, like server.py's find_employee()."""
    if scope.get("type") == "company":
        return records
    allowed = _lower_set(scope.get("employeeIds", []))
    return [r for r in records if str(r.get(id_key, "")).strip().lower() in allowed]


def filter_leave_types_payload(payload: dict, scope: dict) -> dict:
    """Scope a leave-types month payload (data/leave/YYYY-MM.json) down to `scope`.

    Shape: {"days": {alias: {date: {...}}}, "people": [{"no": employeeId, "keys": [alias, ...]}]}
    — each person is indexed under *multiple* alias keys in `days` (a numeric row id, their
    employee id, and a "name:slug" form). Filtering `people` alone isn't enough — every
    alias for a filtered-out person must be dropped from `days` too, or their data leaks
    back out under a different key.
    """
    if scope.get("type") == "company":
        return payload
    allowed = _lower_set(scope.get("employeeIds", []))
    people = [p for p in payload.get("people", []) if str(p.get("no", "")).strip().lower() in allowed]
    keep_keys = {k for p in people for k in p.get("keys", [])}
    days = {k: v for k, v in payload.get("days", {}).items() if k in keep_keys}
    return {**payload, "days": days, "people": people}


def filter_work_location_payload(payload: dict, scope: dict) -> dict:
    """Scope a work-location month payload (data/worklocation/YYYY-MM.json) down to `scope`.

    Shape: {"people": [{"id": <GreytHR raw id>, "no": employeeId, ...}], "days": {date:
    {<GreytHR raw id>: {...}}}} — the reverse of leave-types (date first, then employee),
    and `days` is keyed by GreytHR's raw internal id rather than the employee code we scope
    on, so `people` has to be consulted to translate `no` into the raw ids to keep.
    """
    if scope.get("type") == "company":
        return payload
    allowed = _lower_set(scope.get("employeeIds", []))
    people = [p for p in payload.get("people", []) if str(p.get("no", "")).strip().lower() in allowed]
    keep_ids = {p.get("id") for p in people}
    days = {
        date: {eid: rec for eid, rec in records.items() if eid in keep_ids}
        for date, records in payload.get("days", {}).items()
    }
    return {**payload, "days": days, "people": people}


def can_access(employee_id: str, scope: dict) -> bool:
    """Whether `scope` is allowed to see this specific employee id — used to block
    direct-ID-in-URL bypasses (e.g. GET /api/employees/{id}, /api/attendance/{id})."""
    if scope.get("type") == "company":
        return True
    return str(employee_id).strip().lower() in _lower_set(scope.get("employeeIds", []))
