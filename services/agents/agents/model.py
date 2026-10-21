"""Model clients for the narration workflow.

The workflow depends only on the ModelClient protocol, so tests use a scripted fake and no tokens are
spent. AzureOpenAIClient calls an Azure OpenAI / Foundry chat deployment with an Entra ID token
(Azure Identity); it never uses API keys. Transient failures are typed so the worker can decide
between retry_wait and a deterministic fallback.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import threading
import os
from typing import Protocol


class ModelError(RuntimeError):
    """Non-transient model failure (bad request, content filter, unexpected response)."""


class ModelTimeout(ModelError):
    """The call exceeded its time budget. Transient."""


class ModelRateLimited(ModelError):
    """HTTP 429 or a 5xx from the service. Transient; retry_after is in seconds when the service says."""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class ModelClient(Protocol):
    name: str

    def complete(self, role: str, messages: list[dict], timeout: float) -> dict:
        """Return the parsed JSON object the role produced. Raise ModelTimeout / ModelRateLimited / ModelError."""


@dataclass(frozen=True)
class AzureOpenAIConfig:
    endpoint: str
    deployment: str
    api_version: str = "2024-10-21"
    max_output_tokens: int = 400
    tenant_id: str | None = None

    @classmethod
    def from_env(cls) -> "AzureOpenAIConfig | None":
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").strip().rstrip("/")
        deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "").strip()
        if not endpoint or not deployment:
            return None
        if not endpoint.startswith("https://") or "api-key" in endpoint.lower():
            raise ValueError("AZURE_OPENAI_ENDPOINT must be the https resource endpoint, without keys.")
        return cls(endpoint, deployment, os.getenv("AZURE_OPENAI_API_VERSION", cls.api_version),
                   int(os.getenv("AZURE_OPENAI_MAX_OUTPUT_TOKENS", cls.max_output_tokens)),
                   os.getenv("AZURE_OPENAI_TENANT_ID") or None)


class AzureOpenAIClient:
    """Chat completions with JSON output, authenticated by Entra ID (scope cognitiveservices)."""

    SCOPE = "https://cognitiveservices.azure.com/.default"

    def __init__(self, config: AzureOpenAIConfig, credential=None, http=None):
        self.config = config
        self.name = f"azure-openai:{config.deployment}"
        if credential is None:
            from azure.identity import AzureCliCredential, DefaultAzureCredential
            credential = (AzureCliCredential(tenant_id=config.tenant_id) if config.tenant_id
                          else DefaultAzureCredential(exclude_interactive_browser_credential=True))
        self.credential = credential
        self._local = threading.local()  # Roles run concurrently: usage is kept per calling thread.
        if http is None:
            import httpx
            http = httpx.Client()
        self.http = http

    def complete(self, role: str, messages: list[dict], timeout: float) -> dict:
        import httpx
        url = (f"{self.config.endpoint}/openai/deployments/{self.config.deployment}/chat/completions"
               f"?api-version={self.config.api_version}")
        token = self.credential.get_token(self.SCOPE).token
        body = {"messages": messages, "temperature": 0.2, "max_tokens": self.config.max_output_tokens,
                "response_format": {"type": "json_object"}}
        try:
            response = self.http.post(url, json=body, timeout=timeout,
                                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        except httpx.TimeoutException as exc:
            raise ModelTimeout(f"{role}: model call exceeded {timeout:.0f}s") from exc
        except httpx.HTTPError as exc:
            raise ModelRateLimited(f"{role}: transport error {type(exc).__name__}") from exc
        if response.status_code == 429 or response.status_code >= 500:
            retry = response.headers.get("retry-after")
            raise ModelRateLimited(f"{role}: HTTP {response.status_code}", float(retry) if retry and retry.isdigit() else None)
        if response.status_code in (401, 403):
            raise ModelError(f"{role}: HTTP {response.status_code}; this identity needs 'Cognitive Services OpenAI User' on the resource")
        if response.status_code >= 400:
            raise ModelError(f"{role}: HTTP {response.status_code}: {response.text[:200]}")
        self._local.usage = None
        try:
            payload = response.json()
            usage = payload.get("usage") or {}
            self._local.usage = {k: usage[k] for k in ("prompt_tokens", "completion_tokens", "total_tokens") if isinstance(usage.get(k), int)} or None
            content = payload["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except (KeyError, IndexError, ValueError) as exc:
            raise ModelError(f"{role}: response was not a JSON object") from exc
        if not isinstance(parsed, dict):
            raise ModelError(f"{role}: response was not a JSON object")
        return parsed

    def last_usage(self) -> dict | None:
        """Token usage of this thread's most recent successful response (for the insight trace)."""
        return getattr(self._local, "usage", None)
