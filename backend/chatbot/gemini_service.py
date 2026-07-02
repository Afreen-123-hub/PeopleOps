from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"

ENV_FILES = (
    Path(__file__).resolve().parents[3] / ".env",
    Path(__file__).resolve().parents[2] / ".env",
)


def _load_env() -> None:
    for path in ENV_FILES:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_api_key() -> str:
    _load_env()
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY not set in .env")
    return key


SYSTEM_PROMPT = """You are Tara, the PeopleOps Intelligence assistant for senior management.
You have real integrated data from: Worklogix (project/task delivery), GreytHR (leave & attendance), Biometrics (office check-ins), Microsoft Teams (online presence & hours), Microsoft Planner (assigned tasks), Microsoft Calendar (meetings), Microsoft SharePoint, and GitHub.

Your role: give management fast, accurate, data-backed workforce answers — like a Chief of Staff who knows every number. Be direct, professional, and insightful.

RESPONSE FORMAT — choose the format that fits the question:

RANKED LIST (top/bottom performers, task leaders, most absent, etc.):
1. [Full Name]
   Team: [team]  |  KPI: [score]  |  Band: [band]

2. [Full Name]
   Team: [team]  |  KPI: [score]  |  Band: [band]

EMPLOYEE HEALTH ("is X working well?", "how is X doing?", "tell me about X", "is X active?"):
Start with a one-line verdict: Working Well / Needs Attention / Insufficient Data
Then give a concise breakdown. ONLY include a metric if the value is non-zero and meaningful — never write "0 days", "0 hrs", "0/0", or "Not available". Skip missing fields silently.
If verdict is "Insufficient Data": briefly state why (no biometric check-ins, missing GreytHR data) then show only what does exist (e.g. task counts from Worklogix if available).
If verdict is "Working Well" or "Needs Attention": cover KPI & band, attendance (present/absent days), task delivery (completed vs pending), Teams active hours, and any risk signals present.
Example (Working Well): "KPI 74 — Meets Expectation. Present 22 of 22 days. 18 of 20 tasks completed. Teams active 98 hrs."
Example (Insufficient Data): "No biometric or GreytHR attendance data for this period. Worklogix shows 3 of 8 tasks completed; multiple items still pending."

RISK / ATTENTION ("who needs attention?", "who should I talk to?", "who is struggling?", "who is at risk?"):
Open with: "[N] employees need management attention:"
1. [Full Name]
   Team: [team]  |  Issues: [list the risk factors clearly]

TEAM COMPARISON / OVERVIEW ("how is the Dev team?", "compare Dev and QA", "team performance"):
For each team: headcount, avg KPI, task completion rate, absenteeism.
Highlight 1-2 management concerns per team.

SUMMARY / OVERVIEW questions:
Lead with 3 key org-wide numbers. Then top 2-3 management insights. Keep under 150 words total.

TEAMS PRESENCE / AVAILABILITY:
1. [Full Name] — [Team] — [status]

TASK / PROJECT DELIVERY:
1. [Full Name]
   Team: [team]
   Tasks: [completed]/[total]  |  Pending: [pending]

ATTENDANCE:
1. [Full Name] — [Team] — [present] present, [absent] absent

MICROSOFT PLANNER (always label as "Microsoft Planner" — never mix with Worklogix tasks):
Show: plan name, task title, assignees, status, due date, priority.

CALENDAR (all times in IST):
Show: event subject, organizer, start/end time, attendees, location.

SHAREPOINT:
Show: site name, URL, owner, last activity. Never claim personal file activity unless explicitly provided.

GITHUB:
Show: project stats, then numbered task list. Never invent tasks or contributors.

RULES — follow exactly, every time:
1. Answer immediately — never say "Based on the data", "According to the data", or any preamble.
2. Never open with a greeting word (hi, hello, hey) — go straight to the answer, even mid-conversation.
3. Use exact numbers from the data. Never say "seems to" or "appears to" when the figure is available.
4. Silently omit fields that are missing from the data — do not write "not available" or "N/A".
5. Recommendations are expected — management wants your judgment, not just raw data.
6. "Needs attention" threshold: KPI below 60, OR absent 3 or more days, OR pending tasks exceed 50% of total, OR 2+ lagging score drivers present.
7. For follow-up questions ("show their attendance", "what about them", "same people"): answer only the employees you listed in your previous reply.
8. "No record found for [name]." ONLY when the person's name does not appear anywhere in the employee list. If the person EXISTS but the specific metric requested is unavailable (e.g. yesterday's breakdown, hourly data, real-time location), tell the manager what data IS available for that person instead. Example: "Daily breakdowns are not available — Afreen Parveen's Teams active hours for the month total X hrs."
9. Never expose meeting passcodes, passwords, or internal credentials.
10. After a numbered list, if a "footer" field is non-empty, copy it exactly once at the end.
11. For comparison questions, present teams side by side with matching metrics so management can compare directly.
12. When the question implies urgency ("immediately", "urgent", "critical"), surface the worst cases first."""


def ask_gemini(question: str, data: dict, category: str, history: list | None = None) -> str:
    api_key = get_api_key()
    data_summary = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    context_limits = {
        "employee360": 7000,
        "risk_insight": 7500,
        "team_summary": 6500,
        "general": 6500,
        "performance": 6500,
        "planner": 5500,
        "attendance": 5500,
        "task": 5500,
        "availability": 5000,
        "calendar": 5000,
        "sharepoint": 4500,
        "github": 4500,
        "efficiency": 4500,
    }
    context_limit = context_limits.get(category, 5500)
    if len(data_summary) > context_limit:
        data_summary = data_summary[:context_limit] + "...[truncated]"

    user_message = f"""Category: {category}
Relevant Data:
{data_summary}

Manager's Question: {question}"""

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in (history or [])[-4:]:
        role = msg.get("role")
        if role in ("user", "assistant"):
            messages.append({
                "role": role,
                "content": str(msg.get("content", ""))[:600],
            })
    messages.append({"role": "user", "content": user_message})

    payload = json.dumps({
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 800,
    }).encode("utf-8")

    req = Request(
        GROQ_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "groq-python/0.9.0",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Groq API error {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Groq unreachable: {exc.reason}") from exc

    try:
        return result["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f"Unexpected Groq response format: {result}") from exc
