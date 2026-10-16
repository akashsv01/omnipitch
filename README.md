# OmniPitch

OmniPitch is a hackathon project that turns synthetic football events into explainable match intelligence. It explains why a moment matters, shows the evidence and calculation behind the explanation, and adapts the same facts for fans and analysts. All teams, players and events are fictional.

## Current status

Implemented locally (no cloud credentials needed):

- **Seeded match simulator**: a state machine that produces a full two-period match of about 1,200 events. Event types are completed and incomplete passes, shots (goal, saved, off target, blocked), tackles, interceptions, challenges, fouls and period markers. The `standard`, `high_press` and `quiet` scenarios bias probabilities; they never script narratives.
- **Replay**: play, pause, resume, speed (1–80×), seek, reset (new run ID), generate a new seeded match, and load JSONL. Position is persisted in SQLite, so an API restart restores the same run, paused.
- **Deterministic analytics** (Python adapter, the documented fallback for Fabric/KQL): progression, final-third and box entries, an illustrative 16 × 12 threat grid, windowed PPDA with sample gates, momentum, player contributions and a pass network.
- **Moment detection**: goal, chance, threat gain, transition and pressing-change rules. Moment IDs are stable, evidence is frozen at detection time, and moments are created conditionally.
- **Ledger ingestion**: `(run_id, event_id)` deduplication, conflict and invalid diagnostics, and metrics computed only over a gap-free sequence prefix.
- **Grounded narration groundwork**: Analyst/Coach/Broadcaster prompts, an evidence-packet builder, a code-side output validator, a deterministic fallback narrator and a 34-case evaluation set. **No model endpoint is connected**, so every insight is labelled as a deterministic template.
- **Web app**: a broadcast-style match room with an animated 2D pitch (ball travel, shot ripples, goal celebration, recent-play trail, plus threat-grid, event-density and pass-network layers), a ticking scoreboard and momentum strip, a key-moments feed with fan/analyst wording and favourite-player priority, an evidence drawer, and analysis tabs (team comparison, PPDA chart, players, shot map, data quality with a live duplicate-delivery test). Reduced-motion and keyboard support are included.

**Cloud status (2026-10-15).**

- **Event Hubs:** verified live. The simulator publishes with Entra ID (no keys). The namespace costs Azure credit while it exists; `infra/eventhubs.ps1` recreates it in about 2 minutes.
- **Fabric Eventstream → Eventhouse:** verified end to end on 2026-10-16. The run `smoke-20261016-a` was ingested, deduplicated, checked against Python metrics and shown in the browser (see [ROADMAP](docs/ROADMAP.md)).
- **API:** has an explicit `azure` mode that reads Eventhouse and never falls back silently.
- **Later phases:** Cosmos DB, Foundry/Agent Framework and Web PubSub are planned, not connected.

See the [roadmap](docs/ROADMAP.md) and [technical reference](docs/ARCHITECTURE.md#azure-mode-phase-2-cloud-path).

## Local setup

Verified on Windows with Node 24.11.0 and Python 3.13.7 on 2026-10-14. Start from the repository root.

Terminal 1 (PowerShell):

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

Terminal 2 (PowerShell, also from the repository root):

```powershell
cd apps/web
Copy-Item .env.example .env
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173) and the [API docs](http://localhost:8000/docs). If Windows reports `EACCES` on 5173 (a reserved port range), run `npm run dev -- --port 5212` and add `http://localhost:5212` to `CORS_ORIGINS`. The API stores runs in `data/generated/omnipitch.sqlite3` (gitignored); set `OMNIPITCH_DB_PATH` to change the location, and delete the file to start fresh. Run the API with one worker.

To try it, press **Play** (or Space). The default seed-7 match plays at 20×. Moments appear in the right column. **Show evidence** opens the calculation, source events and limitations. Switch between **Fan view** and **Analyst view** at the top. Use the shuffle button in the control dock to generate another seed or scenario, or to load a JSONL file. Click a moment tick on the scrubber, or **Replay from here**, to jump.

### Azure mode (optional)

```powershell
.venv/Scripts/python.exe -m pip install -r services/api/requirements-azure.txt
az login
Copy-Item services/api/.env.example services/api/.env   # then fill in identifiers only; no keys
$env:PYTHONPATH = "$PWD/services/simulator"
.venv/Scripts/python.exe -m simulator.publish --seed 7 --run-id smoke-<date>-a --count 400 --duplicate 25
```

Set `OMNIPITCH_BACKEND_MODE=azure` and the Eventhouse values in `services/api/.env`, then restart the API. Load the run from **Data quality → Fabric Eventhouse** in the app. `GET /ready` reports the mode and whether Eventhouse is reachable. Setup, permissions and the end-to-end smoke test (`services/api/tests/cloud_smoke.py`) are in [ARCHITECTURE.md](docs/ARCHITECTURE.md#azure-mode-phase-2-cloud-path).

## Repository structure

```text
apps/web/            React, TypeScript, Vite UI (motion, lucide-react)
services/api/        FastAPI, SQLite ledger/state, replay and tests
services/simulator/  Seeded state-machine match simulator and CLI
services/analytics/  Deterministic metrics and moment detection (Python adapter)
services/agents/     Role prompts, validator, fallback narrator, eval fixtures
services/bridge/     Bridge worker: Eventhouse -> moments and narration jobs (SQLite or Cosmos DB store)
analytics/           Versioned illustrative threat grid and KQL (setup + queries)
infra/               Azure CLI script that recreates the Event Hubs resources
contracts/           Shared JSON Schemas (v1.1) and committed examples
docs/                Architecture, roadmap, and archived history
AGENTS.md            Primary coding-agent instructions
CLAUDE.md            Pointer to AGENTS.md
.cursor/rules/       Pointer to primary agent instructions
.github/             Pull-request template
```

Maintain four documents: this README, [AGENTS.md](AGENTS.md), [ROADMAP.md](docs/ROADMAP.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md). Prior context, component guides, decisions and verification history are preserved in [the archive](docs/archive/README.md). License selection is pending.
