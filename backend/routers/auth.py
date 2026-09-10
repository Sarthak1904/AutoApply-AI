"""Auth router — Gmail OAuth flow and credential management endpoints."""

import json
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse, HTMLResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])

DATA_DIR = Path(__file__).parent.parent / "data"
WORKDAY_AUTH_PATH = DATA_DIR / "workday_auth.json"


# ─── Pydantic models ──────────────────────────────────────────────────────────

class WorkdayCredentials(BaseModel):
    email: str
    password: str


# ─── Gmail OAuth routes ───────────────────────────────────────────────────────

@router.get("/auth/google", include_in_schema=True)
def google_oauth_start():
    """Redirect the browser to the Google OAuth consent screen."""
    try:
        from backend.services.gmail_service import start_oauth_flow
        auth_url = start_oauth_flow()
        return RedirectResponse(url=auth_url)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"OAuth start error: {e}")
        raise HTTPException(status_code=500, detail=f"OAuth error: {e}")


@router.get("/auth/google/callback", include_in_schema=True)
def google_oauth_callback(code: Optional[str] = None, error: Optional[str] = None):
    """Handle the OAuth callback from Google, exchange code for token."""
    if error:
        return HTMLResponse(content=_result_page(
            success=False,
            message=f"Google denied access: {error}",
        ))

    if not code:
        return HTMLResponse(content=_result_page(
            success=False,
            message="No authorization code received.",
        ))

    try:
        from backend.services.gmail_service import exchange_code_for_token
        ok = exchange_code_for_token(code)
        if ok:
            return HTMLResponse(content=_result_page(
                success=True,
                message="Gmail connected! AutoApply can now read OTP codes from your inbox.",
            ))
        else:
            return HTMLResponse(content=_result_page(
                success=False,
                message="Token exchange failed. Check the backend logs.",
            ))
    except Exception as e:
        logger.error(f"OAuth callback error: {e}")
        return HTMLResponse(content=_result_page(
            success=False,
            message=f"Error: {e}",
        ))


@router.get("/api/gmail/status")
def gmail_status():
    """Return whether Gmail is connected and the token is valid."""
    try:
        from backend.services.gmail_service import is_gmail_connected
        connected = is_gmail_connected()
        return {
            "connected": connected,
            "message": "Gmail is connected and ready." if connected else "Gmail not connected. Visit /auth/google to authorise.",
        }
    except Exception as e:
        return {"connected": False, "message": str(e)}


@router.get("/api/gmail/otp")
def get_gmail_otp(max_age_minutes: int = 10):
    """
    Read the latest Workday OTP from Gmail.

    Searches emails received in the last `max_age_minutes` minutes.
    Returns the 6-digit code or null if not found.
    """
    try:
        from backend.services.gmail_service import get_latest_otp, is_gmail_connected
        if not is_gmail_connected():
            raise HTTPException(
                status_code=401,
                detail="Gmail not connected. Visit http://127.0.0.1:8000/auth/google to authorise.",
            )
        otp = get_latest_otp(max_age_minutes=max_age_minutes)
        return {"otp": otp, "found": otp is not None}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OTP fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Workday credentials ──────────────────────────────────────────────────────

@router.post("/api/credentials/workday")
def save_workday_credentials(creds: WorkdayCredentials):
    """Save Workday email and password locally. Never sent to any AI provider."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WORKDAY_AUTH_PATH.write_text(
        json.dumps({"email": creds.email, "password": creds.password}, indent=2)
    )
    WORKDAY_AUTH_PATH.chmod(0o600)  # owner read/write only
    logger.info("Workday credentials saved.")
    return {"ok": True, "message": "Workday credentials saved locally."}


@router.get("/api/credentials/workday")
def get_workday_credentials():
    """
    Return saved Workday credentials.
    Password is included in full so the extension can fill the field locally.
    This endpoint is only reachable from localhost / the installed extension.
    """
    if not WORKDAY_AUTH_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="No Workday credentials saved. POST to /api/credentials/workday first.",
        )
    try:
        data = json.loads(WORKDAY_AUTH_PATH.read_text())
        return {
            "email": data.get("email", ""),
            "password": data.get("password", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read credentials: {e}")


# ─── Helper ───────────────────────────────────────────────────────────────────

def _result_page(success: bool, message: str) -> str:
    color = "#1e9e78" if success else "#c0392b"
    icon = "✓" if success else "✕"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AutoApply — Gmail Auth</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }}
    .card {{ background: #161b22; border: 1px solid #30363d; border-radius: 12px;
             padding: 40px 48px; max-width: 440px; text-align: center; }}
    .icon {{ font-size: 48px; color: {color}; margin-bottom: 12px; }}
    h1 {{ font-size: 20px; margin: 0 0 12px; }}
    p {{ color: #8b949e; line-height: 1.6; margin: 0 0 24px; }}
    a {{ color: #58a6ff; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">{icon}</div>
    <h1>{"Success" if success else "Error"}</h1>
    <p>{message}</p>
    <a href="http://127.0.0.1:8000/dashboard">← Back to AutoApply dashboard</a>
  </div>
</body>
</html>"""
