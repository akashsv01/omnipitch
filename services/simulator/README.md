# Simulator fixture generator

Current status: local deterministic completed-pass JSONL CLI. This is a fixture generator, not a full football simulation. It uses fictional Harbor players, one possession, bounded coordinates and connected pass endpoints. Sequence and period-local time increase; UTC fixture emissions use a reproducible baseline.

From repository root, install API development dependencies (includes jsonschema) into `.venv`, then:

```powershell
$env:PYTHONPATH = "$PWD/services/simulator"
.venv/Scripts/python.exe -m simulator.generate --seed 7 --run-id demo-run-001 --output data/generated/demo.jsonl
Remove-Item Env:PYTHONPATH
```

After virtual-environment activation, `python -m simulator.generate` works with the same PYTHONPATH. Bash equivalent: `PYTHONPATH=services/simulator .venv/bin/python -m simulator.generate --seed 7 --run-id demo-run-001 --output data/generated/demo.jsonl`.

Optional: `--count 5` (1–1000), `--baseline 2026-01-01T12:00:00Z` (explicit UTC). Identical seed/run/count/baseline produce identical bytes. Use a new run ID for every replay reset. Reusing a seed with a different run ID preserves geometry, but creates new run-scoped identities.

Each output event is validated against `contracts/schemas/event.schema.json` before writing. The specified output file is replaced; choose a path under gitignored `data/generated/`. Contract examples remain committed. Run tests with `.venv/Scripts/python.exe -m pytest services/api/tests -q` from root.

The API calls the same generator directly for sample responses. It does not ingest JSONL or stream events. A future replay slice will load a selected JSONL dataset into the API with validation, playback and run-reset semantics.
