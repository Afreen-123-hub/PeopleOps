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


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT_ROOT / "data" / "peopleops-data.json"
GENERATOR = PROJECT_ROOT / "scripts" / "generate_peopleops_data.py"
TEAMS_REFRESHER = PROJECT_ROOT / "scripts" / "refresh_teams.py"
API_FETCHER = PROJECT_ROOT / "scripts" / "fetch_real_api_data.py"
ENV_FILE = PROJECT_ROOT.parent / ".env"

SESSION_TTL = 8 * 3600  # 8 hours
_sessions: dict[str, float] = {}  # token -> expiry timestamp

PUBLIC_PATHS = {"/login.html", "/api/login", "/styles.css", "/favicon.ico"}


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
        if path == "/api/fetch-real-data":
            self.fetch_real_data()
            return
        self.send_json({"error": "Route not found"}, HTTPStatus.NOT_FOUND)

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


def run(port=8000):
    server = ThreadingHTTPServer(("localhost", port), PeopleOpsHandler)
    print(f"PeopleOPS Intelligence backend running at http://localhost:{port}")
    print("API health: http://localhost:{}/api/health".format(port))
    server.serve_forever()


if __name__ == "__main__":
    selected_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run(selected_port)
