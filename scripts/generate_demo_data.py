"""Build the demo dataset in data/demo/ from the real data files.

The demo login (see backend/server.py) reads only data/demo/, so a demo can show every page
without showing real people. This copies the shape of each real file and replaces everything
that identifies a person, client or company: names, ids, emails, Teams/Azure ids, GitHub logins,
project/plan/site/file names, meeting subjects and descriptions, links and office names. KPI
scores and activity numbers are shifted a little per person, so a real person's numbers can't be
read off a fake name either.

Strings are handled by an allowlist: a field is copied as-is only if its key is known to hold a
date, a time or a fixed label (status, band, team, ...). Any other text is replaced. At the end,
every output file is searched for leftover real names, ids, emails, logins and project names, and
the script fails if it finds any.

Run after the real data changes:  python scripts/generate_demo_data.py
"""
from __future__ import annotations

import hashlib
import json
import re
import statistics
import sys
import uuid
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC = PROJECT_ROOT / "data"
OUT = SRC / "demo"

DEMO_DOMAIN = "acme-demo.example"
DEMO_ORG = "Acme-Demo"
DEMO_URL = "https://example.com/demo"

FIRST_NAMES = [
    "Aarav", "Aditi", "Akash", "Amara", "Ananya", "Arjun", "Avani", "Bhavin", "Chetan", "Dev",
    "Diya", "Esha", "Farah", "Gautam", "Hari", "Ira", "Ishaan", "Jaya", "Kabir", "Kavya",
    "Lakshmi", "Leena", "Madhav", "Maya", "Mihir", "Naina", "Neel", "Nisha", "Ojas", "Pallavi",
    "Pranav", "Rhea", "Rohan", "Saanvi", "Samir", "Sana", "Tanvi", "Tara", "Uday", "Vani",
    "Varun", "Veda", "Yash", "Zoya", "Aryan", "Bina", "Charu", "Daksh", "Elina", "Gita",
    "Harsh", "Indu", "Jatin", "Kiran", "Lavanya", "Manav", "Nikhil", "Omkar", "Pooja", "Raghav",
    "Ritika", "Shaan", "Shreya", "Tejas", "Uma", "Vihaan", "Aisha", "Kunal", "Mira", "Neha",
]
LAST_NAMES = [
    "Acharya", "Bansal", "Chopra", "Desai", "Gill", "Iyer", "Joshi", "Kapoor", "Kulkarni", "Malhotra",
    "Mehta", "Nair", "Pandey", "Patel", "Rao", "Saxena", "Sethi", "Shah", "Sinha", "Thakur",
    "Trivedi", "Varma", "Bhatt", "Chawla", "Dutta", "Gupta", "Jain", "Khanna", "Menon", "Mishra",
    "Oberoi", "Pillai", "Reddy", "Sharma", "Tandon", "Walia", "Bose", "Das", "Ghosh", "Kohli",
]
PROJECT_NAMES = [
    "Atlas", "Beacon", "Cascade", "Delta", "Ember", "Falcon", "Granite", "Harbor", "Ion", "Juniper",
    "Keystone", "Lumen", "Meridian", "Nimbus", "Orbit", "Pioneer", "Quartz", "Radiant", "Summit", "Tundra",
    "Unity", "Vertex", "Willow", "Xenon", "Yonder", "Zephyr", "Aurora", "Bastion", "Comet", "Drift",
    "Echo", "Fable", "Glacier", "Horizon", "Iris", "Jade", "Kite", "Lotus", "Mosaic", "Nova",
    "Onyx", "Prism", "Quest", "Ripple", "Sable", "Tidal", "Umbra", "Vista", "Wave", "Zenith",
    "Amber", "Birch", "Cedar", "Dune", "Ember Mobile", "Flint", "Grove", "Haven", "Indigo", "Jetstream",
]
TASK_TITLES = [
    "Fix login redirect on mobile", "Add export to CSV", "Update dashboard filters", "Write API tests",
    "Improve page load time", "Refactor settings page", "Add dark mode support", "Fix date picker bug",
    "Design onboarding screens", "Set up staging alerts", "Review access permissions", "Clean up old reports",
    "Add search to user list", "Fix notification emails", "Prepare release notes", "Migrate config to env vars",
    "Add audit trail view", "Improve error messages", "Update user guide", "Add pagination to tables",
]
MEETING_SUBJECTS = [
    "Team stand-up", "Sprint planning", "Sprint review", "1:1 check-in", "Design review",
    "Client sync", "Retrospective", "Architecture discussion", "Release planning", "All-hands",
    "Demo prep", "Hiring sync", "Training session", "Product roadmap review", "QA sync",
]
GROUP_NAMES = [
    "Engineering", "Product", "Operations", "People Team", "Sales", "Marketing", "Leadership",
    "Support", "Design", "Finance", "Training", "Projects", "Quality", "Infrastructure", "Research",
    "Customer Success", "Data", "Security", "Mobile", "Platform", "Analytics", "Partnerships", "Recruiting",
    "Learning", "Facilities", "Strategy", "Content", "Community", "Delivery", "Innovation", "Compliance",
    "Web", "Cloud", "Interns", "Events", "Admin", "Field Team", "Growth", "Release", "QA Team", "Documentation",
]
FILE_NAMES = ["Reports", "Shared Documents", "Templates", "Policies", "Meeting Notes", "Archive", "Plans", "Assets"]

# Company / client / office names that can sit inside otherwise-safe labels (team, designation,
# office location), replaced wherever they appear. Matched case-insensitively.
SUBSTRING_REPLACEMENTS = [
    (r"codework\s*ai|codeworkai|code\s*work", "Acme"),
    (r"cplc", "Campus"),
    (r"sspdl", "Tower B"),
    (r"akshaya", "Main"),
]
# Words that must not appear anywhere in the output (checked at the end).
FORBIDDEN_WORDS = ["codework", "cplc", "sspdl", "akshaya", "trustamend", "trust amend", "oman", "edubot", "worklogix.ai"]

# Keys whose string values are dates, times or fixed labels: copied (after SUBSTRING_REPLACEMENTS).
SAFE_KEYS = {
    "status", "band", "quadrant", "roleCategory", "showAs", "state", "priority", "size", "type", "template",
    "team", "designation", "door", "officeLocation", "s", "sprint", "verification", "dataMode",
    "calendarTimeZone", "source", "period", "workLocation", "gapReason", "insufficientReason",
    "laggingDrivers", "missingSources", "categories", "month", "fetchedAt", "fullAt", "generatedAt",
    "lastUpdated", "since", "until", "periodStart", "periodEnd", "start", "end", "createdAt", "closedAt",
    "startDate", "endDate", "startDateTime", "dueDateTime", "completedDateTime", "lastActivity",
    "lastModifiedDateTime", "lastActivityDate", "wfh", "wfhAsOf", "bs", "bi", "bo", "rs", "wi", "wo", "mob",
    "note", "dateOfJoining", "dates", "teamsRefreshedAt", "graphRefreshedAt", "percentComplete", "v",
}
URL_KEYS = {"webUrl", "webLink", "meetingLink", "url"}
ID_KEYS = {"id", "no", "user_id", "userId", "managerId", "teamsId", "planId", "groupId", "directReports", "assigneeIds"}
STANDARD_BANDS = {"Excellent", "Good", "Average", "Needs Improvement", "Critical"}

GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NUMERIC_RE = re.compile(r"^\d+$")


def _norm(value) -> str:
    """Same normalisation as services.greythr_api_client._normalise_match_key (used for "name:" aliases)."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _h(value: str, salt: str = "") -> int:
    return int(hashlib.sha256((salt + "|" + value).encode("utf-8")).hexdigest(), 16)


def _pick(pool: list[str], value: str, salt: str) -> str:
    return pool[_h(value, salt) % len(pool)]


def _unused(pool: list[str], value: str, salt: str, used: set[str]) -> str:
    """A pool entry picked from the value's hash, moving on to the next one if it's taken."""
    start = _h(value, salt)
    for i in range(len(pool)):
        name = pool[(start + i) % len(pool)]
        if name not in used:
            return name
    n = 2
    while f"{pool[start % len(pool)]} {n}" in used:
        n += 1
    return f"{pool[start % len(pool)]} {n}"


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _source_files() -> list[Path]:
    files = [SRC / n for n in ("peopleops-data.json", "github-data.json", "graph-activity.json", "org-hierarchy.json", "mtm-tasks.json")]
    for sub in ("months", "leave", "worklocation"):
        files += sorted((SRC / sub).glob("*.json")) if (SRC / sub).exists() else []
    return [f for f in files if f.exists()]


class Anonymizer:
    def __init__(self, sources: dict[Path, object]):
        self.id_map: dict[str, str] = {}
        self.name_by_norm: dict[str, str] = {}      # normalised real name -> fake name
        self.fake_name_by_id: dict[str, str] = {}
        self.login_map: dict[str, str] = {}
        self.email_map: dict[str, str] = {}
        self.project_map: dict[str, str] = {}
        self.group_map: dict[str, str] = {}
        self.unknown_keys: set[str] = set()
        self.real_tokens: set[str] = set()          # for the leak check
        self.real_names: set[str] = set()
        self._used_names: set[str] = set()
        self._collect(sources)

    # ---------- registry of real people ----------
    def _collect(self, sources):
        people: dict[str, str] = {}   # real id -> real name
        label_tokens: set[str] = set()  # words in job titles/teams ("Intern", "Testing"): not name leaks
        logins: set[str] = set()
        emails: set[str] = set()

        def visit(v):
            if isinstance(v, dict):
                pid = v.get("id") if isinstance(v.get("id"), str) else None
                no = v.get("no") if isinstance(v.get("no"), str) else None
                key = no or pid
                if key and "members" not in v and isinstance(v.get("name"), str) and re.match(r"^[A-Za-z]{2,}[A-Za-z0-9_-]*\d", key):
                    people.setdefault(key, v["name"])
                for label in ("team", "designation", "roleCategory"):
                    if isinstance(v.get(label), str):
                        label_tokens.update(re.findall(r"[a-z]+", v[label].lower()))
                if isinstance(v.get("user_id"), str):
                    people.setdefault(v["user_id"], "")
                gh = v.get("github")
                if isinstance(gh, dict) and gh.get("login"):
                    logins.add(str(gh["login"]))
                if isinstance(v.get("login"), str):
                    logins.add(v["login"])
                if isinstance(v.get("email"), str) and v["email"]:
                    emails.add(v["email"])
                for x in v.values():
                    visit(x)
            elif isinstance(v, list):
                for x in v:
                    visit(x)

        for data in sources.values():
            visit(data)

        name_tokens = {t for n in people.values() for t in re.findall(r"[a-z]+", n.lower())}
        first_pool = [n for n in FIRST_NAMES if n.lower() not in name_tokens]
        last_pool = [n for n in LAST_NAMES if n.lower() not in name_tokens]
        self._first_pool, self._last_pool = first_pool, last_pool

        for i, real_id in enumerate(sorted(people), start=1):
            self.id_map[real_id] = f"DEMO{i:03d}"
            real_name = people[real_id]
            fake = self._new_fake_name(real_id)
            self.fake_name_by_id[real_id] = fake
            if real_name:
                self.name_by_norm.setdefault(_norm(real_name), fake)
                self.real_names.add(real_name)
        for login in sorted(logins):
            self.login_map[login.lower()] = self._fake_login(login)
        for email in emails:
            self.email_map[email.lower()] = self._fake_email(email)

        self.real_tokens = {t for t in name_tokens if len(t) >= 4 and t not in label_tokens}
        self.real_ids = set(self.id_map)
        self.real_logins = {l for l in self.login_map if len(l) >= 5}
        self.real_emails = set(self.email_map)

    def _new_fake_name(self, seed: str) -> str:
        n = _h(seed, "name")
        for attempt in range(len(self._first_pool) * len(self._last_pool)):
            first = self._first_pool[(n + attempt) % len(self._first_pool)]
            last = self._last_pool[(n // 7 + attempt * 3) % len(self._last_pool)]
            name = f"{first} {last}"
            if name not in self._used_names:
                self._used_names.add(name)
                return name
        return f"Person {n % 10000}"

    def fake_name(self, real_name: str) -> str:
        if not real_name.strip():
            return real_name
        key = _norm(real_name)
        if key not in self.name_by_norm:
            self.name_by_norm[key] = self._new_fake_name("extra:" + key)
            self.real_names.add(real_name)
        return self.name_by_norm[key]

    def _fake_login(self, login: str) -> str:
        first = _pick(self._first_pool, login, "login").lower()
        return f"{first}-{_h(login, 'login') % 900 + 100}"

    def _fake_email(self, email: str) -> str:
        local = email.split("@", 1)[0]
        return f"user{_h(local, 'email') % 100000:05d}@{DEMO_DOMAIN}"

    def fake_id(self, real_id: str) -> str:
        if real_id in self.id_map:
            return self.id_map[real_id]
        if not real_id or NUMERIC_RE.match(real_id):
            return real_id  # GreytHR row numbers: not identifying
        if GUID_RE.match(real_id):
            return str(uuid.uuid5(uuid.NAMESPACE_URL, "peopleops-demo:" + real_id))
        # Opaque ids (calendar/planner/SharePoint item ids, project codes): same length, random-looking.
        digest = hashlib.sha256(("id|" + real_id).encode()).hexdigest()
        return (digest * (len(real_id) // 64 + 1))[: max(8, min(len(real_id), 40))]

    def project(self, real: str) -> str:
        if not real.strip():
            return real
        key = _norm(real)
        if key not in self.project_map:
            self.project_map[key] = _unused(PROJECT_NAMES, key, "project", set(self.project_map.values()))
        return self.project_map[key]

    def group(self, real: str) -> str:
        if not real.strip():
            return real
        archived = real.startswith("[ARCHIVED]")
        key = _norm(real.replace("[ARCHIVED]", ""))
        if key not in self.group_map:
            self.group_map[key] = _unused(GROUP_NAMES, key, "group", set(self.group_map.values()))
        return ("[ARCHIVED] " if archived else "") + self.group_map[key]

    # ---------- numbers ----------
    @staticmethod
    def kpi_delta(person_id: str) -> float:
        return round((_h(person_id, "kpi") % 901) / 100 - 3, 1)  # -3.0 .. +6.0

    @staticmethod
    def factor(person_id: str, key: str) -> float:
        return 0.8 + (_h(person_id + key, "f") % 401) / 1000  # 0.8 .. 1.2

    # ---------- the walk ----------
    def string(self, value: str, key: str, path: tuple, kind: str) -> str:
        if not value:
            return value
        if EMAIL_RE.match(value):
            return self.email_map.get(value.lower()) or self._fake_email(value)
        if key in URL_KEYS or value.startswith(("http://", "https://")):
            return DEMO_URL
        if key in ID_KEYS or key in {"worklogix", "greythr", "teams", "biometric"} and "sourceKeys" in path:
            return self.fake_id(value)
        if GUID_RE.match(value):
            return self.fake_id(value)
        if key == "login" or (kind == "github" and key == "assignees"):
            return self.login_map.get(value.lower()) or self._fake_login(value)
        if key in {"managerName", "manager", "organizer", "owner", "attendees"} or (key == "assignees" and kind != "github"):
            return self.fake_name(value)
        if key == "name":
            if "meta" == path[0]:
                return value
            if "files" in path:
                return _pick(FILE_NAMES, value, "file")
            if kind in ("peopleops", "months") and path[0] == "projects" and "memberStats" not in path:
                return self.project(value)
            return self.fake_name(value)
        if key in {"project", "projects"} or (kind == "github" and key == "title" and path[0] == "projects" and "items" not in path):
            return self.project(value)
        if key == "title" and kind == "graph" and "tasks" not in path:
            return self.group(value)
        if key in {"planTitle", "groupName", "displayName"}:
            return self.group(value)
        if key == "title":
            return _pick(TASK_TITLES, value, "task")
        if key == "subject":
            return _pick(MEETING_SUBJECTS, value, "meeting")
        if key in {"description", "bodyPreview"}:
            return ""
        if key == "location":
            return value if value == "Microsoft Teams Meeting" else "Conference Room"
        if key == "keys":  # leave aliases: row number, employee id or "name:<slug>"
            return self.dict_key(value)
        if "attendanceDays" in path:
            return self.scrub(value)
        if key == "org":
            return DEMO_ORG
        if key in SAFE_KEYS or (path and path[0] == "meta"):
            return self.scrub(value)
        self.unknown_keys.add(f"{kind}:{'.'.join(map(str, path))}")
        return "Demo"

    @staticmethod
    def scrub(value: str) -> str:
        for pattern, repl in SUBSTRING_REPLACEMENTS:
            value = re.sub(pattern, repl, value, flags=re.IGNORECASE)
        return value

    def dict_key(self, key: str) -> str:
        if key in self.id_map:
            return self.id_map[key]
        if key.startswith("name:"):
            return "name:" + _norm(self.fake_name(key[5:]))
        return key

    def walk(self, v, key: str = "", path: tuple = (), kind: str = "", person: str = ""):
        if isinstance(v, dict):
            if kind == "graph" and path == ("meta",):
                v = {**v, "errors": {}}
            pid = v.get("no") or v.get("id") or v.get("user_id")
            if isinstance(pid, str) and pid in self.id_map:
                person = pid
            out = {}
            for k, x in v.items():
                out[self.dict_key(k)] = self.walk(x, k, path + (k,), kind, person)
            if person and isinstance(v.get("kpi"), (int, float)) and v.get("band") in STANDARD_BANDS:
                out["band"] = _band_for_kpi(out["kpi"])
            return out
        if isinstance(v, list):
            return [self.walk(x, key, path, kind, person) for x in v]
        if isinstance(v, str):
            return self.string(v, key, path, kind)
        if isinstance(v, bool) or v is None or not person:
            return v
        return self.number(v, key, path, person)

    def number(self, v, key: str, path: tuple, person: str):
        if key == "kpi":
            return round(min(100.0, max(0.0, v + self.kpi_delta(person))), 1)
        if "scoreDrivers" in path:
            return round(min(100.0, max(0.0, v + self.kpi_delta(person + key))), 1)
        jitter_parents = {"teams", "calendar", "sharepoint", "sharePoint", "github", "worklogix"}
        jitter_keys = {"officeHours", "avgOfficeHours", "teamsAvailableHours", "teamsAwayHours", "teamsOfflineHours",
                       "hoursWorked", "tasks_assigned", "tasks_completed", "utilisation", "commits", "prs", "prsMerged",
                       "total", "done", "inProgress"}
        if key.startswith("is") or key in {"reports", "calendarDays"}:
            return v
        if (set(path) & jitter_parents and "attendance" not in path) or key in jitter_keys:
            scaled = v * self.factor(person, key)
            if isinstance(v, int):
                return int(round(scaled))
            return round(scaled, 2)
        return v


def _band_for_kpi(kpi: float) -> str:
    # Same thresholds as backend/server.py _band_for_kpi.
    if kpi >= 90:
        return "Excellent"
    if kpi >= 80:
        return "Good"
    if kpi >= 70:
        return "Average"
    if kpi >= 60:
        return "Needs Improvement"
    return "Critical"


def _kind(path: Path) -> str:
    rel = path.relative_to(SRC).as_posix()
    if rel.startswith("months/"):
        return "months"
    if rel.startswith("leave/"):
        return "leave"
    if rel.startswith("worklocation/"):
        return "worklocation"
    return {
        "peopleops-data.json": "peopleops", "github-data.json": "github", "graph-activity.json": "graph",
        "org-hierarchy.json": "org", "mtm-tasks.json": "mtm",
    }[rel]


def _shift_overview(data: dict) -> None:
    """Company-wide KPI averages are recomputed from the shifted per-person scores."""
    ov = data.get("overview")
    if not isinstance(ov, dict):
        return
    scored = sorted(e["kpi"] for e in data.get("employees", [])
                    if isinstance(e.get("kpi"), (int, float)) and e.get("band") in STANDARD_BANDS)
    if scored:
        ov["avgKpi"] = round(statistics.mean(scored), 1)
        ov["medianKpi"] = round(statistics.median(scored), 1)
        ov["topQuartile"] = round(scored[int(len(scored) * 0.75)], 1)
    bands: dict[str, int] = {}
    for e in data.get("employees", []):
        bands[e.get("band")] = bands.get(e.get("band"), 0) + 1
    if isinstance(data.get("bands"), dict):
        data["bands"] = {b: bands.get(b, 0) for b in data["bands"]}


def _leak_check(anon: Anonymizer, texts: dict[Path, str]) -> list[str]:
    problems = []
    checks = [
        ("employee id", anon.real_ids, False),
        ("email", anon.real_emails, False),
        ("github login", anon.real_logins, True),
        ("name", {n.lower() for n in anon.real_names if len(n) >= 4}, True),
        ("name part", anon.real_tokens, True),
        ("company/client word", set(FORBIDDEN_WORDS), True),
    ]
    for path, text in texts.items():
        lower = text.lower()
        for label, values, word in checks:
            for value in values:
                needle = value.lower()
                if needle not in lower:
                    continue
                if word and not re.search(r"(?<![a-z0-9])" + re.escape(needle) + r"(?![a-z0-9])", lower):
                    continue
                problems.append(f"{path.relative_to(OUT).as_posix()}: real {label} '{value}' still present")
    return problems


def main() -> int:
    sources = {p: _load(p) for p in _source_files()}
    anon = Anonymizer(sources)
    outputs: dict[Path, str] = {}
    for src, data in sources.items():
        kind = _kind(src)
        result = anon.walk(data, kind=kind)
        if kind in ("peopleops", "months"):
            _shift_overview(result)
        if kind == "leave":
            result["wfh"] = "ready"  # the demo never builds work-from-home data from GreytHR
        if kind == "peopleops" or kind == "months":
            result.setdefault("meta", {})["dataMode"] = "Demo data (not real people)"
        outputs[OUT / src.relative_to(SRC)] = json.dumps(result, ensure_ascii=False, separators=(",", ":"))

    if anon.unknown_keys:
        print("Replaced text in fields not on the allowlist (check these look right in the demo):")
        for k in sorted(anon.unknown_keys)[:40]:
            print("  ", k)

    problems = _leak_check(anon, outputs)
    if problems:
        print(f"ERROR: {len(problems)} possible real-data leaks; nothing written:", file=sys.stderr)
        for p in problems[:50]:
            print("  " + p, file=sys.stderr)
        return 1

    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    print(f"Wrote {len(outputs)} files to {OUT.relative_to(PROJECT_ROOT)} "
          f"({len(anon.id_map)} people, {len(anon.project_map)} projects). Leak check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
