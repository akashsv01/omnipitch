# OmniPitch

OmniPitch is a hackathon project that turns synthetic football events into explainable match intelligence. It explains why a moment matters, shows the evidence and calculation behind the explanation, and adapts the same facts for fans and analysts. All teams, players and events are fictional.

## Current status

Phases 1–5 are complete, and the scope is frozen for submission (bug fixes only). The deployed demo runs the full pipeline:

simulator → Azure Event Hubs → Fabric Eventstream → Eventhouse (KQL) → bridge worker → Cosmos DB (moments, narration jobs, period reconciliations) → narration worker (`gpt-4.1-mini`, Entra ID) → API → Web PubSub push → browser.

- **Grounded AI narration**: each moment gets exactly one insight. The model's text is checked in code against the moment's evidence; anything that fails, or any job that hits the model's rate limit, keeps a labelled deterministic template. Every moment shows how its text was produced: **AI · validated**, **Rule-based**, or a labelled fallback.
- **Recaps**: half-time and full-time recaps built from verified moments, marked **Reconciled** once the bridge has checked that period.
- **Live push**: Web PubSub tells the browser when a new snapshot is ready; the snapshot API stays the source of truth.
- **Deployment**: the API and UI run on Azure Container Apps with a managed identity (no keys), scale to zero and preload a full demo match.
- **Measured latency** (2026-10-25): event ingested → moment detected p50 6.5 s; moment → insight published p50 about 5.5 min, limited by the model's tokens-per-minute quota. See the [roadmap](docs/ROADMAP.md).

Everything below also runs locally without cloud credentials:

- **Seeded match simulator**: a state machine that produces a full two-period match of about 1,200 events. Event types are completed and incomplete passes, shots (goal, saved, off target, blocked), tackles, interceptions, challenges, fouls and period markers. The `standard`, `high_press` and `quiet` scenarios bias probabilities; they never script narratives.
- **Replay**: play, pause, resume, speed (1–80×), seek, reset (new run ID), generate a new seeded match, and load JSONL. Position is persisted in SQLite, so an API restart restores the same run, paused.
- **Deterministic analytics** (Python adapter, the documented fallback for Fabric/KQL): progression, final-third and box entries, an illustrative 16 × 12 threat grid, windowed PPDA with sample gates, momentum, player contributions and a pass network.
- **Moment detection**: goal, chance, threat gain, transition and pressing-change rules. Moment IDs are stable, evidence is frozen at detection time, and moments are created conditionally.
- **Ledger ingestion**: `(run_id, event_id)` deduplication, conflict and invalid diagnostics, and metrics computed only over a gap-free sequence prefix.
- **Grounded narration groundwork**: Analyst/Coach/Broadcaster prompts, an evidence-packet builder, a code-side output validator, a deterministic fallback narrator and a 34-case evaluation set. Locally, without the cloud workers, every insight is a deterministic template.
- **Web app**: a landing page (`/`) with an illustrative 3D pitch, leading into the match room (`/match`): a broadcast-style match room with an animated 2D pitch (ball travel, shot ripples, goal celebration, recent-play trail, plus threat-grid, event-density and pass-network layers), a ticking scoreboard and momentum strip, a moment spotlight with distinct Fan and Analyst compositions and favourite-player priority, an evidence drawer with a lazy-loaded 3D view of the source sequence, rule-based explanations in English or Spanish, and analysis tabs (team comparison, PPDA chart, players, shot map, data quality with a live duplicate-delivery test). Reduced-motion and keyboard support are included.

## Try the live demo

The demo address is in the submission form.

1. Open it. The first load after a quiet period can take up to a minute while the app starts; if the page says it can't reach the match API, wait a few seconds and press **Try again**.
2. Choose **Fan** or **Analyst** and select **Enter match room** (or open `/match` directly). Press **Start replay** (or Space); the filmstrip under the pitch shows where goals and moments are.
3. Arriving mid-match? A **Catch up** card above the moments says when you joined, the score at that point and up to three moments to open first; it only covers what happened before you arrived, and it is remembered for the browser tab.
4. Watch **Key moments**: each one says how its text was produced (**AI · validated** or **Rule-based**). The first AI-narrated moments appear around 25'; click a goal pin or a moment to jump or inspect it.
5. Press **Why this matters** (Fan) or **Inspect evidence** (Analyst): the explanation, the numbered source sequence (2D, or 3D on demand), the values, the trigger and the limitations.
6. Switch **Fan view** / **Analyst view** at the top: the same facts and replay position, presented for each audience. **EN / ES** switches the rule-based explanations to Spanish (AI-written text stays in English).
7. Select **Match recap** (or **Match analysis → Recap**) for the half-time or full-time recap (marked **Reconciled** when final), and **Data quality** for the live-push link and the count of AI-written and checked insights.

The replay is shared by everyone viewing the site, so another viewer's play, pause or seek moves yours too. All teams, players and events are synthetic.

## Known limitations

Recorded against the challenge brief; none is hidden in the UI.

- **No player tracking:** the synthetic data has event locations only, so there is no player speed or distance, no off-ball movement and no formations.
- **Not built:** pass-difficulty ratings, ball or shot speed, auto-eventing from video, explicit pressure or possession-change event types, and a broadcast-overlay output.
- **Personalisation:** a favourite team or player reorders and highlights moments; there is no mode that follows one player through the match.
- **Language:** rule-based explanations are available in English and Spanish. AI-written text and the rest of the interface are English only.
- **AI latency:** a moment is detected within seconds, but its AI text arrives minutes later (p50 about 5.5 min), limited by the model's tokens-per-minute quota. Until then, the rule-based text is shown and labelled. AI recap rewriting is off in the deployment.
- **One shared replay:** everyone viewing the site sees the same replay state.

## Local setup

Verified from a fresh clone on Windows with Node 24.13.1 and Python 3.11.3 on 2026-10-25. Start from the repository root.

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

Open [localhost:5173](http://localhost:5173) and the [API docs](http://localhost:8000/docs). If Windows reports `EACCES` on 5173 (a reserved port range), run `npm run dev -- --port 5212` and add `http://localhost:5212` to `CORS_ORIGINS`. The API stores runs in `data/generated/omnipitch.sqlite3` (gitignored); set `OMNIPITCH_DB_PATH` to change the location, and delete the file to start fresh. Run the API with one worker. To run the full backend test suite, also install `services/bridge/requirements.txt` (the Cosmos client some tests import), then run `.venv/Scripts/python.exe -m pytest services/api/tests -q`.

To try it, choose Fan or Analyst on the landing page and select **Enter match room** (or open `/match` directly). Press **Start replay** (or Space). Moments appear in the right column. **Why this matters** (Fan) or **Inspect evidence** (Analyst) opens the source sequence, values, calculation and limitations, with a 2D/3D switch. Switch between **Fan view** and **Analyst view** at the top at any time; the replay is unaffected. Use the shuffle button beside the filmstrip to generate another seed or scenario, or to load a JSONL file. Click a goal pin on the filmstrip, or **Replay moment**, to jump.

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
infra/               Azure CLI scripts: Event Hubs; Container Apps deployment
deploy/              Dockerfiles for the API and UI, and the UI's nginx config
contracts/           Shared JSON Schemas (v1.1) and committed examples
docs/                Architecture, roadmap, and archived history
AGENTS.md            Primary coding-agent instructions
CLAUDE.md            Pointer to AGENTS.md
.cursor/rules/       Pointer to primary agent instructions
.github/             Pull-request template
```

Maintain four documents: this README, [AGENTS.md](AGENTS.md), [ROADMAP.md](docs/ROADMAP.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md). Prior context, component guides, decisions and verification history are preserved in [the archive](docs/archive/README.md). License selection is pending.
