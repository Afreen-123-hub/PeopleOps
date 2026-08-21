"""Read a sprint performance PDF (like Senthil's report) and post each MTM employee's
sprint data to the MTM task API as a pending batch, ready for manual verification.

Usage:
    python scripts/extract_mtm_sprint_report.py "C:\\path\\to\\Sprint Performance Report.pdf"

What it does:
    1. Extracts each developer's per-sprint table from the PDF (works off pdfplumber's
       table detection, not raw text, since the PDF's line-wrapping is inconsistent).
    2. Matches each PDF name against the known MTM employee list in peopleops-data.json —
       first by exact first-name match (reliable for this dataset), falling back to
       fuzzy full-name similarity. Anything that doesn't match confidently is reported,
       never silently guessed.
    3. Posts the matched rows to POST /api/mtm-tasks/batch on the server, same as if you'd
       typed them into Swagger by hand — they land as "pending", same as always, needing a
       human to check them in /verify before they count as anything.

Only ever creates "pending" entries — never marks anything verified. That step stays manual,
on purpose.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = PROJECT_ROOT / "data" / "peopleops-data.json"
ENV_FILE = PROJECT_ROOT.parent / ".env"


def load_env() -> dict[str, str]:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def normalize_name(name: str) -> list[str]:
    words = re.sub(r"[.\s]+", " ", name).strip().lower().split()
    return words


def match_employee(pdf_name: str, mtm_employees: list[dict]) -> tuple[dict | None, float]:
    """Match a PDF developer name against the known MTM employee list.
    Returns (employee_or_None, confidence 0-1).

    Only does an exact, unique first-name match — tested against the real report, this
    alone correctly found all genuine MTM matches with zero errors. A fuzzy full-name
    fallback was tried and removed: it produced false positives (e.g. matching
    "Shanmuga Priya", who isn't an MTM employee at all, onto "Geetha Shunmugavel" just
    from partial character overlap), which would have silently corrupted real data.
    Anything that doesn't match exactly is reported as unmatched, never guessed."""
    pdf_words = normalize_name(pdf_name)
    if not pdf_words:
        return None, 0.0
    pdf_first = pdf_words[0]
    first_name_matches = [
        e for e in mtm_employees if normalize_name(e["name"]) and normalize_name(e["name"])[0] == pdf_first
    ]
    if len(first_name_matches) == 1:
        return first_name_matches[0], 1.0
    return None, 0.0


def extract_sprint_rows(pdf_path: Path) -> list[dict]:
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        collapsed = re.sub(r"\s+", " ", full_text)
        name_blocks = re.findall(
            r"([A-Za-z][A-Za-z .]+?) \| ([^|]+?) \| Manager: ([A-Za-z ]+?) \| Completion: ([\d.]+)%",
            collapsed,
        )

        data_tables = []
        for page in pdf.pages:
            for table in page.extract_tables():
                if table and table[0] and table[0][0] == "Metric":
                    data_tables.append(table)

    if len(name_blocks) != len(data_tables):
        print(
            f"WARNING: found {len(name_blocks)} name blocks but {len(data_tables)} data tables — "
            "counts should match. Extraction may be unreliable for this file.",
            file=sys.stderr,
        )

    rows_by_person = []
    for (name, project, manager, completion_pct), table in zip(name_blocks, data_tables):
        sprint_cols = table[0][1:-1]  # skip "Metric" and "Total/Avg"
        assigned_row = table[1][1:-1]
        completed_row = table[2][1:-1]
        utilisation_row = table[3][1:-1]
        sprints = []
        for sprint, a, c, u in zip(sprint_cols, assigned_row, completed_row, utilisation_row):
            if a in (None, "-", "") or c in (None, "-", ""):
                continue
            sprints.append({
                "sprint": sprint,
                "tasks_assigned": int(a),
                "tasks_completed": int(c),
                "utilisation": float(u) if u not in (None, "-", "") else 0.0,
            })
        rows_by_person.append({"pdf_name": name.strip(), "project": project.strip(), "manager": manager.strip(), "sprints": sprints})
    return rows_by_person


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf_path", help="Path to the sprint performance report PDF")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="PeopleOps server base URL")
    parser.add_argument("--dry-run", action="store_true", help="Extract and match only, don't post anything")
    args = parser.parse_args()

    pdf_path = Path(args.pdf_path)
    if not pdf_path.exists():
        print(f"ERROR: file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(DATA_FILE.read_text(encoding="utf-8-sig"))
    mtm_employees = [e for e in data.get("employees", []) if e.get("isMtm")]
    print(f"Known MTM employees: {len(mtm_employees)}")

    people = extract_sprint_rows(pdf_path)
    print(f"Developers found in PDF: {len(people)}")
    print()

    matched_rows = []
    unmatched = []
    for person in people:
        emp, confidence = match_employee(person["pdf_name"], mtm_employees)
        if emp is None:
            unmatched.append(person["pdf_name"])
            continue
        print(f"  MATCH  {person['pdf_name']!r:35s} -> {emp['id']} {emp['name']} (confidence {confidence:.2f})")
        for s in person["sprints"]:
            matched_rows.append({
                "user_id": emp["id"],
                "sprint": s["sprint"],
                "tasks_assigned": s["tasks_assigned"],
                "tasks_completed": s["tasks_completed"],
                "utilisation": s["utilisation"],
            })

    print()
    print(f"Matched: {len(matched_rows)} sprint rows across {len({r['user_id'] for r in matched_rows})} MTM employees")
    if unmatched:
        print(f"NOT matched to any MTM employee (skipped, not posted): {unmatched}")
    print()

    if not matched_rows:
        print("Nothing to post.")
        return

    if args.dry_run:
        print("--dry-run set, not posting. Sample of what would be sent:")
        print(json.dumps(matched_rows[:3], indent=2))
        return

    env = load_env()
    username = env.get("PEOPLEOPS_USERNAME", "admin")
    password = env.get("PEOPLEOPS_PASSWORD", "")
    if not password:
        print("ERROR: PEOPLEOPS_PASSWORD not set in .env", file=sys.stderr)
        sys.exit(1)

    login_req = Request(
        f"{args.server}/api/login",
        data=json.dumps({"username": username, "password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(login_req, timeout=15) as resp:
            token = json.loads(resp.read())["token"]
    except (HTTPError, URLError) as exc:
        print(f"ERROR: login failed — {exc}", file=sys.stderr)
        sys.exit(1)

    batch_req = Request(
        f"{args.server}/api/mtm-tasks/batch",
        data=json.dumps({"rows": matched_rows}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urlopen(batch_req, timeout=30) as resp:
            result = json.loads(resp.read())
    except (HTTPError, URLError) as exc:
        print(f"ERROR: posting batch failed — {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"Posted successfully. Stored: {len(result['stored'])} entries, all as 'pending'.")
    print("Go review and verify them in the MTM Verification screen before they count as final.")
    if result.get("rejected_ids_not_in_system"):
        print(f"Rejected (not a known MTM employee id): {result['rejected_ids_not_in_system']}")
    if result.get("employees_missing_from_ppt"):
        print(f"Known MTM employees with no data in this file: {result['employees_missing_from_ppt']}")


if __name__ == "__main__":
    main()
