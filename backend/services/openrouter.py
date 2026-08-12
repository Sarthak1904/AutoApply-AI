"""OpenRouter API client — OpenAI-compatible interface for models like NVIDIA Nemotron.

Uses httpx to call https://openrouter.ai/api/v1/chat/completions with the
standard chat-completions format (system + user messages).
"""

import os
import time
import logging
import collections
import threading
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

from backend.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

# Load env from backend directory
_backend_dir = Path(__file__).parent.parent
load_dotenv(_backend_dir / ".env")

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
class _OpenRouterRateLimiter:
    """Simple token-bucket rate limiter for OpenRouter free tier."""

    def __init__(self, max_calls: int = 5, period: float = 60.0):
        self.max_calls = max_calls
        self.period = period
        self.calls: collections.deque = collections.deque()
        self.lock = threading.Lock()

    def wait_if_needed(self):
        while True:
            with self.lock:
                now = time.time()
                while self.calls and now - self.calls[0] > self.period:
                    self.calls.popleft()
                if len(self.calls) >= self.max_calls:
                    sleep_time = self.period - (now - self.calls[0]) + 0.1
                else:
                    self.calls.append(now)
                    return
            logger.info(f"OpenRouter rate limit: waiting {sleep_time:.1f}s...")
            time.sleep(sleep_time)


_rate_limiter = _OpenRouterRateLimiter(max_calls=5, period=60.0)


class OpenRouterClient(LLMClient):
    """OpenRouter API client with retry logic, compatible with the LLMClient interface."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY not found. Set it in backend/.env or pass it directly."
            )
        self._model = model or os.getenv("OPENROUTER_MODEL")
        if not self._model:
            raise ValueError("OPENROUTER_MODEL must be set explicitly in backend/.env.")
        self._privacy_mode = os.getenv("OPENROUTER_PRIVACY_MODE", "strict").strip().lower()
        self._http = httpx.Client(timeout=120.0)
        logger.info(f"OpenRouter client initialized with model: {self._model}")

    # -- LLMClient interface --------------------------------------------------

    @property
    def provider_name(self) -> str:
        return "openrouter"

    @property
    def model_name(self) -> str:
        return self._model

    def close(self) -> None:
        self._http.close()

    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """Generate text via OpenRouter chat completions API."""
        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/geckguy/AutoApply",
            "X-Title": "AutoApply",
        }

        payload = {
            "model": self._model,
            "messages": messages,
        }
        if self._privacy_mode == "strict":
            payload["provider"] = {"data_collection": "deny", "zdr": True}

        last_error = None
        for attempt in range(max_retries):
            try:
                _rate_limiter.wait_if_needed()

                response = self._http.post(
                    OPENROUTER_API_URL,
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()

                # Handle OpenRouter error responses embedded in 200 OK
                if "error" in data:
                    error_msg = data["error"].get("message", str(data["error"]))
                    raise RuntimeError(f"OpenRouter API error: {error_msg}")

                choices = data.get("choices", [])
                if not choices:
                    raise ValueError("OpenRouter returned no choices in response")

                content = choices[0].get("message", {}).get("content", "")
                if not content:
                    raise ValueError("OpenRouter returned empty content")

                return content

            except Exception as e:
                last_error = e
                error_str = str(e)

                response = getattr(e, "response", None)
                status_code = getattr(response, "status_code", None)
                if (
                    isinstance(status_code, int)
                    and 400 <= status_code < 500
                    and status_code not in {408, 409, 429}
                ):
                    raise RuntimeError(
                        f"OpenRouter rejected the request (HTTP {status_code}). "
                        "Check the API key and model configuration."
                    ) from e

                if attempt == max_retries - 1:
                    break

                # Exponential backoff: 3s, 6s, 12s, 24s, 48s
                wait_time = (2 ** attempt) * 3.0

                # Check for rate-limit retry-after hints
                if response is not None:
                    retry_after = response.headers.get("retry-after")
                    if retry_after:
                        try:
                            wait_time = float(retry_after) + 1.0
                        except ValueError:
                            pass

                logger.warning(
                    f"OpenRouter API attempt {attempt + 1}/{max_retries} failed. "
                    f"Retrying in {wait_time:.1f}s... Error: {error_str[:150]}"
                )
                time.sleep(wait_time)

        raise RuntimeError(
            f"OpenRouter API failed after {max_retries} attempts. Last error: {last_error}"
        )
