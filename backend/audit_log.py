"""Append-only audit trail for employee-data access, per the RBAC requirement that HR/Admin
be able to audit who looked at, changed, or exported whose data."""
from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
AUDIT_FILE = PROJECT_ROOT / "data" / "audit-log.json"

_lock = Lock()


def record(who: str, action: str, resource: str, target: str = "", detail: str = "") -> None:
    """who: email or session name of the accessor.
    action: "view" | "modify" | "export" | "denied".
    resource: what kind of data, e.g. "employee", "attendance", "leave-types", "work-location".
    target: the employee/team id the action concerned, when known.
    """
    entry = {
        "who": who,
        "action": action,
        "resource": resource,
        "target": target,
        "detail": detail,
        "at": time.time(),
    }
    with _lock:
        entries = []
        if AUDIT_FILE.exists():
            try:
                entries = json.loads(AUDIT_FILE.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                entries = []
        entries.append(entry)
        AUDIT_FILE.write_text(json.dumps(entries, indent=2), encoding="utf-8")
