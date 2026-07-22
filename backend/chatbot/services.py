from __future__ import annotations

import time

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

    reply = None
    for attempt in range(3):
        try:
            reply = ask_gemini(question, data, category, history)
            break
        except RuntimeError as exc:
            error = str(exc).lower()
            if "429" in error or "rate limit" in error:
                if attempt < 2:
                    time.sleep(4 * (attempt + 1))
                    continue
                reply = "I'm getting a lot of requests right now — please try again in a moment."
            else:
                raise

    return reply, category
