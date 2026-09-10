"""DeepSeek API client — OpenAI-compatible interface for DeepSeek V3 and R1 models.

Uses httpx to call https://api.deepseek.com/chat/completions with standard chat-completions format.
"""

import os
import time
import logging
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

from backend.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

# Load env from backend directory
_backend_dir = Path(__file__).parent.parent
load_dotenv(_backend_dir / ".env")

DEEPSEEK_API_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/chat/completions")


class DeepSeekClient(LLMClient):
    """DeepSeek API client with retry logic, compatible with the LLMClient interface."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise ValueError(
                "DEEPSEEK_API_KEY not found. Set it in backend/.env or pass it directly."
            )
        self._model = model or os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        self._http = httpx.Client(timeout=120.0)
        logger.info(f"DeepSeek client initialized with model: {self._model}")

    # -- LLMClient interface --------------------------------------------------

    @property
    def provider_name(self) -> str:
        return "deepseek"

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
        """Generate text via DeepSeek chat completions API."""
        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": self._model,
            "messages": messages,
        }

        last_error = None
        for attempt in range(max_retries):
            try:
                response = self._http.post(
                    DEEPSEEK_API_URL,
                    headers=headers,
                    json=payload,
                )
                response.raise_for_status()
                data = response.json()

                if "error" in data:
                    error_msg = data["error"].get("message", str(data["error"]))
                    raise RuntimeError(f"DeepSeek API error: {error_msg}")

                choices = data.get("choices", [])
                if not choices:
                    raise ValueError("DeepSeek returned no choices in response")

                content = choices[0].get("message", {}).get("content", "")
                if not content:
                    raise ValueError("DeepSeek returned empty content")

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
                        f"DeepSeek rejected the request (HTTP {status_code}). "
                        "Check the API key and model configuration."
                    ) from e

                if attempt == max_retries - 1:
                    break

                wait_time = (2 ** attempt) * 2.0
                if response is not None:
                    retry_after = response.headers.get("retry-after")
                    if retry_after:
                        try:
                            wait_time = float(retry_after) + 1.0
                        except ValueError:
                            pass

                logger.warning(
                    f"DeepSeek API attempt {attempt + 1}/{max_retries} failed. "
                    f"Retrying in {wait_time:.1f}s... Error: {error_str[:150]}"
                )
                time.sleep(wait_time)

        raise RuntimeError(
            f"DeepSeek API failed after {max_retries} attempts. Last error: {last_error}"
        )
