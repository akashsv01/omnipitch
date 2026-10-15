"""Backend mode and cloud identifiers. Secrets are never needed: Azure Identity supplies tokens.

Settings come from process environment variables. For convenience, an untracked
services/api/.env file is read first without overriding variables already set.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from urllib.parse import urlparse

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class ConfigError(ValueError):
    """Raised when azure mode is selected but required identifiers are missing or malformed."""


@dataclass(frozen=True)
class Settings:
    mode: str
    eventhub_namespace: str | None
    eventhub_name: str | None
    eventhouse_query_uri: str | None
    eventhouse_database: str | None
    eventhouse_table: str
    tenant_id: str | None

    @property
    def azure(self) -> bool:
        return self.mode == "azure"

    def missing(self) -> list[str]:
        required = {
            "EVENTHOUSE_QUERY_URI": self.eventhouse_query_uri,
            "EVENTHOUSE_DATABASE": self.eventhouse_database,
        }
        return [name for name, value in required.items() if not value]

    def describe(self) -> dict:
        """Non-secret identifiers only; safe to log and to return from /ready."""
        return {"mode": self.mode, "eventhub_namespace": self.eventhub_namespace, "eventhub_name": self.eventhub_name,
                "eventhouse_query_uri": self.eventhouse_query_uri, "eventhouse_database": self.eventhouse_database,
                "eventhouse_table": self.eventhouse_table}


def settings() -> Settings:
    load_env_file()
    mode = os.getenv("OMNIPITCH_BACKEND_MODE", "local").strip().lower()
    if mode not in ("local", "azure"):
        raise ConfigError("OMNIPITCH_BACKEND_MODE must be 'local' or 'azure'.")
    uri = os.getenv("EVENTHOUSE_QUERY_URI") or None
    if uri:
        parsed = urlparse(uri)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/"):
            raise ConfigError("EVENTHOUSE_QUERY_URI must be the https query URI of the Eventhouse, without a path.")
        uri = uri.rstrip("/")
    namespace = os.getenv("EVENTHUB_FULLY_QUALIFIED_NAMESPACE") or None
    if namespace and ("://" in namespace or "/" in namespace or "SharedAccessKey" in namespace):
        raise ConfigError("EVENTHUB_FULLY_QUALIFIED_NAMESPACE must be a host name such as <name>.servicebus.windows.net, not a connection string.")
    table = os.getenv("EVENTHOUSE_TABLE", "OmniPitchEvents")
    if not table.replace("_", "").isalnum():
        raise ConfigError("EVENTHOUSE_TABLE must be a plain table name.")
    return Settings(mode, namespace, os.getenv("EVENTHUB_NAME") or None, uri,
                    os.getenv("EVENTHOUSE_DATABASE") or None, table, os.getenv("EVENTHOUSE_TENANT_ID") or os.getenv("AZURE_TENANT_ID") or None)


def credential(tenant_id: str | None = None):
    """Developer credential chain without interactive prompts: env, workload/managed identity, Azure CLI.

    Locally this resolves to the signed-in `az login` identity. EVENTHOUSE_TENANT_ID pins the tenant that owns
    the Fabric workspace, e.g. when you are a B2B guest in another organization (cross-tenant).
    """
    from azure.identity import AzureCliCredential, DefaultAzureCredential
    if tenant_id:
        # No fallback: a token from another tenant would only fail later with a confusing 401.
        return AzureCliCredential(tenant_id=tenant_id)
    return DefaultAzureCredential(exclude_interactive_browser_credential=True, exclude_visual_studio_code_credential=True)
