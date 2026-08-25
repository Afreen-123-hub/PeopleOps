from __future__ import annotations

import re

CATEGORY_KEYWORDS = {
    "employee360": [
        "employee 360", "360", "all data", "all details", "complete details",
        "full profile", "everything about", "complete profile", "tell me about",
        "deep dive", "overview of", "profile of",
    ],
    "risk_insight": [
        "at risk", "at-risk", "needs attention", "need attention", "who needs",
        "who should i", "talk to", "who to talk", "struggling",
        "concern", "worried about", "not performing", "red flag",
        "who is behind", "flag", "problem", "team health", "health check",
        "overall health", "attention needed", "management attention",
        "underperform", "underperforming", "poor performance", "inactive",
        "disengaged",
    ],
    "team_summary": [
        "team summary", "team comparison", "compare team", "compare the",
        "compare all team", "team compare", "team breakdown", "team overview",
        "by team", "each team", "across team", "team performance", "vs team",
        "team vs", "which team", "best team", "worst team", "completion rate for",
        "how is the team", "how is team", "team doing", "team's kpi",
        "teams kpi", "team headcount",
    ],
    "planner": [
        "planner", "planner plan", "planner task", "plan task", "assigned plan",
        "overdue planner", "microsoft planner", "planner board",
    ],
    "calendar": [
        "calendar", "meeting schedule", "meetings today", "meetings tomorrow",
        "appointment", "organizer", "attendee", "scheduled meeting",
        "upcoming meeting", "calendar event",
        "what meetings", "any meetings", "meeting today", "meeting tomorrow",
        "meetings scheduled", "scheduled today", "meetings for", "meetings are",
        "who has meetings", "meeting with", "when is the meeting",
        "what time is", "what's scheduled", "whats scheduled",
        "'s meetings", "his meetings", "her meetings", "their meetings",
        "show meetings", "list meetings", "meetings this week",
        "how many meetings", "all meetings", "meetings of", "meetings he",
        "meetings she", "meetings does", "meetings has", "how many meet",
        "show all meet", "meetings today", "meetings tomorrow",
    ],
    "sharepoint": [
        "sharepoint", "share point", "document library",
        "shared document", "sharepoint file", "sharepoint list", "sharepoint site",
    ],
    "performance": [
        "kpi", "performer", "performance", "score", "band", "high performance",
        "low performance", "need improvement", "needing improvement", "lagging",
        "top performer", "bottom performer", "rank", "ranking", "best", "worst",
        "rating", "productive", "productivity", "contributing", "contribution",
        "working well", "doing well", "how is", "is active", "performing",
        "output", "deliver", "achievement",
    ],
    "attendance": [
        "absent", "absence", "attendance", "present", "leave", "holiday",
        "week off", "missing", "greythr", "late", "half day", "lop",
        "frequently absent", "regularly absent", "miss office", "not coming",
        "coming to office", "office presence", "check in", "biometric",
        "punctuality", "punctual",
    ],
    "availability": [
        "online", "offline", "available", "busy", "away",
        "active now", "presence", "teams status", "working from",
        "currently online", "who is online", "who is offline",
        "status", "what is his status", "what is her status",
        "hours today", "hours in teams", "how many hours", "hours is she",
        "hours is he", "spent in teams", "time in teams",
        "in a call", "on a call", "in call", "who is in a call",
        "out of office", "ooo", "who is out of office", "who's out",
    ],
    "task": [
        "task", "worklogix", "completed", "pending", "blocked",
        "work item", "delivery", "deadline", "progress", "ticket",
        "updating", "not updated", "stale task", "overdue task",
        "backlog", "behind schedule", "on track", "sprint",
        "milestone", "project status", "task status", "project update",
        "who hasn't updated", "not updating", "task delivery",
    ],
    "efficiency": [
        "efficiency", "working hours", "office hours", "output",
        "weighted", "workload", "volume", "utilization", "hours spent",
    ],
    "github": [
        "github", "git", "pull request", "pr", "commit", "repo", "repository",
        "sprint", "milestone", "issue", "story", "epic",
        "in review", "backlog", "production",
        "contributor", "assignee", "project board", "kanban",
        "code", "merge", "branch",
    ],
}

# A handful of github's keywords ("sprint", "milestone", "issue", "backlog", "code",
# "contributor"...) are shared with task/performance and only mean "github" when the
# question is unambiguously about GitHub. This narrower set is what's safe to
# short-circuit on immediately in PRIORITY_ORDER below — the full list above still
# applies during scoring for questions that don't say "github"/"git" outright.
_GITHUB_STRONG_KEYWORDS = [
    "github", "git", "pull request", "commit", "repo", "repository",
    "kanban", "merge", "branch", "project board",
]

# Categories checked in this order before falling back to keyword scoring — earlier
# entries win on any match. Order matters: categories with unambiguous, specific
# keywords (a literal product/tool name) go first; risk_insight goes last because its
# vocabulary ("inactive", "problem", "flag", "concern") is the most generic and was
# previously hijacking sharepoint/other questions just for sharing a common word.
_PRIORITY_ORDER = (
    "github", "sharepoint", "calendar", "planner",
    "employee360", "team_summary", "risk_insight",
)


_GREETING_TOKENS = {
    "hi", "hello", "hii", "hey", "ok", "okay", "thanks", "thank",
    "good morning", "good afternoon", "good evening", "bye",
}

_GENERAL_OVERRIDE_KEYWORDS = (
    "advantage", "benefit", "help me", "what can you", "what do you", "who are you",
    "tell me about yourself", "capabilities", "what is tara", "how do you work",
)


def _keyword_pattern(keyword: str) -> str:
    """Build a regex alternation covering common English inflections (plural,
    -ing, -ed) of a single-word keyword, so a new phrasing doesn't need its own
    manual entry — "underperform" already covers "underperforming" this way,
    instead of the gap staying open until someone happens to hit it and report
    it. Multi-word phrases and non-alphabetic keywords just get an optional
    trailing "s" — verb inflection only makes sense for single words.
    """
    escaped = re.escape(keyword)
    if " " in keyword or not keyword.replace("'", "").isalpha():
        return escaped + r"s?"
    if keyword.endswith("e"):
        # Silent-e words drop the "e" before -ing (code -> coding) and just add
        # "d" for past tense (code -> coded) rather than the full "-ed".
        stem = re.escape(keyword[:-1])
        return f"(?:{escaped}[sd]?|{stem}ing)"
    return f"{escaped}(?:s|es|ing|ed)?"


def _contains_keyword(text: str, keyword: str) -> bool:
    """Whole-word/phrase match against common English inflections, not a raw
    substring check.

    Plain `kw in text` let short keywords match inside unrelated words — "pr"
    (pull requests) matched inside "project", "git" matched inside "digital".
    The left word-boundary fixes that. The inflection handling on the right
    means a keyword needs adding only once in its base form, not once per
    tense/plural — that's how gaps like "disengaged" (missing outright) or
    "underperforming" (only "underperform" was listed) kept slipping through.
    """
    return re.search(r"\b(?:" + _keyword_pattern(keyword) + r")\b", text) is not None


def classify(question: str) -> str:
    q = question.lower().strip()
    greeting_text = q.strip(" \t\r\n!?.,")

    if greeting_text in _GREETING_TOKENS or greeting_text in {"heyy", "hiii", "helloo", "yo"}:
        return "general"

    if any(_contains_keyword(q, kw) for kw in _GENERAL_OVERRIDE_KEYWORDS):
        return "general"

    # High-priority explicit categories — checked before scoring, most specific first
    for category in _PRIORITY_ORDER:
        keywords = _GITHUB_STRONG_KEYWORDS if category == "github" else CATEGORY_KEYWORDS[category]
        if any(_contains_keyword(q, keyword) for keyword in keywords):
            return category

    # Score remaining categories. Weight by keyword length, not just match count — a
    # generic single word ("score", "best") shouldn't outscore a specific one
    # ("punctuality", "efficiency") just because both matched once. Without this,
    # ties always favored whichever category happened to be defined earlier in the
    # dict (e.g. "show punctuality scores" landed on "performance" via "score" instead
    # of "attendance" via "punctuality", purely from dict ordering).
    scores = {cat: 0 for cat in CATEGORY_KEYWORDS}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if _contains_keyword(q, kw):
                scores[cat] += len(kw)
    best = max(scores, key=lambda c: scores[c])
    return best if scores[best] > 0 else "general"
