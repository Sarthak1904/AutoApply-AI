"""Abstract LLM client interface and provider factory.

Supports multiple AI backends (Gemini, OpenRouter) behind a unified interface.
Consumer services import `get_llm_client()` and never worry about the provider.
"""

import json
import re
import os
import logging
import threading
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional, Union

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# Load env from backend directory
_backend_dir = Path(__file__).parent.parent
load_dotenv(_backend_dir / ".env")

DEFAULT_PROVIDER = "gemini"
SUPPORTED_PROVIDERS = frozenset({"gemini", "openrouter"})

_PROVIDER_SETTINGS = {
    "gemini": {
        "api_key_env": "GEMINI_API_KEY",
        "default_model": "gemini-2.5-flash",
        "model_env": None,
    },
    "openrouter": {
        "api_key_env": "OPENROUTER_API_KEY",
        "default_model": None,
        "model_env": "OPENROUTER_MODEL",
    },
}


def _is_placeholder(value: str) -> bool:
    """Return whether an API-key value is an example/template placeholder."""
    normalized = value.strip().lower()
    return (
        not normalized
        or normalized.startswith("your_")
        or normalized.startswith("<your_")
        or normalized in {"changeme", "replace_me", "replace-with-your-key"}
    )


def inspect_provider_configuration() -> dict[str, str | bool | None]:
    """Inspect LLM setup without creating a client or making a network request.

    This is safe to call from a health endpoint. It intentionally returns only
    public configuration state: API keys are never included in the response.
    """
    provider = os.getenv("AI_PROVIDER", DEFAULT_PROVIDER).strip().lower() or DEFAULT_PROVIDER
    if provider not in SUPPORTED_PROVIDERS:
        supported = ", ".join(sorted(SUPPORTED_PROVIDERS))
        return {
            "provider": provider,
            "model": None,
            "configured": False,
            "error": f"Unsupported AI_PROVIDER '{provider}'. Use one of: {supported}.",
        }

    settings = _PROVIDER_SETTINGS[provider]
    api_key_env = settings["api_key_env"]
    api_key = os.getenv(api_key_env, "")
    model_env = settings["model_env"]
    model = (
        os.getenv(model_env, "").strip()
        if model_env
        else settings["default_model"]
    ) or settings["default_model"]

    if _is_placeholder(api_key):
        return {
            "provider": provider,
            "model": model,
            "configured": False,
            "error": f"Set a valid {api_key_env} in backend/.env for {provider}.",
        }

    if not model:
        return {
            "provider": provider,
            "model": None,
            "configured": False,
            "error": "Set OPENROUTER_MODEL explicitly in backend/.env.",
        }

    if provider == "openrouter":
        privacy_mode = os.getenv("OPENROUTER_PRIVACY_MODE", "strict").strip().lower()
        if privacy_mode not in {"strict", "allow"}:
            return {
                "provider": provider,
                "model": model,
                "configured": False,
                "error": "OPENROUTER_PRIVACY_MODE must be 'strict' or 'allow'.",
            }
        if privacy_mode == "strict" and str(model).endswith(":free"):
            return {
                "provider": provider,
                "model": model,
                "configured": False,
                "error": (
                    "OpenRouter free endpoints may retain personal data. Choose a "
                    "privacy-compatible paid model, or explicitly set "
                    "OPENROUTER_PRIVACY_MODE=allow after reviewing provider terms."
                ),
            }

    return {
        "provider": provider,
        "model": model,
        "configured": True,
        "error": None,
    }


class LLMClient(ABC):
    """Abstract base class for LLM provider clients.

    Every provider must implement `generate()`. The `generate_json()` method
    is provided for free via the shared `_extract_json()` helper.
    """

    @abstractmethod
    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """Generate text from a prompt with retry logic."""
        ...

    def generate_json(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        max_retries: int = 3,
    ) -> Union[dict, list]:
        """Generate a response and parse it as JSON."""
        raw = self.generate(prompt, system_instruction, max_retries)
        return self._extract_json(raw)

    @staticmethod
    def _extract_json(text: str) -> Union[dict, list]:
        """Extract JSON from a response that may be wrapped in markdown code blocks."""
        text_stripped = text.strip()
        try:
            return json.loads(text_stripped)
        except json.JSONDecodeError:
            pass

        json_block_match = re.search(
            r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL
        )
        if json_block_match:
            try:
                return json.loads(json_block_match.group(1).strip())
            except json.JSONDecodeError:
                pass

        for start_char, end_char in [("{", "}"), ("[", "]")]:
            start_idx = text.find(start_char)
            if start_idx != -1:
                end_idx = text.rfind(end_char)
                if end_idx > start_idx:
                    try:
                        return json.loads(text[start_idx : end_idx + 1])
                    except json.JSONDecodeError:
                        pass

        raise ValueError(
            f"Could not extract valid JSON from LLM response. Raw text:\n{text[:500]}"
        )

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Human-readable provider name for health checks / logging."""
        ...

    @property
    @abstractmethod
    def model_name(self) -> str:
        """The model identifier string."""
        ...

    def close(self) -> None:
        """Release provider resources. Most SDK clients do not require this."""


# ---------------------------------------------------------------------------
# Singleton factory
# ---------------------------------------------------------------------------

_client: Optional[LLMClient] = None
_client_lock = threading.Lock()


def get_llm_client() -> LLMClient:
    """Get or create the singleton LLM client based on AI_PROVIDER env var.

    Supported values for AI_PROVIDER:
        - "gemini"     (default) — uses Google Gemini via google-generativeai SDK
        - "openrouter" — uses OpenRouter API (OpenAI-compatible)
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:  # double-check
                configuration = inspect_provider_configuration()
                if not configuration["configured"]:
                    raise ValueError(configuration["error"])

                provider = str(configuration["provider"])
                if provider == "openrouter":
                    from backend.services.openrouter import OpenRouterClient
                    _client = OpenRouterClient()
                elif provider == "gemini":
                    from backend.services.gemini import GeminiClient
                    _client = GeminiClient()
                else:  # Defensive guard: inspect_provider_configuration validates this.
                    raise ValueError(f"Unsupported AI_PROVIDER '{provider}'.")
                logger.info(
                    f"LLM client initialized: provider={_client.provider_name}, "
                    f"model={_client.model_name}"
                )
    return _client


def close_llm_client() -> None:
    """Close and clear the provider singleton if it was initialized."""
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None
