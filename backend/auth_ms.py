from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.parse
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.teams_auth import load_teams_env

GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName"

_pending_states: dict[str, None] = {}


def _cfg() -> dict:
    load_teams_env()
    return {
        "tenant_id":     os.environ.get("TEAMS_TENANT_ID", "").strip(),
        "client_id":     os.environ.get("TEAMS_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("TEAMS_CLIENT_SECRET", "").strip(),
        "redirect_uri":  os.environ.get("SSO_REDIRECT_URI", "http://localhost:8000/auth/callback").strip(),
        "allowed":       {
            e.strip().lower()
            for e in os.environ.get("ALLOWED_EMAILS", "").split(",")
            if e.strip()
        },
    }


def login_url() -> str:
    cfg = _cfg()
    state = secrets.token_urlsafe(16)
    _pending_states[state] = None
    qs = urllib.parse.urlencode({
        "client_id":     cfg["client_id"],
        "response_type": "code",
        "redirect_uri":  cfg["redirect_uri"],
        "response_mode": "query",
        "scope":         "openid profile email User.Read",
        "state":         state,
        "prompt":        "select_account",
    })
    return f"https://login.microsoftonline.com/{cfg['tenant_id']}/oauth2/v2.0/authorize?{qs}"


def handle_callback(code: str, state: str) -> dict:
    """Exchange auth code for user profile. Returns dict with ok/email/name or ok/reason."""
    if state not in _pending_states:
        return {"ok": False, "reason": "Invalid or expired login session. Please try again."}
    _pending_states.pop(state, None)
    cfg = _cfg()

    # Exchange code for access token
    token_url = f"https://login.microsoftonline.com/{cfg['tenant_id']}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "grant_type":    "authorization_code",
        "client_id":     cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "code":          code,
        "redirect_uri":  cfg["redirect_uri"],
        "scope":         "openid profile email User.Read",
    }).encode()
    try:
        with urlopen(
            Request(token_url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST"),
            timeout=30,
        ) as r:
            token = json.loads(r.read())
    except (HTTPError, URLError, ValueError) as exc:
        return {"ok": False, "reason": f"Token exchange failed: {exc}"}

    access_token = token.get("access_token")
    if not access_token:
        return {"ok": False, "reason": "Microsoft did not return an access token."}

    # Fetch user profile from Graph
    try:
        with urlopen(
            Request(GRAPH_ME_URL, headers={"Authorization": f"Bearer {access_token}"}),
            timeout=15,
        ) as r:
            me = json.loads(r.read())
    except (HTTPError, URLError, ValueError) as exc:
        return {"ok": False, "reason": f"Could not fetch your Microsoft profile: {exc}"}

    email = (me.get("mail") or me.get("userPrincipalName") or "").strip().lower()
    name  = me.get("displayName", email)

    if cfg["allowed"] and email not in cfg["allowed"]:
        return {"ok": False, "reason": f"Access not granted for {email}. Contact your administrator."}

    return {"ok": True, "email": email, "name": name}
