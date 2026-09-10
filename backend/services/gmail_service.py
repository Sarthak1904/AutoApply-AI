"""Gmail service — OAuth authentication and OTP extraction for AutoApply."""

import base64
import json
import logging
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"
CREDENTIALS_PATH = DATA_DIR / "gmail_credentials.json"
TOKEN_PATH = DATA_DIR / "gmail_token.json"

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Workday sends verification emails from these domains
WORKDAY_SENDER_PATTERNS = [
    "workday",
    "myworkday",
    "wd",
    "noreply",
]

# OTP patterns: 6-digit codes common in Workday emails
OTP_PATTERNS = [
    r"\b([0-9]{6})\b",                           # plain 6-digit code
    r"verification code[:\s]+([0-9]{6})",        # "verification code: 123456"
    r"one.?time.?(?:code|password)[:\s]+([0-9]{6})",  # OTP labels
    r"code is[:\s]+([0-9]{6})",                  # "code is 123456"
    r"code[:\s]+([0-9]{6})",                     # "code: 123456"
]


def _get_credentials():
    """Load OAuth2 credentials, refreshing if expired."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request

        if not TOKEN_PATH.exists():
            return None

        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
                _save_token(creds)
            else:
                return None

        return creds
    except Exception as e:
        logger.warning(f"Gmail credentials error: {e}")
        return None


def _save_token(creds) -> None:
    """Persist refreshed token to disk."""
    TOKEN_PATH.write_text(creds.to_json())


def get_gmail_service():
    """Return an authenticated Gmail API service, or None if not authorised."""
    try:
        from googleapiclient.discovery import build

        creds = _get_credentials()
        if not creds:
            return None
        return build("gmail", "v1", credentials=creds, cache_discovery=False)
    except Exception as e:
        logger.warning(f"Gmail service build failed: {e}")
        return None


def is_gmail_connected() -> bool:
    """Return True if a valid Gmail token exists and is usable."""
    return _get_credentials() is not None


def start_oauth_flow() -> str:
    """Return the Google OAuth authorization URL."""
    from google_auth_oauthlib.flow import Flow

    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError("Gmail credentials file not found in data directory.")

    flow = Flow.from_client_secrets_file(
        str(CREDENTIALS_PATH),
        scopes=SCOPES,
        redirect_uri="http://127.0.0.1:8000/auth/google/callback",
    )
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return auth_url


def exchange_code_for_token(code: str) -> bool:
    """Exchange an OAuth authorization code for a token and save it."""
    try:
        from google_auth_oauthlib.flow import Flow

        flow = Flow.from_client_secrets_file(
            str(CREDENTIALS_PATH),
            scopes=SCOPES,
            redirect_uri="http://127.0.0.1:8000/auth/google/callback",
        )
        flow.fetch_token(code=code)
        _save_token(flow.credentials)
        logger.info("Gmail OAuth token saved successfully.")
        return True
    except Exception as e:
        logger.error(f"Gmail token exchange failed: {e}")
        return False


def _decode_message_body(message: dict) -> str:
    """Extract plain text from a Gmail message payload."""
    payload = message.get("payload", {})
    parts = payload.get("parts", [])

    def decode_part(part):
        data = part.get("body", {}).get("data", "")
        if data:
            try:
                return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            except Exception:
                return ""
        return ""

    # Single-part message
    if not parts:
        return decode_part(payload)

    # Multi-part: prefer text/plain
    for part in parts:
        if part.get("mimeType") == "text/plain":
            return decode_part(part)

    # Fallback: decode all parts
    return " ".join(decode_part(p) for p in parts)


def _extract_otp(text: str) -> Optional[str]:
    """Search text for a 6-digit OTP code using common patterns."""
    for pattern in OTP_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def get_latest_otp(max_age_minutes: int = 10) -> Optional[str]:
    """
    Read recent Gmail messages and extract a Workday OTP code.

    Searches emails received in the last `max_age_minutes` minutes
    that originate from Workday-related senders.

    Returns the OTP string (e.g. "483921") or None.
    """
    service = get_gmail_service()
    if not service:
        logger.warning("Gmail not connected — cannot fetch OTP.")
        return None

    try:
        # Build a query for recent messages likely to contain an OTP
        query = f"newer_than:{max_age_minutes}m (from:workday OR from:myworkday OR subject:verification OR subject:\"one-time\" OR subject:code)"

        result = service.users().messages().list(
            userId="me",
            q=query,
            maxResults=10,
        ).execute()

        messages = result.get("messages", [])
        if not messages:
            logger.debug("No recent OTP emails found.")
            return None

        for msg_ref in messages:
            msg = service.users().messages().get(
                userId="me",
                id=msg_ref["id"],
                format="full",
            ).execute()

            body = _decode_message_body(msg)
            snippet = msg.get("snippet", "")
            full_text = f"{snippet} {body}"

            otp = _extract_otp(full_text)
            if otp:
                logger.info(f"OTP found: {otp[:2]}****")
                return otp

        logger.debug("No OTP found in recent emails.")
        return None

    except Exception as e:
        logger.error(f"Gmail OTP fetch error: {e}")
        return None
