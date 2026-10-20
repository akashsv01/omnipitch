"""Narration worker: claim a job, narrate its frozen moment, publish one validated insight, complete the job.

Outcomes per claimed job (job contract: contracts/schemas/job.schema.json):

- valid AI output (possibly after one repair)          -> insight generation_mode=ai,       job ready
- output still invalid after one repair, or a
  non-transient model error, or no model configured  -> deterministic fallback insight,   job fallback
- timeout / 429 / 5xx with attempts remaining        -> no insight,                       job retry_wait (bounded backoff)
- timeout / 429 / 5xx on the last attempt            -> deterministic fallback insight,   job fallback
- moment record missing                              -> no insight,                       job failed

Insights are created only if absent (insight_id = moment_id) and the job is completed only by the current
lease holder at the version it claimed, so concurrent workers and expired leases publish exactly one insight.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path
import random
from typing import Callable

from jsonschema import Draft202012Validator

from omnipitch_bridge.store import StaleJob, iso, utcnow

from .insights import insight_id_for
from .model import ModelClient, ModelError, ModelRateLimited, ModelTimeout
from .narrate import build_fallback_insight
from .validation import validate_insight
from .workflow import run_workflow, summarize_errors

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts/schemas"
INSIGHT_VALIDATOR = Draft202012Validator(json.loads((CONTRACTS / "insight.schema.json").read_text(encoding="utf-8")))
MAX_BACKOFF_S = 120.0


class NarrationWorker:
    def __init__(self, store, insights, client: ModelClient | None, owner: str,
                 context_for: Callable[[dict], dict], clock: Callable[[], datetime] = utcnow,
                 lease: timedelta = timedelta(seconds=120), budget_s: float = 45.0, per_call_s: float = 20.0,
                 backoff_base_s: float = 10.0, log: Callable[[dict], None] = lambda record: None,
                 rng: random.Random | None = None, run_id: str | None = None,
                 no_model_reason: str = "no model configured"):
        if budget_s >= lease.total_seconds():
            raise ValueError("the narration budget must be shorter than the job lease")
        self.store, self.insights, self.client, self.owner = store, insights, client, owner
        self.context_for, self.clock, self.lease = context_for, clock, lease
        self.budget_s, self.per_call_s, self.backoff_base_s = budget_s, per_call_s, backoff_base_s
        self.log, self.rng = log, rng or random.Random()
        # run_id scopes claims (and this worker's own recovery) to one run; None claims across runs.
        self.run_id, self.no_model_reason = run_id, no_model_reason

    # Loop helpers ----------------------------------------------------------
    def process_one(self) -> dict | None:
        job = self.store.claim_next(self.owner, self.clock(), self.lease, run_id=self.run_id)
        return None if job is None else self.handle(job)

    def recover(self) -> list[dict]:
        """Expire abandoned last attempts of this worker's run only. Without a run, recovery is the bridge's job."""
        return [] if self.run_id is None else self.store.expire_exhausted(self.clock(), run_id=self.run_id)

    def drain(self, limit: int = 1000) -> list[dict]:
        results = []
        for _ in range(limit):
            result = self.process_one()
            if result is None:
                break
            results.append(result)
        return results

    # One job ---------------------------------------------------------------
    def _moment(self, job: dict) -> dict | None:
        return next((m for m in self.store.moments(job["run_id"]) if m["moment_id"] == job["moment_id"]), None)

    def handle(self, job: dict) -> dict:
        moment = self._moment(job)
        if moment is None:
            return self._complete(job, "failed", None, "moment record not found for this job")
        context = self.context_for(moment)
        insight, reason, trace = None, None, {}
        if self.client is None:
            reason = self.no_model_reason
        else:
            try:
                result = run_workflow(moment, context, self.client, self.budget_s, self.per_call_s)
                trace = result.trace
                if result.insight is not None:
                    insight = result.insight
                else:
                    reason = "output failed validation after one repair"
                    trace["rejected"] = result.errors[:8]
            except (ModelTimeout, ModelRateLimited) as exc:
                if job["attempt"] < job["max_attempts"]:
                    return self._complete(job, "retry_wait", None, f"{type(exc).__name__} ({self.client.name}): {exc}",
                                          retry_after=self._backoff(job, getattr(exc, "retry_after", None)))
                reason = f"{type(exc).__name__} on the last attempt"
                trace = {"model": self.client.name, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
            except ModelError as exc:
                # Record which deployment failed, so a deliberate failure is distinguishable from a misconfiguration.
                reason = f"model error ({self.client.name}): {str(exc)[:120]}"
                trace = {"model": self.client.name, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
        if insight is None:
            insight = build_fallback_insight(moment, context, reason)
        # Final guard: nothing unvalidated is ever written, whatever its source.
        problems = validate_insight(insight, moment, context) + [e.message for e in INSIGHT_VALIDATOR.iter_errors(insight)]
        if problems and insight["generation_mode"] == "ai":
            reason = f"final validation rejected AI output: {problems[0][:120]}"
            insight = build_fallback_insight(moment, context, reason)
            problems = validate_insight(insight, moment, context) + [e.message for e in INSIGHT_VALIDATOR.iter_errors(insight)]
        if problems:
            return self._complete(job, "failed", None, f"fallback failed validation: {problems[0][:200]}")
        return self._publish(job, moment, insight, reason, trace)

    def _publish(self, job: dict, moment: dict, insight: dict, reason: str | None, trace: dict) -> dict:
        insight_id = insight_id_for(moment["moment_id"])
        record = {"insight_id": insight_id, "run_id": moment["run_id"], "moment_id": moment["moment_id"],
                  "insight": insight, "trace": trace, "worker": self.owner, "attempt": job["attempt"],
                  "created_at": iso(self.clock())}
        created = self.insights.create_insight(record)
        stored = record if created else self.insights.get_insight(insight_id, moment["run_id"])
        status = "ready" if stored["insight"]["generation_mode"] == "ai" else "fallback"
        error = None if status == "ready" else (reason or "deterministic fallback")
        if not created:
            error = f"insight already published by {stored['worker']}; {error or 'kept existing'}"
        return self._complete(job, status, insight_id, error, insight_created=created)

    def _backoff(self, job: dict, retry_after: float | None) -> timedelta:
        base = retry_after if retry_after else self.backoff_base_s * (2 ** (job["attempt"] - 1))
        return timedelta(seconds=min(MAX_BACKOFF_S, base + self.rng.uniform(0, base * 0.25)))

    def _complete(self, job: dict, status: str, insight_id: str | None, error: str | None,
                  retry_after: timedelta | None = None, insight_created: bool = False) -> dict:
        outcome = {"stage": "narrate", "job_id": job["job_id"], "attempt": job["attempt"], "status": status,
                   "insight_id": insight_id, "insight_created": insight_created, "error": error}
        try:
            self.store.complete(job, self.owner, self.clock(), status, insight_id=insight_id, error=error,
                                retry_after=retry_after)
        except StaleJob:
            # Another worker holds the job now; its outcome stands. Our insight (if any) was create-if-absent.
            outcome.update(status="lost_lease", note="job was re-claimed after this worker's lease expired")
        self.log(outcome)
        return outcome
