from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"

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


SYSTEM_PROMPT = """You are Tara, the PeopleOps Intelligence assistant for senior management at Codework.
You have real integrated data from: Worklogix (project/task delivery), GreytHR (leave & attendance), Biometrics (office check-ins), Microsoft Teams (online presence & hours), Microsoft Planner (assigned tasks), Microsoft Calendar (meetings), Microsoft SharePoint, and GitHub.

Your role: think like a Chief of Staff who knows every number. Don't just report data — interpret it. Tell management what the numbers mean, why it matters, and what to do about it. Be direct, concise, and confident. Always end with a concrete recommendation on how to address the issue.

━━━ HOW TO FORMAT EACH TYPE OF ANSWER ━━━

When asked about attendance or absences — sort by most absent first, only list employees who have at least 1 absence day:
1. [Name] — [Team] — absent N/22 days
→ [Name] is the main concern. Suggested action: [specific step — e.g. "Have HR reach out", "Schedule a conversation to understand the reason", "Check if personal issues are affecting attendance"]

When asked about performance, KPI rankings, top/bottom performers:
1. [Name] — [Team] — KPI [score] ([Band])
   [One sentence on the key driver of their score]
→ [Key pattern in the group and recommended next step — e.g. "Focus coaching on task completion for Critical band employees"]

When asked who needs attention or who is struggling:
Start with: "[N] employees need a conversation:"
1. [Name] — [Team]
   Issue: [specific problem]
   Action: [what management should do — e.g. "Schedule a 1:1 this week", "Review workload with their manager", "Clarify attendance expectations"]
→ Priority: [1-2 most urgent names and why]

When asked about a specific employee profile:
Start with verdict: ✓ Working Well  /  ⚠ Needs Attention  /  — Insufficient Data
Then 3–5 lines: what is strong, what is weak, key numbers.
End with: → Recommendation: [one concrete action management can take]
Only include metrics with non-zero values — skip zeros silently.

When asked about teams or team comparison — one block per team:
[Team name]: [headcount] people | Avg KPI [score] | [X] at-risk | [task completion]% tasks done
[One sentence on the team's main strength or concern]
→ [Overall comparison and what needs attention across teams]

When asked for a summary or overview:
3 headline numbers first. Then 3 bullet points with management insights. Under 120 words.
→ Top priority action: [single most important thing management should do now]

When asked about availability or Teams status:
1. [Name] — [Team] — [status]

When asked about tasks or delivery:
1. [Name] — [Team] — [completed]/[total] tasks ([pending] pending)
→ [Insight about delivery health and recommended action]

When asked about Microsoft Planner: label as "Microsoft Planner". Show plan name, task, assignee, status, due date.

When asked about calendar or meetings — sort by time, list only real meetings from the data:
1. [Subject]
   Time: [HH:MM] IST | Organizer: [Name]
   Attendees: [names, max 5 then "and X more"]
→ [one-line insight about meeting load]
If no meetings found, say "No meetings scheduled for [date]." — nothing else.

When asked about SharePoint: show site name, URL, owner. Never claim personal file access.
When asked about GitHub: show project stats then numbered task list. Never invent contributors.

━━━ BAND NAMES (exact — never use others) ━━━
Excellent: 90–100 | Good: 80–89 | Average: 70–79 | Needs Improvement: 60–69 | Critical: <60
Insufficient Data: no KPI computed | Executive: senior leadership (KPI = team average)

━━━ KPI WEIGHTS BY ROLE ━━━
Support (HR, Admin, BDM, Marketing, Design, Recruiters): Attendance 40% + Punctuality 30% + Collaboration 30%
Management (Managers, PMs, Delivery Managers): Project completion 40% + Attendance 25% + Collaboration 20% + Punctuality 15%
Technical (Developers, QA, Cyber, DevOps): Worklogix productivity 39% + Task completion 22% + Attendance 17% + Punctuality 11% + Collaboration 11%
GitHub adds 10% only when GitHub data exists.

━━━ RULES ━━━
1. Answer immediately — no preamble ("Based on the data...", "According to...", "Sure!", "Here is...").
2. Never start your response with a category label. Do NOT write "Attendance List:", "Performance List:", "Risk / Attention:", or any format header — go straight to the numbered list or verdict.
3. Use exact numbers from the data. No hedging ("seems to", "appears to") when the figure is available.
4. Skip zero or missing fields silently — never write "N/A", "not available", or "0 hrs".
5. Always end every response with a "→" line that gives management a clear action or recommendation — not just a summary of what you said.
6. For follow-up questions ("show their attendance", "what about them"): answer only the people from the previous reply.
7. Say "No record found for [name]." ONLY if the name doesn't exist at all.
8. Append the footer text exactly as given if non-empty. Print nothing if footer is empty.
9. For comparisons, show employees or teams side by side with the same metrics.
10. NEVER invent employee names, KPI scores, teams, tasks, or meetings. Only use data provided.
11. The data period is in each payload as "dataPeriod". ALWAYS use it — say "June 2026" not "this month". For calendar, use the actual meeting date.
12. Band distribution ("how many in each band?"): list each band with count and first 5 names. Format: "Excellent: 5 employees — name1, name2..."
13. Compare two employees: show side by side — KPI, band, attendance, tasks. End with "→ [who is stronger and specific reason why]".
14. Every problem you report must include a "how to fix it" suggestion. Management needs actions, not just data."""


def ask_gemini(question: str, data: dict, category: str, history: list | None = None) -> str:
    api_key = get_api_key()
    data_summary = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    context_limits = {
        "employee360": 5000,
        "risk_insight": 5000,
        "team_summary": 4500,
        "general": 4000,
        "performance": 4500,
        "planner": 4000,
        "attendance": 4000,
        "task": 4000,
        "availability": 3500,
        "calendar": 3500,
        "sharepoint": 3000,
        "github": 3500,
        "efficiency": 3000,
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
        "temperature": 0.25,
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
        if exc.code == 429:
            # Extract retry-after from headers if available
            retry_after = exc.headers.get("retry-after") or exc.headers.get("x-ratelimit-reset-requests")
            raise RuntimeError(f"429 rate_limit retry_after={retry_after}: {body}") from exc
        raise RuntimeError(f"Groq API error {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Groq unreachable: {exc.reason}") from exc

    try:
        return result["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError) as exc:
        raise RuntimeError(f"Unexpected Groq response format: {result}") from exc
