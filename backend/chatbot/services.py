from __future__ import annotations

from .classifier import classify
from .data_router import route
from .gemini_service import ask_gemini


def answer(question: str, history: list | None = None) -> tuple[str, str]:
    greeting = question.lower().strip().strip(" \t\r\n!?.,")
    if greeting in {
        "hi", "hii", "hiii", "hello", "helloo", "hey", "heyy", "yo",
        "ok", "okay", "thanks", "thank", "good morning", "good afternoon",
        "good evening", "bye",
    }:
        return (
            "Hello! Ask me about performance, attendance, Teams, Worklogix, "
            "Planner, Calendar, SharePoint, or GitHub.",
            "general",
        )
    category = classify(question)
    data = route(category, question, history)
    if data.get("employee") and any(
        key in data for key in ("plannerTasks", "calendarEvents", "sharePointResources", "healthVerdict")
    ):
        category = "employee360"
    try:
        reply = ask_gemini(question, data, category, history)
    except RuntimeError as exc:
        error = str(exc).lower()
        if "429" in error or "rate limit" in error:
            reply = (
                "Tara is receiving several requests at once. Please wait about "
                "20 seconds and ask again."
            )
        else:
            raise
    return reply, category
