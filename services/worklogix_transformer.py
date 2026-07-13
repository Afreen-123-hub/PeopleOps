from __future__ import annotations

import json

import pandas as pd


USER_COLUMNS = [
    "id", "name", "email", "password", "role", "created_at", "updated_at",
    "created_by", "updated_by", "designation", "team", "otp_code", "otp_time",
    "is_active", "ms_teams_id", "biometric_id", "mentor_id",
]
DAILY_COLUMNS = [
    "employee_id", "project_id", "month", "ticket_id", "description", "assigned_date",
    "due_date", "start_date", "completion_date", "working_hours", "dependency_status",
    "priority", "work_type", "status", "created_at", "updated_at", "approval_status",
    "reason", "meeting_hours", "allow_fields", "created_by", "updated_by",
]
MONTHLY_COLUMNS = [
    "employee_id", "name", "month", "created_at", "updated_at", "completion_score",
    "productivity_score", "volume_score", "priority_score", "dependency_score",
    "consistency_score", "final_score", "final_rating",
]
PROJECT_COLUMNS = [
    "id", "name", "description", "status", "project_member", "created_by", "updated_by",
    "created_at", "updated_at", "managed_by", "manager_rate", "git_repo_url",
    "client_id", "is_meeting_hours",
]


def first_value(source, *keys, default=""):
    for key in keys:
        if isinstance(source, dict) and source.get(key) not in (None, ""):
            return source.get(key)
    return default


def as_text(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def extract_rows(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in (
        "data", "result", "results", "items", "records", "users", "employees",
        "tasks", "projects", "teams", "daily_updates", "monthly_updates", "reports",
    ):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            nested = extract_rows(value)
            if nested:
                return nested
    return []


def normalize_row(row, columns, mapping):
    return {column: as_text(first_value(row, *mapping.get(column, (column,)))) for column in columns}


def dedupe_rows(rows, key_name):
    deduped = {}
    for row in rows:
        key = as_text(row.get(key_name, "")).strip()
        if not key:
            continue
        deduped[key] = row
    return list(deduped.values())


def rows_to_dataframe(rows, columns):
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=columns)
    for column in columns:
        if column not in frame.columns:
            frame[column] = ""
    return frame[columns].fillna("")


def transform_users(payload):
    mapping = {
        "id": ("user_id", "id", "employee_id", "emp_id", "code"),
        "name": ("name", "employee_name", "full_name"),
        "email": ("email", "work_email"),
        "role": ("role", "role_id"),
        "designation": ("designation", "job_title", "title"),
        "team": ("team", "department", "team_name"),
        "is_active": ("is_active", "active", "status"),
        "ms_teams_id": ("ms_teams_id", "teams_id"),
        "biometric_id": ("biometric_id", "biometric_code"),
    }
    rows = [normalize_row(row, USER_COLUMNS, mapping) for row in extract_rows(payload)]
    for row in rows:
        if row["is_active"].lower() in {"active", "1", "yes"}:
            row["is_active"] = "True"
    return dedupe_rows(rows, "id")


def transform_daily_updates(payload):
    mapping = {
        "employee_id": ("emp_id", "employee_id", "assignee_id", "user_id"),
        "project_id": ("project_id", "project_code", "project"),
        "month": ("month", "period"),
        "ticket_id": ("ticket_id", "task_id", "id"),
        "description": ("description", "task_description", "title", "name"),
        "assigned_date": ("assigned_date", "created_at"),
        "due_date": ("due_date", "deadline"),
        "start_date": ("start_date",),
        "completion_date": ("completion_date", "completed_at"),
        "working_hours": ("working_hours", "work_hours", "daily_hours"),
        "dependency_status": ("dependency_status", "dependency"),
        "priority": ("priority",),
        "work_type": ("work_type", "type"),
        "status": ("status", "task_status"),
        "approval_status": ("approval_status", "approval"),
        "reason": ("reason", "approval_reason"),
        "meeting_hours": ("meeting_hours",),
        "created_by": ("created_by", "employee_id", "user_id"),
        "updated_by": ("updated_by", "employee_id", "user_id"),
    }
    return [normalize_row(row, DAILY_COLUMNS, mapping) for row in extract_rows(payload)]


def transform_monthly_updates(payload):
    mapping = {
        "employee_id": ("employee_id", "user_id", "emp_id"),
        "name": ("name", "employee_name"),
        "month": ("month", "period"),
        "completion_score": ("completion_score", "completion"),
        "productivity_score": ("productivity_score", "productivity"),
        "volume_score": ("volume_score", "volume"),
        "priority_score": ("priority_score", "priority"),
        "dependency_score": ("dependency_score", "dependency"),
        "consistency_score": ("consistency_score", "consistency"),
        "final_score": ("final_score", "score", "kpi_score"),
        "final_rating": ("final_rating", "rating"),
    }
    return [normalize_row(row, MONTHLY_COLUMNS, mapping) for row in extract_rows(payload)]


def transform_projects(payload):
    mapping = {
        "id": ("id", "project_id", "project_code"),
        "name": ("name", "project_name"),
        "description": ("description",),
        "status": ("status",),
        "project_member": ("project_member", "members", "users"),
        "managed_by": ("managed_by", "manager_id"),
        "manager_rate": ("manager_rate",),
        "git_repo_url": ("git_repo_url", "repo_url"),
        "client_id": ("client_id",),
        "is_meeting_hours": ("is_meeting_hours",),
    }
    return [normalize_row(row, PROJECT_COLUMNS, mapping) for row in extract_rows(payload)]


def transform_worklogix_payloads(payloads):
    daily_payload = payloads.get("daily_updates") or payloads.get("tasks")
    users = transform_users(payloads.get("employees", []))
    daily = transform_daily_updates(daily_payload)
    monthly = transform_monthly_updates(payloads.get("monthly_updates", []))
    projects = transform_projects(payloads.get("projects", []))
    return {
        "users": rows_to_dataframe(users, USER_COLUMNS).to_dict("records"),
        "daily": rows_to_dataframe(daily, DAILY_COLUMNS).to_dict("records"),
        "monthly": rows_to_dataframe(monthly, MONTHLY_COLUMNS).to_dict("records"),
        "projects": rows_to_dataframe(projects, PROJECT_COLUMNS).to_dict("records"),
        "teams": extract_rows(payloads.get("teams", [])),
        "tasks": extract_rows(payloads.get("tasks", [])),
        "employee_info": extract_rows(payloads.get("employee_info", [])),
    }


def employees_dataframe_from_payload(payload):
    return rows_to_dataframe(transform_users(payload), USER_COLUMNS)


def daily_updates_dataframe_from_payload(payload):
    return rows_to_dataframe(transform_daily_updates(payload), DAILY_COLUMNS)


def monthly_updates_dataframe_from_payload(payload):
    return rows_to_dataframe(transform_monthly_updates(payload), MONTHLY_COLUMNS)


def projects_dataframe_from_payload(payload):
    return rows_to_dataframe(transform_projects(payload), PROJECT_COLUMNS)
