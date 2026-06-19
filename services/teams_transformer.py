from __future__ import annotations

import csv
import io

import pandas as pd


TEAMS_COLUMNS = [
    "User ID",
    "Availability",
    "Activity",
    "Work Location",
    "Is Out Of Office",
    "Sequence Number",
]

ACTIVITY_COLUMNS = [
    "upn",
    "last_activity_date",
    "team_chat_messages",
    "private_chat_messages",
    "calls",
    "meetings",
    "meetings_organized",
    "meetings_attended",
    "audio_seconds",
    "video_seconds",
    "screen_share_seconds",
    "has_other_action",
    "report_period",
]

# Map from Microsoft Graph CSV column headers to our internal column names.
_ACTIVITY_HEADER_MAP = {
    "User Principal Name": "upn",
    "Last Activity Date": "last_activity_date",
    "Team Chat Message Count": "team_chat_messages",
    "Private Chat Message Count": "private_chat_messages",
    "Call Count": "calls",
    "Meeting Count": "meetings",
    "Meetings Organized Count": "meetings_organized",
    "Meetings Attended Count": "meetings_attended",
    "Audio Duration In Seconds": "audio_seconds",
    "Video Duration In Seconds": "video_seconds",
    "Screen Share Duration In Seconds": "screen_share_seconds",
    "Has Other Action": "has_other_action",
    "Report Period": "report_period",
}


def extract_presence_rows(payload):
    if isinstance(payload, dict):
        value = payload.get("value")
        if isinstance(value, list):
            return value
    if isinstance(payload, list):
        return payload
    return []


def transform_presence_row(row):
    out_of_office = row.get("outOfOfficeSettings", {}) or {}
    work_location = row.get("workLocation", {}) or {}
    return {
        "User ID": str(row.get("id", "") or ""),
        "Availability": str(row.get("availability", "") or ""),
        "Activity": str(row.get("activity", "") or ""),
        "Work Location": str(work_location.get("workLocationType", "") or ""),
        "Is Out Of Office": bool(out_of_office.get("isOutOfOffice", False)),
        "Sequence Number": str(row.get("sequenceNumber", "") or ""),
    }


def teams_presence_dataframe_from_payload(payload):
    rows = [transform_presence_row(row) for row in extract_presence_rows(payload)]
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=TEAMS_COLUMNS)
    for column in TEAMS_COLUMNS:
        if column not in frame.columns:
            frame[column] = ""
    return frame[TEAMS_COLUMNS].fillna("")


def teams_activity_dataframe_from_csv(csv_text: str) -> pd.DataFrame:
    """Parse the Teams user activity report CSV into a normalized DataFrame."""
    if not csv_text or not csv_text.strip():
        return pd.DataFrame(columns=ACTIVITY_COLUMNS)

    reader = csv.DictReader(io.StringIO(csv_text))
    rows = []
    for raw in reader:
        row = {}
        for header, value in raw.items():
            key = _ACTIVITY_HEADER_MAP.get((header or "").strip())
            if key:
                row[key] = (value or "").strip()
        if row.get("upn"):
            rows.append(row)

    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=ACTIVITY_COLUMNS)
    for col in ACTIVITY_COLUMNS:
        if col not in frame.columns:
            frame[col] = ""
    return frame[ACTIVITY_COLUMNS].fillna("0")
