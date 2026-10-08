# OmniPitch

OmniPitch transforms synthetic football events into explainable match intelligence, live multilingual narratives, personalized insights, and automated recaps using Azure and Microsoft AI. Those cloud and AI capabilities are the product direction; this checkout starts with a runnable local foundation.

## Implemented now

- React/TypeScript/Vite sample-data screen: connection status, match/score, latest pass, refresh, loading and error states.
- FastAPI health, sample match-state and completed-pass event endpoints.
- Deterministic, schema-validated completed-pass JSONL fixture generator with fictional teams/players.
- Shared JSON Schemas and examples, aligned Pydantic/TypeScript models, focused contract and simulator checks.
- Persistent project context, handoff, decisions, roadmap and coding-agent instructions.

## Planned

Live analytics, evidence-grounded narratives, key-moment highlights, tactical-pattern explanations, reusable datasets, multilingual insights, fan/analyst/producer preferences, and automated halftime/full-time recaps. Planned integrations: Azure Event Hubs, Fabric Eventstream/Eventhouse, Cosmos DB, Azure Functions, Microsoft Agent Framework/Foundry, Foundry IQ / Azure AI Search, and Web PubSub. None are connected or provisioned. 3D replay is stretch scope.

## Repository map

```text
apps/web/           React frontend
services/api/       FastAPI and local-path checks
services/simulator/ Deterministic fixture CLI
services/agents/    Documented placeholder; workflows pending
contracts/          Shared JSON Schemas and committed examples
analytics/          Documented placeholder; engine pending
docs/               Context, architecture, roadmap, progress, decisions, handoff
AGENTS.md           Coding-agent policies
CLAUDE.md           Claude onboarding pointer
.cursor/rules/      Cursor instruction convention
.github/            Pull-request template
```

The existing Git checkout is `C:\Users\akash\Desktop\omnipitch\omnipitch`, one directory below the workspace root supplied to this session. Initialization used that existing checkout and preserved its remote; no additional nested project was created. All commands below start in the **Git repository root**.

## Prerequisites and versions

Verified runtime availability: Windows PowerShell, Node **24.11.0**, npm **11.6.1**, Python **3.13.7**, pip **25.2** in `.venv`. Use Node 24 and Python 3.13 for the recorded baseline; other versions have not been tested. Vite's supported Node minimums are described in the [official guide](https://vite.dev/guide/).

Installed direct dependencies: React/React DOM **19.1.0**, TypeScript **5.8.3**, Vite **8.3.3**, React plugin **6.1.2**, React type packages **19.1.2**, AJV **8.20.0**, ajv-formats **3.0.1**. Backend: FastAPI **0.115.12**, Pydantic **2.11.4**, Uvicorn **0.34.2**. Verification: pytest **8.3.5**, httpx **0.28.1**, jsonschema **4.23.0**, rfc3339-validator **0.1.4**. Exact frontend resolution is in `apps/web/package-lock.json`; Python direct pins are in requirements files. Python transitive dependencies are resolved by pip, not fully locked.

No pre-existing dependencies conflicted. Initial older frontend pins were replaced after npm advisories and a slow Vite transformation; see progress for final results. No cloud credentials are required.

## Start the API — terminal 1, PowerShell

```powershell
cd C:\Users\akash\Desktop\omnipitch\omnipitch
python -m venv .venv
.venv/Scripts/Activate.ps1
python -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
python -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

If activation is blocked, invoke the virtual environment directly; do not globally weaken PowerShell execution policies:

```powershell
.venv/Scripts/python.exe -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

Backend `.env.example` documents `CORS_ORIGINS`; the API does not auto-load `.env`. Set it in the shell as shown. Comma-separated explicit localhost origins are allowed; arbitrary origins and credentialed CORS are not. Default is `http://localhost:5173`. API docs: [localhost:8000/docs](http://localhost:8000/docs). FastAPI application basics: [official tutorial](https://fastapi.tiangolo.com/tutorial/first-steps/).

## Start the frontend — terminal 2, PowerShell

```powershell
cd C:\Users\akash\Desktop\omnipitch\omnipitch\apps\web
Copy-Item .env.example .env
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). The frontend `.env` contains `VITE_API_BASE_URL=http://localhost:8000`. Restart Vite after configuration edits. It is a public backend URL; keep all credentials out of browser configuration. The strict Vite port matches CORS; resolve a port conflict rather than silently using 5174.

On macOS/Linux from repository root: `python3 -m venv .venv`, `source .venv/bin/activate`, `python -m pip install -r services/api/requirements-dev.txt`, then `CORS_ORIGINS=http://localhost:5173 python -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000`. In another terminal: `cd apps/web`, `cp .env.example .env`, `npm ci`, `npm run dev`. These platform-specific variants are documented but not verified in this Windows session.

## Generate a fixture — repository root

```powershell
$env:PYTHONPATH = "$PWD/services/simulator"
.venv/Scripts/python.exe -m simulator.generate --seed 7 --run-id demo-run-001 --output data/generated/demo.jsonl
Remove-Item Env:PYTHONPATH
```

Optional `--count` and `--baseline`; see [simulator README](services/simulator/README.md). Output path is replaced on each invocation. Generated datasets belong in gitignored `data/generated/`; committed contract examples are tracked. The API uses the same generator directly. Reading JSONL into replay is future work, not a streaming integration.

## Verification

From repository root:

```powershell
.venv/Scripts/python.exe -m pytest services/api/tests -q
.venv/Scripts/python.exe -m pip check
```

With API running:

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/api/v1/matches/demo/state
Invoke-RestMethod http://localhost:8000/api/v1/matches/demo/events
```

Frontend:

```powershell
cd apps/web
npm run test:contracts
npm run typecheck
npm run build
```

Optional combined live HTTP smoke check (both ports must be free, dependencies installed), from root:

```powershell
.venv/Scripts/python.exe services/api/tests/smoke_local.py
```

It starts temporary API/Vite processes, validates live responses and CORS, requests frontend modules/shared schema imports, invokes the simulator CLI, writes logs/output under `data/generated/`, and stops the processes. It does not automate browser interactions. Actual results are in [PROGRESS](docs/PROGRESS.md).

## Onboarding and hygiene

Start with [AGENTS.md](AGENTS.md), [CONTEXT](docs/CONTEXT.md), and [HANDOFF](docs/HANDOFF.md). See [architecture](docs/ARCHITECTURE.md), [contracts](contracts/README.md), and [roadmap](docs/ROADMAP.md). Agents and analytics are explicit placeholders with implementations pending.

Innovation Studio access is blocked by a hardware-token authentication prompt. The user has contacted support. This does not block local development. Azure/Fabric access has not been verified.

Local `.env`, virtual environments, node dependencies, build/test output and generated JSONL are ignored; `.env.example`, `.cursor/rules/` and contract fixtures are preserved. License decision is pending the owner; no license was selected. Initialization did not commit, push, deploy or provision resources.
