"""Daily cron refresh — runs the full data pipeline (called by Render cron job)."""
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent

current_month = datetime.utcnow().strftime("%Y-%m")

steps = [
    ("generate", [sys.executable, str(PROJECT / "scripts" / "generate_peopleops_data.py"), "--month", current_month]),
    ("teams",    [sys.executable, str(PROJECT / "scripts" / "refresh_teams.py")]),
    ("github",   [sys.executable, str(PROJECT / "scripts" / "refresh_github.py")]),
    ("graph",    [sys.executable, str(PROJECT / "scripts" / "refresh_graph_activity.py")]),
]

print(f"Cron refresh started at {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC", flush=True)

failed = False
for name, cmd in steps:
    r = subprocess.run(cmd, cwd=str(PROJECT), capture_output=True, text=True)
    status = "OK" if r.returncode == 0 else "FAILED"
    print(f"[{name}] {status}", flush=True)
    if r.stdout:
        print(r.stdout[:1000], flush=True)
    if r.returncode != 0:
        print(r.stderr[:500], flush=True)
        failed = True
        break

if failed:
    print("Cron refresh FAILED — see errors above.", flush=True)
    sys.exit(1)

print(f"Cron refresh complete at {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC", flush=True)
