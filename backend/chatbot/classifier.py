from __future__ import annotations

CATEGORY_KEYWORDS = {
    "employee360": [
        "employee 360", "360", "all data", "all details", "complete details",
        "full profile", "everything about", "complete profile", "tell me about",
        "deep dive", "overview of", "profile of",
    ],
    "risk_insight": [
        "at risk", "needs attention", "need attention", "who needs",
        "who should i", "talk to", "who to talk", "struggling",
        "concern", "worried about", "not performing", "red flag",
        "who is behind", "flag", "problem", "team health", "health check",
        "overall health", "attention needed", "management attention",
        "underperform", "poor performance", "inactive",
    ],
    "team_summary": [
        "team summary", "team comparison", "compare team", "compare the",
        "team breakdown", "team overview", "by team", "each team",
        "across team", "team performance", "vs team", "team vs",
        "which team", "best team", "worst team",
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
    ],
    "sharepoint": [
        "sharepoint", "share point", "document library",
        "shared document", "sharepoint file", "sharepoint list", "sharepoint site",
    ],
    "performance": [
        "kpi", "performer", "performance", "score", "band", "high performance",
        "low performance", "need improvement", "lagging", "top performer",
        "bottom performer", "rank", "ranking", "best", "worst", "rating",
        "productive", "productivity", "contributing", "contribution",
        "working well", "doing well", "how is", "is active", "performing",
        "output", "deliver", "achievement",
    ],
    "attendance": [
        "absent", "attendance", "present", "leave", "holiday", "week off",
        "missing", "greythr", "late", "half day", "lop", "frequently absent",
        "regularly absent", "miss office", "not coming", "coming to office",
        "office presence", "check in", "biometric",
    ],
    "availability": [
        "online", "offline", "available", "busy", "away",
        "active now", "presence", "teams status", "working from",
        "currently online", "who is online", "who is offline",
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


_GREETING_TOKENS = {
    "hi", "hello", "hii", "hey", "ok", "okay", "thanks", "thank",
    "good morning", "good afternoon", "good evening", "bye",
}

_GENERAL_OVERRIDE_KEYWORDS = (
    "advantage", "benefit", "help me", "what can you", "what do you", "who are you",
    "tell me about yourself", "capabilities", "what is tara", "how do you work",
)


def classify(question: str) -> str:
    q = question.lower().strip()
    greeting_text = q.strip(" \t\r\n!?.,")

    if greeting_text in _GREETING_TOKENS or greeting_text in {"heyy", "hiii", "helloo", "yo"}:
        return "general"

    if any(kw in q for kw in _GENERAL_OVERRIDE_KEYWORDS):
        return "general"

    # High-priority explicit categories — checked before scoring
    for category in ("employee360", "risk_insight", "team_summary", "planner", "calendar", "sharepoint"):
        if any(keyword in q for keyword in CATEGORY_KEYWORDS[category]):
            return category

    # Score remaining categories
    scores = {cat: 0 for cat in CATEGORY_KEYWORDS}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in q:
                scores[cat] += 1
    best = max(scores, key=lambda c: scores[c])
    return best if scores[best] > 0 else "general"
