"""Proposed push envelope (contracts/schemas/push.schema.json) and the reconciliation contract it carries."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SCHEMAS = Path(__file__).resolve().parents[3] / "contracts/schemas"
EXAMPLES = SCHEMAS.parent / "examples"


@pytest.fixture(scope="module")
def push() -> Draft202012Validator:
    resources = []
    for path in SCHEMAS.glob("*.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resource = Resource.from_contents(schema)
        resources += [(schema["$id"], resource), (path.name, resource)]
    registry = Registry().with_resources(resources)
    return Draft202012Validator(json.loads((SCHEMAS / "push.schema.json").read_text(encoding="utf-8")),
                                registry=registry, format_checker=FormatChecker())


def example(name: str) -> dict:
    return json.loads((EXAMPLES / f"{name}.example.json").read_text(encoding="utf-8"))


def envelope(kind: str, payload: dict, version: int = 340) -> dict:
    return {"schema_version": "1.0", "message_id": f"r:{kind}:k", "run_id": "r", "type": kind,
            "state_version": version, "sent_at": "2026-10-20T02:44:11.600Z", "payload": payload}


def test_example_and_each_payload_type_validate(push):
    push.validate(example("push"))
    push.validate(envelope("state", example("match-state")))
    push.validate(envelope("insight", example("insight")))
    push.validate(envelope("period_reconciled", {
        "schema_version": "1.0", "reconciliation_id": "r:p1", "run_id": "r", "match_id": "harbor-vale", "period": 1,
        "through_sequence": 618, "events_in_period": 618, "expected_moments": 12, "stored_before": 12, "created": 0,
        "mismatches": [], "status": "reconciled", "reconciled_at": "2026-10-20T02:44:11.600Z"}))


def test_payload_must_match_its_type(push):
    assert list(push.iter_errors(envelope("state", example("push")["payload"])))  # A moment_ref is not a state.
    assert list(push.iter_errors(envelope("insight", {"headline": "x"})))
    assert list(push.iter_errors({**example("push"), "state_version": -1}))
    assert list(push.iter_errors({**example("push"), "type": "score"}))
    assert list(push.iter_errors({**example("push"), "extra": True}))


@pytest.mark.parametrize("name", ["push", "push-state", "push-insight", "push-period-reconciled"])
def test_one_example_per_type_validates(push, name):
    message = example(name)
    push.validate(message)
    assert message["message_id"].startswith(f"{message['run_id']}:{message['type']}:")
    assert message["payload"]["run_id" if message["type"] != "moment" else "moment_id"].startswith(message["run_id"])


def test_examples_cover_every_type():
    types = {example(name)["type"] for name in ("push", "push-state", "push-insight", "push-period-reconciled")}
    assert types == {"state", "moment", "insight", "period_reconciled"}
