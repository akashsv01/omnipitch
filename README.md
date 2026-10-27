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

**Merged into `main` on 2026-10-27, not yet redeployed:** live spoken commentary, automatically narrated recaps, generation states, focus modes, the full Spanish interface and translations, server-side broadcast playout, narration, "Ask about this moment", shared geometry, the pass-difficulty indicator, simulated physical data and the `late_surge` scenario. The live demo and the recorded video show the earlier release until the next redeploy.

- **Honest generation states**: every insight carries `generation_status`: AI accepted, rule-based by design, AI pending, skipped (budget or settings, not an error), rejected by validation, or provider failure. Rule-based text is rebuilt from frozen evidence when served, so older runs never show outdated wording.
- **Personalisation**: Fan and Analyst views, plus a focus on one player (recorded involvement, last action, linked moments), one club (context and the latest development against it) or one metric (pressing, passing or shots: definition, valid trend and source moments). Focus filters and highlights; the history always stays in match order.
- **Bilingual storytelling**: the whole interface (controls, labels, tabs, charts, evidence and Ask) switches between English and Spanish. Rule-based stories use Spanish templates; accepted AI text is translated by the model in the background and shown only if every number and name survives the code check, otherwise the Spanish template stands in. Recaps, including the AI rewrite, commentary, broadcast cues and transcripts are bilingual, with the same numbers, names and score and a decimal comma.
- **Live spoken commentary**: one **Enable commentary** switch above the pitch. From then on the match is called automatically: play-by-play from validated events (kick-off, shots, saves, goals with the score, ball wins) plus context from detected moments, composed on the server and read by Azure AI Speech. Goals are never queued behind other lines; at high replay speeds routine lines are dropped so speech stays current. Pause, skip, replay, mute and a transcript are in the same bar, and one audio controller means two voices never overlap.
- **Automatic recaps**: half-time and full-time recaps are created when the period ends, cut off at that period's last event, shown in the Recap tab and, with commentary on, narrated once (not repeated after a reload or reconnect). "Match so far" recaps are provisional. A late response after a backward seek is ignored.
- **Broadcast output**: `/overlay` (program output, `?clean=1` for a keyable transparent background) and `/producer` (on air, queue, log and the cue JSON). One server-side playout per audience and language (`GET /api/v1/broadcast`) schedules the cues, so every screen shows the same cue at the same time. Cues follow `contracts/schemas/broadcast-cue.schema.json`: a goal pre-empts other cues, stale cues are dropped at high replay speeds, rule-based cues are revised in place when accepted AI text arrives, and a seek or new run clears the queue.
- **Narration**: "Listen + replay" in the evidence drawer plays the moment's source sequence with captions and the accepted text as audio. It outranks live commentary, which waits behind it. Without a Speech configuration, captions and transcripts still work and the UI says audio is unavailable.
- **Pass difficulty and simulated physical data**: a 0–100 pass-difficulty indicator from length, forward gain, destination and width (routine, moderate, difficult; not a completion probability). Running distance, top speed and ball speed are **simulated** from the match's own events and always labelled as such; there is no tracking.
- **Ask about this moment**: fixed questions (why flagged, how calculated, what happened before, what the evidence supports, what is unknown) answered deterministically from the moment's evidence, with clickable source events. No model is used.
- **Local latency** (2026-10-27, `services/api/tests/latency_local.py`): seed 7, the full match with 31 duplicate deliveries, swapped pairs and one event held back for 30 requests. Receipt → validated rule-based insight p50 218 ms, p95 2.4 s (p95 includes waiting for the held-back event). The 55 moments are identical to a clean delivery, with 0 request failures.

Everything below also runs locally without cloud credentials:

- **Seeded match simulator**: a state machine that produces a full two-period match of about 1,200 events. Event types are completed and incomplete passes, shots (goal, saved, off target, blocked), tackles, interceptions, challenges, fouls and period markers. The `standard`, `high_press`, `quiet` and `late_surge` scenarios bias probabilities; they never script narratives. `late_surge` seed 18 is a reproducible comeback (Vale trail, then win 3–1).
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
6. Switch **Fan view** / **Analyst view** at the top: the same facts and replay position, presented for each audience. **EN / ES** switches the interface and the explanations to Spanish.
7. Select **Match recap** (or **Match analysis → Recap**) for the half-time or full-time recap (marked **Reconciled** when final).
8. Press **Enable commentary** above the pitch to hear the match called live; the half-time recap is read out when the half ends. Diagnostics such as **Data quality** appear only in development builds.

The replay is shared by everyone viewing the site, so another viewer's play, pause or seek moves yours too. All teams, players and events are synthetic.

## Known limitations

Recorded against the challenge brief; none is hidden in the UI.

- **No player tracking:** the synthetic data has event locations only, so there is no player speed or distance, no off-ball movement and no formations.
- **Simulated, not measured:** running distance, top speed and ball speed are generated from the match's events and labelled "sim."; the pass-difficulty indicator is a heuristic without defender positions or pressure.
- **Not built:** auto-eventing from video. It needs match video and a vision pipeline (player and ball detection, tracking, event classification), and this project has neither; it is a deliberate omission. Explicit pressure or possession-change event types are also not modelled.
- **Language:** a Spanish AI translation appears only after the model has translated it and the code check has passed; until then the Spanish template is shown. Moment limitation notes are stored in English and translated at display.
- **Narration audio:** verified locally against a real Azure AI Speech resource (2026-10-27). The deployed API needs its own resource in the deployment's tenant (its managed identity cannot use one in another tenant), so the live site stays captions-only until that resource is added and the branch is redeployed.
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

Broadcast views: open `/producer` (add `?audience=analyst&lang=es` to switch) and, from it, the program output at `/overlay`. For narration audio, set `SPEECH_REGION` and `SPEECH_RESOURCE_ID` in `services/api/.env` (template in `.env.example`) and install `services/api/requirements-azure.txt`. The resource needs a custom subdomain, can have key auth disabled, and your identity needs *Cognitive Services Speech User* on it; the free F0 tier is enough for the demo. Without these settings, narration stays captions only. Local latency: `.venv/Scripts/python.exe services/api/tests/latency_local.py`.

To try it, choose Fan or Analyst on the landing page and select **Enter match room** (or open `/match` directly). Press **Start replay** (or Space). Moments appear in the right column. **Why this matters** (Fan) or **Inspect evidence** (Analyst) opens the source sequence, values, calculation and limitations, with a 2D/3D switch. Switch between **Fan view** and **Analyst view** at the top at any time; the replay is unaffected. Use the shuffle button beside the filmstrip to generate another seed or scenario, or to load a JSONL file. Click a goal pin on the filmstrip, or **Jump to moment**, to jump.

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
