from __future__ import annotations

import json
import mimetypes
import os
import secrets
import subprocess
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chatbot.services import answer as tara_answer
from auth_ms import login_url as ms_login_url, handle_callback as ms_handle_callback


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT_ROOT / "data" / "peopleops-data.json"
DATA_FILE_MONTH = PROJECT_ROOT / "data" / "peopleops-data-month.json"  # temp file for month refresh — never overwrites main
GITHUB_DATA_FILE = PROJECT_ROOT / "data" / "github-data.json"
GRAPH_DATA_FILE = PROJECT_ROOT / "data" / "graph-activity.json"
MTM_TASKS_FILE = PROJECT_ROOT / "data" / "mtm-tasks.json"
GENERATOR = PROJECT_ROOT / "scripts" / "generate_peopleops_data.py"
ATTENDANCE_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_attendance_month.py"
TEAMS_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_teams.py"
GITHUB_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_github.py"
GRAPH_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_graph_activity.py"
API_FETCHER = PROJECT_ROOT / "scripts" / "fetch_real_api_data.py"
ENV_FILE = PROJECT_ROOT.parent / ".env"

def _merge_mtm_sprint_data(data: dict) -> dict:
    """Attach verified MTM sprint entries (from the MTM task API) onto each MTM employee's record."""
    try:
        tasks = json.loads(MTM_TASKS_FILE.read_text(encoding="utf-8")) if MTM_TASKS_FILE.exists() else []
    except (json.JSONDecodeError, OSError):
        tasks = []

    by_employee: dict[str, list] = {}
    for t in tasks:
        by_employee.setdefault(t.get("user_id", ""), []).append(t)

    for employee in data.get("employees", []):
        if not employee.get("isMtm"):
            continue
        entries = sorted(by_employee.get(employee.get("id", ""), []), key=lambda t: t.get("sprint", ""))
        verified = [t for t in entries if t.get("verification") == "verified"]
        total_assigned = sum(t.get("tasks_assigned", 0) for t in verified)
        total_completed = sum(t.get("tasks_completed", 0) for t in verified)
        employee["mtmSprints"] = verified
        employee["mtmSprintSummary"] = {
            "sprintsVerified": len(verified),
            "sprintsPending": len(entries) - len(verified),
            "totalAssigned": total_assigned,
            "totalCompleted": total_completed,
            "completionRate": round(total_completed / total_assigned * 100) if total_assigned else None,
            "avgUtilisation": round(sum(t.get("utilisation", 0) for t in verified) / len(verified), 2) if verified else None,
        }
    return data


def _load_mtm_tasks() -> list[dict]:
    if not MTM_TASKS_FILE.exists():
        return []
    return json.loads(MTM_TASKS_FILE.read_text(encoding="utf-8"))


def _save_mtm_tasks(tasks: list[dict]) -> None:
    MTM_TASKS_FILE.write_text(json.dumps(tasks, indent=2, ensure_ascii=False), encoding="utf-8")


def _known_mtm_ids() -> set[str]:
    data = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
    return {str(e["id"]) for e in data.get("employees", []) if e.get("isMtm")}


SESSION_TTL = 8 * 3600  # 8 hours
AUTO_REFRESH_INTERVAL = 24 * 3600  # refresh all data once every 24 hours
MAX_BODY = 10_240  # 10 KB cap on all POST bodies
MTM_MAX_BODY = 2_000_000  # 2 MB cap for MTM sprint batch uploads — can carry many employees x many sprints
_sessions: dict[str, dict] = {}  # token -> {expiry, name, type}
_last_full_refresh: float = 0.0   # epoch seconds of last successful full refresh
_refresh_lock = threading.Lock()

PUBLIC_PATHS = {"/login.html", "/splash.html", "/api/login", "/styles.css", "/favicon.ico", "/auth/login", "/auth/callback"}
_instance_lock = None

VERIFY_PAGE_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>MTM Task Verification</title>
<style>
  :root {
    --ink:#0f1c2e; --muted:#5a6b82; --line:#e2e8f0; --panel:#fff; --canvas:#f4f7fb;
    --indigo:#4338CA; --indigo-soft:#eef0fd; --teal:#14B8A6;
    --green:#10b981; --green-soft:#ecfdf5; --amber:#f59e0b; --amber-soft:#fffbeb; --red:#e11d48;
    --shadow-sm:0 1px 3px rgba(15,28,46,.06),0 4px 12px rgba(15,28,46,.07);
    --radius:12px; --radius-lg:16px;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--canvas); color:var(--ink); font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif; font-size:15px; }
  .page { max-width:980px; margin:0 auto; padding:32px 24px 80px; }
  h1 { font-size:22px; font-weight:800; margin:0 0 4px; }
  .subtle { color:var(--muted); font-size:13.5px; margin:0 0 22px; }
  .lock { background:var(--panel); border-radius:var(--radius-lg); box-shadow:var(--shadow-sm); padding:24px; max-width:380px; margin:60px auto; text-align:center; }
  .lock input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; margin:8px 0; }
  .lock button, .toolbar button { background:var(--indigo); color:#fff; border:none; border-radius:8px; padding:9px 16px; font-weight:700; font-size:13.5px; cursor:pointer; }
  .lock button:hover, .toolbar button:hover { opacity:.9; }
  .err { color:var(--red); font-size:12.5px; min-height:16px; }
  .toolbar { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
  .toolbar label { font-size:13px; color:var(--muted); display:flex; align-items:center; gap:6px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:var(--radius-lg); overflow:hidden; box-shadow:var(--shadow-sm); }
  th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:12px 14px; border-bottom:1px solid var(--line); }
  td { padding:12px 14px; border-bottom:1px solid var(--line); font-size:13.5px; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .pill { display:inline-flex; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:800; }
  .pill-pending { background:var(--amber-soft); color:var(--amber); }
  .pill-verified { background:var(--green-soft); color:var(--green); }
  .num-in { width:64px; padding:5px 6px; border:1px solid var(--line); border-radius:6px; font-size:13px; }
  .actions { display:flex; gap:6px; }
  .btn { border:none; border-radius:6px; padding:6px 10px; font-size:12px; font-weight:700; cursor:pointer; }
  .btn-verify { background:var(--green-soft); color:var(--green); }
  .btn-edit { background:var(--indigo-soft); color:var(--indigo); }
  .btn-save { background:var(--indigo); color:#fff; }
  .btn-delete { background:var(--amber-soft); color:var(--red); }
  .empty { text-align:center; padding:40px; color:var(--muted); }
</style>
</head>
<body>

<div id="lockScreen" class="lock">
  <h1>MTM Verification</h1>
  <p class="subtle">Log in with your PeopleOps account to review pending entries.</p>
  <input id="userInput" type="text" placeholder="Username" onkeydown="if(event.key==='Enter')unlock()">
  <input id="keyInput" type="password" placeholder="Password" onkeydown="if(event.key==='Enter')unlock()">
  <button onclick="unlock()">Log in</button>
  <p class="err" id="lockErr"></p>
</div>

<div class="page" id="mainScreen" style="display:none">
  <h1>MTM Task Verification</h1>
  <p class="subtle">Check each entry against Senthil's sprint report, then verify, correct, or remove it.</p>
  <div class="toolbar">
    <button onclick="load()">Refresh</button>
    <button id="verifyAllBtn" onclick="verifyAll()" style="background:var(--green)">Verify All Pending</button>
    <label><input type="checkbox" id="showAll" onchange="render()"> Show verified too</label>
  </div>
  <table>
    <thead><tr><th>Employee</th><th>Sprint</th><th>Assigned</th><th>Completed</th><th>Utilisation</th><th>Status</th><th>Verification</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>

<script>
let token = localStorage.getItem("mtmVerifyToken") || "";
let employees = {};
let tasks = [];
let editingId = null;

function headers() { return {"Authorization": "Bearer " + token, "Content-Type": "application/json"}; }

async function unlock() {
  const username = document.getElementById("userInput").value;
  const password = document.getElementById("keyInput").value;
  const loginRes = await fetch("/api/login", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({username, password}),
  });
  if (!loginRes.ok) {
    document.getElementById("lockErr").textContent = "Wrong username or password.";
    return;
  }
  const loginData = await loginRes.json();
  token = loginData.token;
  localStorage.setItem("mtmVerifyToken", token);
  document.getElementById("lockScreen").style.display = "none";
  document.getElementById("mainScreen").style.display = "block";
  const res = await fetch("/api/mtm-employees", {headers: headers()});
  const emps = await res.json();
  employees = Object.fromEntries(emps.map(e => [e.id, e.name]));
  load();
}

async function load() {
  const res = await fetch("/api/mtm-tasks", {headers: headers()});
  tasks = await res.json();
  render();
}

function render() {
  const showAll = document.getElementById("showAll").checked;
  const rows = document.getElementById("rows");
  const visible = tasks.filter(t => showAll || t.verification === "pending");
  if (!visible.length) {
    rows.innerHTML = `<tr><td colspan="8" class="empty">No ${showAll ? "" : "pending "}entries.</td></tr>`;
    return;
  }
  rows.innerHTML = visible.map(t => {
    const name = employees[t.user_id] || t.user_id;
    const isEditing = editingId === t.id;
    const verPill = t.verification === "verified"
      ? '<span class="pill pill-verified">Verified</span>'
      : '<span class="pill pill-pending">Pending</span>';
    if (isEditing) {
      return `<tr>
        <td>${name}<br><small style="color:var(--muted)">${t.user_id}</small></td>
        <td>${t.sprint}</td>
        <td><input class="num-in" id="e_assigned" type="number" value="${t.tasks_assigned}"></td>
        <td><input class="num-in" id="e_completed" type="number" value="${t.tasks_completed}"></td>
        <td><input class="num-in" id="e_util" type="number" step="0.01" value="${t.utilisation}"></td>
        <td>${t.status}</td>
        <td>${verPill}</td>
        <td class="actions">
          <button class="btn btn-save" onclick="saveEdit('${t.id}')">Save</button>
          <button class="btn btn-edit" onclick="editingId=null;render()">Cancel</button>
        </td>
      </tr>`;
    }
    return `<tr>
      <td>${name}<br><small style="color:var(--muted)">${t.user_id}</small></td>
      <td>${t.sprint}</td>
      <td>${t.tasks_assigned}</td>
      <td>${t.tasks_completed}</td>
      <td>${t.utilisation}</td>
      <td>${t.status}</td>
      <td>${verPill}</td>
      <td class="actions">
        ${t.verification !== "verified" ? `<button class="btn btn-verify" onclick="verify('${t.id}')">Verify</button>` : ""}
        <button class="btn btn-edit" onclick="editingId='${t.id}';render()">Edit</button>
        <button class="btn btn-delete" onclick="del('${t.id}')">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function verify(id) {
  await fetch("/api/mtm-tasks/" + id, {method:"PUT", headers: headers(), body: JSON.stringify({verification:"verified"})});
  load();
}

async function verifyAll() {
  const pending = tasks.filter(t => t.verification !== "verified");
  if (!pending.length) { alert("No pending entries to verify."); return; }
  if (!confirm(`Verify all ${pending.length} pending entries? Only do this after checking them against Senthil's report.`)) return;
  const btn = document.getElementById("verifyAllBtn");
  btn.disabled = true;
  btn.textContent = "Verifying...";
  for (const t of pending) {
    await fetch("/api/mtm-tasks/" + t.id, {method:"PUT", headers: headers(), body: JSON.stringify({verification:"verified"})});
  }
  btn.disabled = false;
  btn.textContent = "Verify All Pending";
  load();
}

async function saveEdit(id) {
  const body = {
    tasks_assigned: parseInt(document.getElementById("e_assigned").value, 10),
    tasks_completed: parseInt(document.getElementById("e_completed").value, 10),
    utilisation: parseFloat(document.getElementById("e_util").value),
  };
  await fetch("/api/mtm-tasks/" + id, {method:"PUT", headers: headers(), body: JSON.stringify(body)});
  editingId = null;
  load();
}

async function del(id) {
  if (!confirm("Delete this entry? This can't be undone.")) return;
  await fetch("/api/mtm-tasks/" + id, {method:"DELETE", headers: headers()});
  load();
}

if (token) {
  fetch("/api/mtm-employees", {headers: headers()}).then(res => {
    if (!res.ok) { localStorage.removeItem("mtmVerifyToken"); return; }
    document.getElementById("lockScreen").style.display = "none";
    document.getElementById("mainScreen").style.display = "block";
    res.json().then(emps => {
      employees = Object.fromEntries(emps.map(e => [e.id, e.name]));
      load();
    });
  });
}
</script>
</body>
</html>
"""


def _load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _get_credentials():
    _load_env()
    username = os.environ.get("PEOPLEOPS_USERNAME", "admin").strip()
    password = os.environ.get("PEOPLEOPS_PASSWORD", "").strip()
    return username, password


def _is_valid_token(token: str) -> bool:
    session = _sessions.get(token)
    if session and session.get("expiry", 0) > time.time():
        return True
    _sessions.pop(token, None)
    return False


class PeopleOpsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _authenticated(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return _is_valid_token(auth[7:])
        return False

    def _require_auth(self) -> bool:
        if not self._authenticated():
            self.send_json({"error": "Unauthorized. Please log in."}, HTTPStatus.UNAUTHORIZED)
            return False
        return True

    def _current_session(self) -> dict:
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        return _sessions.get(token, {})

    def _require_admin_session(self) -> bool:
        """MTM verification is restricted to password-login accounts — SSO (leadership) accounts don't get it."""
        if not self._require_auth():
            return False
        if self._current_session().get("type") != "password":
            self.send_json({"error": "MTM verification is restricted to admin accounts."}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path

        # Always allow login page and static assets
        if path == "/auth/login":
            self.send_response(302)
            self.send_header("Location", ms_login_url())
            self.end_headers()
            return

        if path == "/auth/callback":
            self._handle_sso_callback()
            return

        if path in PUBLIC_PATHS:
            super().do_GET()
            return

        if path == "/verify":
            self.send_html(VERIFY_PAGE_HTML)
            return

        # Root → login page
        if path == "/":
            self.path = "/login.html"
            super().do_GET()
            return

        if path.startswith("/api/"):
            if not self._require_auth():
                return
            self.handle_api_get(path)
            return

        if path.startswith("/data/"):
            if not self._require_auth():
                return

        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/login":
            self.handle_login()
            return

        if path == "/api/logout":
            self.handle_logout()
            return

        if not self._require_auth():
            return

        if path == "/api/regenerate":
            self.regenerate_data()
            return
        if path == "/api/attendance-month":
            self.refresh_attendance_month()
            return
        if path == "/api/refresh-month":
            self.refresh_all_for_month()
            return
        if path == "/api/refresh-teams":
            self.refresh_teams()
            return
        if path == "/api/refresh-github":
            self.refresh_github()
            return
        if path == "/api/refresh-graph":
            self.refresh_graph()
            return
        if path == "/api/fetch-real-data":
            self.fetch_real_data()
            return
        if path == "/api/refresh-full":
            self.refresh_full()
            return
        if path == "/api/chat":
            self.handle_chat()
            return
        if path == "/api/mtm-tasks/batch":
            if not self._require_admin_session():
                return
            self.handle_mtm_batch()
            return
        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/mtm-tasks/"):
            if not self._require_admin_session():
                return
            self.handle_mtm_update(unquote(path.removeprefix("/api/mtm-tasks/")))
            return
        if not self._require_auth():
            return
        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/mtm-tasks/"):
            if not self._require_admin_session():
                return
            self.handle_mtm_delete(unquote(path.removeprefix("/api/mtm-tasks/")))
            return
        if not self._require_auth():
            return
        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

    def handle_mtm_batch(self):
        length = min(int(self.headers.get("Content-Length", 0)), MTM_MAX_BODY)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        rows = body.get("rows", [])
        required = {"user_id", "sprint", "tasks_assigned", "tasks_completed", "utilisation"}
        if not isinstance(rows, list) or not all(isinstance(r, dict) and required.issubset(r) for r in rows):
            self.send_json({"error": f"'rows' must be a list of objects with {sorted(required)}."}, HTTPStatus.BAD_REQUEST)
            return

        known_ids = _known_mtm_ids()
        row_ids = {str(r["user_id"]) for r in rows}
        matched_rows = [r for r in rows if str(r["user_id"]) in known_ids]
        extra_ids = row_ids - known_ids
        missing_ids = known_ids - row_ids

        tasks = _load_mtm_tasks()
        stored = []
        for row in matched_rows:
            status = "Completed" if row["tasks_completed"] == row["tasks_assigned"] else "Partial"
            clean = {
                "user_id": str(row["user_id"]),
                "sprint": str(row["sprint"]),
                "tasks_assigned": int(row["tasks_assigned"]),
                "tasks_completed": int(row["tasks_completed"]),
                "utilisation": float(row["utilisation"]),
            }
            existing = next(
                (t for t in tasks if t["user_id"] == clean["user_id"] and t["sprint"] == clean["sprint"]),
                None,
            )
            if existing:
                existing.update({"verification": "pending", "status": status, **clean})
                stored.append(existing)
            else:
                entry = {"id": str(uuid.uuid4()), "verification": "pending", "status": status, **clean}
                tasks.append(entry)
                stored.append(entry)
        _save_mtm_tasks(tasks)

        self.send_json({
            "stored": stored,
            "rejected_ids_not_in_system": sorted(extra_ids),
            "employees_missing_from_ppt": sorted(missing_ids),
        })

    def handle_mtm_update(self, entry_id):
        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        allowed = {"tasks_assigned", "tasks_completed", "utilisation", "verification"}
        changes = {k: v for k, v in body.items() if k in allowed and v is not None}
        tasks = _load_mtm_tasks()
        for t in tasks:
            if t["id"] == entry_id:
                t.update(changes)
                _save_mtm_tasks(tasks)
                self.send_json(t)
                return
        self.send_json({"error": "Task entry not found"}, HTTPStatus.NOT_FOUND)

    def handle_mtm_delete(self, entry_id):
        tasks = _load_mtm_tasks()
        remaining = [t for t in tasks if t["id"] != entry_id]
        if len(remaining) == len(tasks):
            self.send_json({"error": "Task entry not found"}, HTTPStatus.NOT_FOUND)
            return
        _save_mtm_tasks(remaining)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def _handle_sso_callback(self):
        from urllib.parse import parse_qs, urlparse, quote
        qs = parse_qs(urlparse(self.path).query)
        error = qs.get("error", [""])[0]
        if error:
            desc = qs.get("error_description", [error])[0]
            self.send_response(302)
            self.send_header("Location", "/login.html?error=" + quote(desc[:200]))
            self.end_headers()
            return
        code  = qs.get("code",  [""])[0]
        state = qs.get("state", [""])[0]
        result = ms_handle_callback(code, state)
        if not result["ok"]:
            self.send_response(302)
            self.send_header("Location", "/login.html?error=" + quote(result["reason"]))
            self.end_headers()
            return
        token = secrets.token_hex(32)
        user_name = result.get("name", "") or result.get("displayName", "")
        user_email = result.get("email", "")
        _sessions[token] = {"expiry": time.time() + SESSION_TTL, "name": user_name, "email": user_email, "type": "sso"}
        name = quote(user_name)
        self.send_response(302)
        self.send_header("Location", f"/login.html?sso_token={token}&sso_name={name}")
        self.end_headers()

    def handle_login(self):
        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        username, password = _get_credentials()
        if not password:
            self.send_json({"error": "Server has no password configured. Set PEOPLEOPS_PASSWORD in .env"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if body.get("username", "").strip() == username and body.get("password", "") == password:
            token = secrets.token_hex(32)
            _sessions[token] = {"expiry": time.time() + SESSION_TTL, "name": username, "type": "password"}
            self.send_json({"token": token, "name": username, "expires_in": SESSION_TTL})
        else:
            time.sleep(1)  # slow brute-force attempts
            self.send_json({"error": "Invalid username or password."}, HTTPStatus.UNAUTHORIZED)

    def handle_logout(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            _sessions.pop(auth[7:], None)
        self.send_json({"status": "logged out"})

    def handle_api_get(self, path):
        data = self.load_data()
        if data is None:
            return

        auth = self.headers.get("Authorization", "")
        current_token = auth[7:] if auth.startswith("Bearer ") else ""
        current_session = _sessions.get(current_token, {})

        if path.startswith("/api/mtm-") and current_session.get("type") != "password":
            self.send_json({"error": "MTM verification is restricted to admin accounts."}, HTTPStatus.FORBIDDEN)
            return

        routes = {
            "/api/health": lambda: {
                "status": "ok",
                "app": data.get("meta", {}).get("name", "PeopleOPS Intelligence"),
                "dataMode": data.get("meta", {}).get("dataMode", "Local sample files"),
                "lastFullRefresh": _last_full_refresh * 1000 if _last_full_refresh else None,
                "nextRefreshIn": max(0, AUTO_REFRESH_INTERVAL - (time.time() - _last_full_refresh)) if _last_full_refresh else None,
            },
            "/api/me": lambda: {
                "name": current_session.get("name", ""),
                "email": current_session.get("email", ""),
                "type": current_session.get("type", "password"),
            },
            "/api/available-months": lambda: {
                "months": sorted([
                    p.stem for p in (PROJECT_ROOT / "data" / "months").glob("*.json")
                    if __import__("re").match(r"^\d{4}-\d{2}$", p.stem)
                ]) if (PROJECT_ROOT / "data" / "months").exists() else []
            },
            "/api/data": lambda: data,
            "/api/meta": lambda: data.get("meta", {}),
            "/api/overview": lambda: data.get("overview", {}),
            "/api/employees": lambda: data.get("employees", []),
            "/api/teams": lambda: [
                {
                    "id": employee.get("id"),
                    "name": employee.get("name"),
                    "team": employee.get("team"),
                    "designation": employee.get("designation"),
                    "sourceConfidence": employee.get("sourceConfidence"),
                    **employee.get("teams", {}),
                }
                for employee in data.get("employees", [])
            ],
            "/api/projects": lambda: data.get("projects", []),
            "/api/github-data": lambda: self.load_github_data(),
            "/api/graph-data": lambda: self.load_graph_data(),
            "/api/mtm-employees": lambda: [
                {"id": str(e["id"]), "name": e.get("name", "")}
                for e in data.get("employees", [])
                if e.get("isMtm")
            ],
            "/api/mtm-tasks": lambda: _load_mtm_tasks(),
        }

        if path in routes:
            self.send_json(routes[path]())
            return

        if path.startswith("/api/employees/"):
            employee_id = unquote(path.removeprefix("/api/employees/"))
            employee = self.find_employee(data, employee_id)
            if employee:
                self.send_json(employee)
            else:
                self.send_json({"error": "Employee not found"}, HTTPStatus.NOT_FOUND)
            return

        if path.startswith("/api/mtm-tasks/"):
            entry_id = unquote(path.removeprefix("/api/mtm-tasks/"))
            for t in _load_mtm_tasks():
                if t["id"] == entry_id:
                    self.send_json(t)
                    return
            self.send_json({"error": "Task entry not found"}, HTTPStatus.NOT_FOUND)
            return

        if path.startswith("/api/attendance/"):
            employee_id = unquote(path.removeprefix("/api/attendance/"))
            employee = self.find_employee(data, employee_id)
            if employee:
                self.send_json({
                    "id": employee.get("id"),
                    "name": employee.get("name"),
                    "team": employee.get("team"),
                    "designation": employee.get("designation"),
                    "band": employee.get("band"),
                    "sourceConfidence": employee.get("sourceConfidence"),
                    "sources": employee.get("sources", {}),
                    "attendance": employee.get("attendance", {}),
                })
            else:
                self.send_json({"error": "Employee not found"}, HTTPStatus.NOT_FOUND)
            return

        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

    def regenerate_data(self):
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--month", time.strftime("%Y-%m")],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            self.send_json({"status": "regenerated"})
        else:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "Data regeneration failed. Check server logs.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_attendance_month(self):
        import re

        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        month = str(body.get("month", "")).strip()
        employee_id = str(body.get("employeeId", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            self.send_json({"error": "Month must use YYYY-MM format."}, HTTPStatus.BAD_REQUEST)
            return

        result = subprocess.run(
            [sys.executable, str(ATTENDANCE_REFRESHER), "--month", month],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            # Extract the first ERROR: line from stderr for a user-friendly message
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "Attendance data could not be refreshed for that month.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        data = self.load_data() or {}
        graph_data = self.load_graph_data() or {}
        employees_by_id = {
            str(employee.get("id", "")).strip(): employee
            for employee in data.get("employees", [])
        }
        for graph_employee in graph_data.get("employees", []):
            source = employees_by_id.get(str(graph_employee.get("id", "")).strip())
            if not source:
                continue
            graph_employee["attendance"] = source.get("attendance", {})
            graph_employee["kpi"] = source.get("kpi")
            graph_employee["band"] = source.get("band")
        graph_data.setdefault("meta", {})["attendancePeriod"] = data.get("meta", {}).get("period", "")
        GRAPH_DATA_FILE.write_text(json.dumps(graph_data, indent=2), encoding="utf-8")

        selected_employee = employees_by_id.get(employee_id, {})
        self.send_json({
            "status": "refreshed",
            "month": month,
            "period": data.get("meta", {}).get("period", ""),
            "employee": {
                "id": selected_employee.get("id"),
                "attendance": selected_employee.get("attendance", {}),
                "kpi": selected_employee.get("kpi"),
                "band": selected_employee.get("band"),
            },
        })

    def refresh_all_for_month(self):
        import re

        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        month = str(body.get("month", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            self.send_json({"error": "Month must use YYYY-MM format."}, HTTPStatus.BAD_REQUEST)
            return

        # Acquire the same lock used by auto-refresh so both subprocesses
        # never run simultaneously and exhaust Render's 512 MB RAM limit.
        if not _refresh_lock.acquire(blocking=True, timeout=10):
            self.send_json({
                "status": "busy",
                "message": "A data refresh is already running. Please wait a minute and try again.",
            }, HTTPStatus.ACCEPTED)
            return
        try:
            result = subprocess.run(
                [sys.executable, "-u", str(GENERATOR), "--month", month, "--out", str(DATA_FILE_MONTH)],
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            _refresh_lock.release()
        # Always surface subprocess output so Render logs show GreytHR/API warnings
        print(f"[refresh-month] process exited with code {result.returncode}", flush=True)
        for line in result.stdout.splitlines():
            print(f"[refresh-month] {line}", flush=True)
        for line in result.stderr.splitlines():
            print(f"[refresh-month:err] {line}", flush=True)
        if result.returncode != 0:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "Data could not be refreshed for that month. Check API connectivity and try again.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        try:
            data = json.loads(DATA_FILE_MONTH.read_text(encoding="utf-8-sig"))
        except Exception:
            data = {}
        if not data.get("employees"):
            # Extract the most descriptive error line from generator output
            diag = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "",
            )
            message = diag or f"No employee data was generated for {month}. Check Worklogix API connectivity."
            self.send_json({"status": "failed", "message": message}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        # Save a permanent month snapshot so Tara can answer month-specific questions
        try:
            months_dir = PROJECT_ROOT / "data" / "months"
            months_dir.mkdir(exist_ok=True)
            (months_dir / f"{month}.json").write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8"
            )
            print(f"[refresh-month] saved Tara snapshot → data/months/{month}.json", flush=True)
        except Exception as e:
            print(f"[refresh-month] WARNING: could not save months snapshot: {e}", flush=True)

        self.send_json({
            "status": "refreshed",
            "month": month,
            "period": data.get("meta", {}).get("period", ""),
            "employees": len(data.get("employees", [])),
            "data": data,
        })

    def refresh_teams(self):
        result = subprocess.run(
            [sys.executable, str(TEAMS_REFRESHER)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            data = self.load_data()
            teams_data = [
                {
                    "id": emp.get("id"),
                    "name": emp.get("name"),
                    "team": emp.get("team"),
                    "designation": emp.get("designation"),
                    "sourceConfidence": emp.get("sourceConfidence"),
                    **emp.get("teams", {}),
                }
                for emp in (data.get("employees", []) if data else [])
            ]
            self.send_json({
                "status": "refreshed",
                "message": result.stdout.strip(),
                "teamsRefreshedAt": time.time() * 1000,
                "teams": teams_data,
            })
        else:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "Teams data refresh failed. Check server logs.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_github(self):
        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        month = ""
        if length:
            try:
                body = json.loads(self.rfile.read(length))
                month = body.get("month", "")
            except (json.JSONDecodeError, ValueError):
                pass
        cmd = [sys.executable, str(GITHUB_REFRESHER)]
        if month:
            cmd += ["--month", month]
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            github_data = self.load_github_data()
            self.send_json({
                "status": "refreshed",
                "message": result.stdout.strip(),
                "lastUpdated": (github_data or {}).get("lastUpdated", ""),
                "github": github_data,
            })
        else:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "GitHub data refresh failed. Check server logs.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_graph(self):
        length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
        month = ""
        if length:
            try:
                body = json.loads(self.rfile.read(length))
                month = body.get("month", "").strip()
            except (json.JSONDecodeError, ValueError):
                pass
        cmd = [sys.executable, str(GRAPH_REFRESHER)]
        if month:
            cmd += ["--month", month]
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            graph_data = self.load_graph_data()
            self.send_json({
                "status": "refreshed",
                "message": result.stdout.strip(),
                "generatedAt": (graph_data or {}).get("meta", {}).get("generatedAt", ""),
                "graph": graph_data,
            })
        else:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "Graph activity refresh failed. Check server logs.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def load_github_data(self):
        if not GITHUB_DATA_FILE.exists():
            return {"projects": [], "contributors": [], "lastUpdated": None}
        try:
            return json.loads(GITHUB_DATA_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"projects": [], "contributors": [], "lastUpdated": None}

    def load_graph_data(self):
        if not GRAPH_DATA_FILE.exists():
            return {
                "meta": {"generatedAt": None},
                "overview": {},
                "employees": [],
                "planner": {"plans": []},
                "sharePoint": {"sites": []},
            }
        try:
            return json.loads(GRAPH_DATA_FILE.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, OSError):
            return {
                "meta": {"generatedAt": None},
                "overview": {},
                "employees": [],
                "planner": {"plans": []},
                "sharePoint": {"sites": []},
            }

    def fetch_real_data(self):
        result = subprocess.run(
            [sys.executable, str(API_FETCHER)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            self.send_json({"status": "fetched"})
        else:
            detail = next(
                (line[len("ERROR:"):].strip() for line in result.stderr.splitlines() if line.startswith("ERROR:")),
                "API data fetch failed. Check server logs.",
            )
            self.send_json({"status": "failed", "message": detail}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_full(self):
        """Trigger full pipeline in background — returns immediately with 202.
        Poll /api/health for lastFullRefresh to know when it finishes."""
        if _refresh_lock.locked():
            self.send_json({"status": "already_running", "message": "A full refresh is already in progress."}, HTTPStatus.ACCEPTED)
            return
        t = threading.Thread(target=_run_full_refresh_pipeline, daemon=True, name="manual-refresh")
        t.start()
        self.send_json({"status": "started", "message": "Full refresh started in background. Check /api/health for lastFullRefresh when done."}, HTTPStatus.ACCEPTED)

    def handle_chat(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        question = str(body.get("question", "")).strip()
        history = body.get("history", [])
        active_month = str(body.get("activeMonth", "")).strip() or None
        if not isinstance(history, list):
            history = []
        if not question:
            self.send_json({"error": "No question provided."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            reply, category = tara_answer(question, history, active_month=active_month)
            self.send_json({"answer": reply, "category": category})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            msg = str(exc)
            if "429" in msg or "rate_limit" in msg.lower() or "rate limit" in msg.lower() or "too many requests" in msg.lower():
                friendly = "Tara is getting a lot of questions right now. Please wait a few seconds and try again."
            elif "503" in msg or "over capacity" in msg.lower():
                friendly = "Tara is a bit busy right now. Please try again in a few seconds."
            elif "401" in msg or "invalid_api_key" in msg.lower():
                friendly = "There's an issue with the AI configuration. Please contact your admin."
            else:
                friendly = "Something went wrong on my end. Please try again."
            self.send_json({"answer": friendly}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def load_data(self):
        try:
            data = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
            return _merge_mtm_sprint_data(data)
        except FileNotFoundError:
            self.send_json({
                "error": "Data file not found",
                "hint": "Run python scripts/generate_peopleops_data.py first.",
            }, HTTPStatus.INTERNAL_SERVER_ERROR)
        except json.JSONDecodeError as exc:
            self.send_json({
                "error": "Data file is not valid JSON",
                "detail": str(exc),
            }, HTTPStatus.INTERNAL_SERVER_ERROR)
        return None

    @staticmethod
    def find_employee(data, employee_id):
        wanted = employee_id.strip().lower()
        return next(
            (
                employee
                for employee in data.get("employees", [])
                if str(employee.get("id", "")).lower() == wanted
            ),
            None,
        )

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html, status=HTTPStatus.OK):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def guess_type(self, path):
        guessed = mimetypes.guess_type(path)[0]
        return guessed or super().guess_type(path)


def _acquire_instance_lock(port: int):
    """Prevent multiple PeopleOPS processes from serving stale code on one port."""
    global _instance_lock
    if os.name != "nt":
        return
    import msvcrt

    lock_path = PROJECT_ROOT / "data" / f".server-{port}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        handle.close()
        raise RuntimeError(
            f"PeopleOPS is already running on port {port}. "
            "Stop the existing backend before starting another copy."
        ) from exc
    _instance_lock = handle


def _run_full_refresh_pipeline():
    """Run the full data pipeline in a background thread (no HTTP context)."""
    global _last_full_refresh
    if not _refresh_lock.acquire(blocking=False):
        print("Auto-refresh: another refresh already running, skipping.", flush=True)
        return
    try:
        print("Auto-refresh: starting full data pipeline...", flush=True)
        current_month = time.strftime("%Y-%m")
        steps = [
            ("generate", [sys.executable, str(GENERATOR), "--month", current_month]),
            ("teams",    [sys.executable, str(TEAMS_REFRESHER)]),
            ("github",   [sys.executable, str(GITHUB_REFRESHER), "--month", current_month]),
            ("graph",    [sys.executable, str(GRAPH_REFRESHER), "--month", current_month]),
        ]
        for name, cmd in steps:
            r = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True, text=True, check=False)
            status = "OK" if r.returncode == 0 else "FAILED"
            print(f"Auto-refresh [{name}]: {status}", flush=True)
            if r.returncode != 0:
                print(r.stderr[:500], flush=True)
                return
        _last_full_refresh = time.time()
        print(f"Auto-refresh: complete at {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    finally:
        _refresh_lock.release()


def _auto_refresh_loop():
    """Background thread: refresh all data every AUTO_REFRESH_INTERVAL seconds.
    Skips the startup run so committed data is served immediately on deploy."""
    time.sleep(AUTO_REFRESH_INTERVAL)
    while True:
        _run_full_refresh_pipeline()
        time.sleep(AUTO_REFRESH_INTERVAL)


def run(port=8000, host="0.0.0.0"):
    _acquire_instance_lock(port)
    # Start background auto-refresh (runs once on startup then every 24 h)
    t = threading.Thread(target=_auto_refresh_loop, daemon=True, name="auto-refresh")
    t.start()
    server = ThreadingHTTPServer((host, port), PeopleOpsHandler)
    print(f"PeopleOPS Intelligence backend running on {host}:{port}", flush=True)
    print(f"API health endpoint available at /api/health on port {port}", flush=True)
    print(f"Auto-refresh scheduled every {AUTO_REFRESH_INTERVAL // 3600}h (startup run skipped; first run in {AUTO_REFRESH_INTERVAL // 3600}h)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    selected_port = int(os.environ.get("PORT", 8000))
    run(selected_port)
