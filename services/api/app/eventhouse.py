"""Read validated events for one run from a Fabric Eventhouse (KQL database).

Eventhouse is the analytics event store in azure mode. Rows are deduplicated in KQL by
(run_id, event_id), keeping the first ingested copy, then validated against the shared
event contract before any metric uses them. Failures raise EventhouseError with an
explicit code; callers must not fall back to local data.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import Settings, credential

KQL_DIR = Path(__file__).resolve().parents[3] / "analytics/kql"
MAX_ROWS = 5000


class EventhouseError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _query_text(name: str, table: str) -> str:
    # Table name is validated in config; queries are versioned files with declared parameters.
    return (KQL_DIR / f"{name}.kql").read_text(encoding="utf-8").replace("{{TABLE}}", table)


def _classify(exc: Exception) -> EventhouseError:
    text = str(exc)
    lowered = text.lower()
    if "credentialunavailable" in type(exc).__name__.lower() or "az login" in lowered or "defaultazurecredential failed" in lowered:
        return EventhouseError("auth_unavailable", "No Azure credential is available. Run 'az login' in this environment.")
    if "403" in text or "forbidden" in lowered or "unauthorized" in lowered or "401" in text:
        return EventhouseError("forbidden", "Signed in, but this identity lacks read access to the KQL database. "
                               "Grant at least Viewer on the Fabric workspace or the database.")
    if "not found" in lowered or "doesn't exist" in lowered or "does not exist" in lowered or "semantic error" in lowered:
        return EventhouseError("not_found", f"Database or table not found: {text[:300]}")
    if "name or service not known" in lowered or "getaddrinfo" in lowered or "failed to resolve" in lowered:
        return EventhouseError("unreachable", "Eventhouse query URI did not resolve. Check EVENTHOUSE_QUERY_URI.")
    return EventhouseError("query_failed", f"{type(exc).__name__}: {text[:300]}")


class EventhouseReader:
    def __init__(self, settings: Settings):
        missing = settings.missing()
        if missing:
            raise EventhouseError("not_configured", f"Azure mode needs {', '.join(missing)}.")
        self.settings = settings
        self._client = None

    def _client_or_create(self):
        if self._client is None:
            from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
            builder = KustoConnectionStringBuilder.with_azure_token_credential(
                self.settings.eventhouse_query_uri, credential(self.settings.tenant_id))
            self._client = KustoClient(builder)
        return self._client

    def _run(self, name: str, parameters: dict[str, Any]) -> list[dict]:
        from azure.kusto.data import ClientRequestProperties
        properties = ClientRequestProperties()
        for key, value in parameters.items():
            properties.set_parameter(key, value)
        # azure-kusto-data adds a client-side delta to this value, so it must be a timedelta, not a string.
        properties.set_option("servertimeout", timedelta(seconds=30))
        try:
            response = self._client_or_create().execute(self.settings.eventhouse_database,
                                                         _query_text(name, self.settings.eventhouse_table), properties)
        except Exception as exc:  # SDK raises several unrelated types; classify for the user.
            raise _classify(exc) from exc
        table = response.primary_results[0]
        columns = [column.column_name for column in table.columns]
        return [dict(zip(columns, row)) for row in table.raw_rows][:MAX_ROWS]

    def ping(self) -> dict:
        rows = self._run("ping", {})
        return {"table": self.settings.eventhouse_table, "rows": int(rows[0]["rows"]) if rows else 0}

    def run_summary(self, run_id: str) -> dict:
        rows = self._run("run_summary", {"run": run_id})
        if not rows:
            return {"run_id": run_id, "raw_rows": 0, "unique_events": 0, "duplicate_rows": 0,
                    "first_sequence": None, "last_sequence": None, "last_ingested": None}
        row = rows[0]
        last = row.get("last_ingested")
        return {"run_id": run_id, "raw_rows": int(row["raw_rows"]), "unique_events": int(row["unique_events"]),
                "duplicate_rows": int(row["raw_rows"]) - int(row["unique_events"]),
                "first_sequence": row.get("first_sequence"), "last_sequence": row.get("last_sequence"),
                "last_ingested": last.astimezone(timezone.utc).isoformat() if isinstance(last, datetime) else last}

    def team_counts(self, run_id: str) -> list[dict]:
        """KQL-side parity check: deduplicated pass attempts/completions and shots by team."""
        return self._run("team_counts", {"run": run_id})

    def events(self, run_id: str) -> list[dict]:
        """Deduplicated events in sequence order, reshaped to the event contract."""
        rows = self._run("run_events", {"run": run_id})
        return [to_event(row) for row in rows]

    def recent_runs(self, limit: int = 10) -> list[dict]:
        return self._run("recent_runs", {"max_runs": limit})

    def runs_ingested_since(self, since: datetime) -> list[dict]:
        """Runs with rows ingested after `since` (UTC), oldest first: [{run_id, last_ingested, new_rows}]."""
        stamp = since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        rows = self._run("runs_since", {"since": stamp})
        return [{"run_id": row["run_id"], "new_rows": int(row["new_rows"]),
                 "last_ingested": row["last_ingested"] if isinstance(row["last_ingested"], datetime)
                 else datetime.fromisoformat(str(row["last_ingested"]).replace("Z", "+00:00"))} for row in rows]


def _point(value: Any) -> dict | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        value = json.loads(value)
    return {"x": value["x"], "y": value["y"]}


def to_event(row: dict) -> dict:
    """Map a deduplicated KQL row back to the wire contract (validated again by the caller)."""
    def opt(key):
        value = row.get(key)
        return None if value in ("", None) else value

    def opt_bool(key):
        value = row.get(key)
        return None if value is None or value == "" else bool(value)
    return {
        "schema_version": row["schema_version"], "run_id": row["run_id"], "match_id": row["match_id"],
        "event_id": row["event_id"], "sequence": int(row["sequence"]), "period": int(row["period"]),
        "match_time_ms": int(row["match_time_ms"]), "emitted_at": row["emitted_at"],
        "team_id": opt("team_id"), "player_id": opt("player_id"), "possession_id": opt("possession_id"),
        "type": row["type"], "outcome": row["outcome"], "start": _point(row.get("start")), "end": _point(row.get("end")),
        "attacking_direction": opt("attacking_direction"), "on_target": opt_bool("on_target"),
        "is_goal": opt_bool("is_goal"), "synthetic": bool(row["synthetic"]),
    }
