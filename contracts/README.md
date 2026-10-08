# Shared wire contracts

Current status: draft 2020-12 JSON Schemas and committed examples for completed-pass events, static match state and an English fixture insight. Schemas are the documented wire-contract reference. Pydantic (`services/api/app/schemas.py`) and TypeScript (`apps/web/src/types/contracts.ts`) are manually aligned; checks validate fixtures and exact top-level keys. No code generation.

## Coordinates and clocks

Pitch is 105 × 68 metres. A single fixed corner is `(0, 0)`; x follows the length and y the width. The frame never rotates at halftime. Bounds are inclusive; attack direction is `positive_x` or `negative_x`. Points describe the pass path, not full player tracking. Missing player/off-ball tracking must not be invented.

`period` currently supports 1 or 2. `match_time_ms` is elapsed milliseconds within that period, including potential stoppage time. `emitted_at` is a UTC wall-clock timestamp ending in Z; fixture baseline is `2026-01-01T12:00:00Z`. Emission time and match time are different concepts even though the fixture increments both by three seconds per event.

A replay reset creates a new `run_id`. Event identity is `(run_id, event_id)`; sequence is ordered within a run/match. Evidence IDs refer to event IDs within the insight's `run_id` and `match_id`, never globally. Later consumers must handle duplicate delivery.

## Current example

Run `demo-run-001`, match `demo`: fictional Harbor Comets versus Vale Owls, 0–0. Seed 7 produces five completed Harbor passes in possession-001; each endpoint becomes the next start. `event.example.json` is the first pass. State is paused at sequence 5, period 1, 15,000 ms. Insight cites all five events and reports `completed_passes: 5 passes`. The API serves state and the full sequence, not the insight.

All fixture records have schema version 1.0 and synthetic data is labeled. Event type is `pass`, outcome is `completed`; these are the only supported values. Future shots, goals, turnovers, carries, tracking and substitutions require contract changes and implementation. They are not supported now.

Insight `generation_mode: fixture` means a hand-authored example, distinct from future AI-generated or fallback output. Only English is supported in this schema version; multilingual extensions are planned. Metrics always have a name, value and unit. No illustrative threat metric is included; any future illustrative threat score must not be described as calibrated expected threat or scoring probability. Pass continuity alone does not establish a tactical pattern.

## Verification (repository root)

```powershell
.venv/Scripts/python.exe -m pytest services/api/tests -q
cd apps/web
npm run test:contracts
npm run typecheck
```

Changing a contract requires aligned examples, Python/TypeScript models, boundary validation, tests and affected docs. Keep committed examples tracked; only generated datasets under `data/generated/` are ignored.
