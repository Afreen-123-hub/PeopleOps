from __future__ import annotations

import json
import mimetypes
import os
import secrets
import subprocess
import sys
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chatbot.services import answer as tara_answer
from auth_ms import login_url as ms_login_url, handle_callback as ms_handle_callback


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT_ROOT / "data" / "peopleops-data.json"
GITHUB_DATA_FILE = PROJECT_ROOT / "data" / "github-data.json"
GRAPH_DATA_FILE = PROJECT_ROOT / "data" / "graph-activity.json"
GENERATOR = PROJECT_ROOT / "scripts" / "generate_peopleops_data.py"
TEAMS_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_teams.py"
GITHUB_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_github.py"
GRAPH_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_graph_activity.py"
API_FETCHER = PROJECT_ROOT / "scripts" / "fetch_real_api_data.py"
ENV_FILE = PROJECT_ROOT.parent / ".env"

SESSION_TTL = 8 * 3600  # 8 hours
_sessions: dict[str, float] = {}  # token -> expiry timestamp

PUBLIC_PATHS = {"/login.html", "/api/login", "/styles.css", "/favicon.ico", "/auth/login", "/auth/callback"}
_instance_lock = None


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
    expiry = _sessions.get(token)
    if expiry and expiry > time.time():
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
            if path == "/login.html":
                self.path = "/login.html"
            super().do_GET()
            return

        # Root → redirect to login if not authenticated, else serve dashboard
        if path == "/":
            self.path = "/index.html"
            super().do_GET()
            return

        if path.startswith("/api/"):
            if not self._require_auth():
                return
            self.handle_api_get(path)
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
        if path == "/api/chat":
            self.handle_chat()
            return
        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

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
        _sessions[token] = time.time() + SESSION_TTL
        name = quote(result.get("name", ""))
        self.send_response(302)
        self.send_header("Location", f"/login.html?sso_token={token}&sso_name={name}")
        self.end_headers()

    def handle_login(self):
        length = int(self.headers.get("Content-Length", 0))
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
            _sessions[token] = time.time() + SESSION_TTL
            self.send_json({"token": token, "expires_in": SESSION_TTL})
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

        routes = {
            "/api/health": lambda: {
                "status": "ok",
                "app": data.get("meta", {}).get("name", "PeopleOPS Intelligence"),
                "dataMode": data.get("meta", {}).get("dataMode", "Local sample files"),
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
            [sys.executable, str(GENERATOR)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            self.send_json({
                "status": "regenerated",
                "message": result.stdout.strip(),
            })
        else:
            self.send_json({
                "status": "failed",
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, HTTPStatus.INTERNAL_SERVER_ERROR)

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
                "teamsRefreshedAt": (data or {}).get("meta", {}).get("teamsRefreshedAt", ""),
                "teams": teams_data,
            })
        else:
            self.send_json({
                "status": "failed",
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_github(self):
        length = int(self.headers.get("Content-Length", 0))
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
            self.send_json({
                "status": "failed",
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, HTTPStatus.INTERNAL_SERVER_ERROR)

    def refresh_graph(self):
        result = subprocess.run(
            [sys.executable, str(GRAPH_REFRESHER)],
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
            self.send_json({
                "status": "failed",
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, HTTPStatus.INTERNAL_SERVER_ERROR)

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
            self.send_json({
                "status": "fetched",
                "message": result.stdout.strip(),
            })
        else:
            self.send_json({
                "status": "failed",
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_chat(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self.send_json({"error": "Invalid request body."}, HTTPStatus.BAD_REQUEST)
            return
        question = str(body.get("question", "")).strip()
        history = body.get("history", [])
        if not isinstance(history, list):
            history = []
        if not question:
            self.send_json({"error": "No question provided."}, HTTPStatus.BAD_REQUEST)
            return
        try:
            reply, category = tara_answer(question, history)
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
            return json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
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


def run(port=8000, host="0.0.0.0"):
    _acquire_instance_lock(port)
    server = ThreadingHTTPServer((host, port), PeopleOpsHandler)
    print(f"PeopleOPS Intelligence backend running on {host}:{port}", flush=True)
    print(f"API health endpoint available at /api/health on port {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    selected_port = int(os.environ.get("PORT", 8000))
    run(selected_port)
