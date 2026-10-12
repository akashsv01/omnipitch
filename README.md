# OmniPitch

OmniPitch is a hackathon project turning synthetic football events into explainable match intelligence. Multilingual narratives, personalized insights, recaps, and Azure/Microsoft AI integration are the product direction.

## Current status

Implemented: React/TypeScript sample-data UI with refresh and loading/error states; FastAPI health, match-state and five-pass endpoints; deterministic JSONL fixture generator; shared schemas, examples and validation checks. All teams and players are fictional.

Replay, a 2D pitch, analytics, AI agents, persistence and cloud integration are **planned**. See the [roadmap](docs/ROADMAP.md) and [technical reference](docs/ARCHITECTURE.md).

## Local setup

No cloud credentials are needed. The recorded October 7 baseline used Node 24.11.0/npm 11.6.1 and Python 3.13.7 on Windows; other runtime/platform combinations have not been verified. Start from your Git repository root.

Terminal 1 (PowerShell):

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

Terminal 2 (PowerShell, also starting at repository root):

```powershell
cd apps/web
Copy-Item .env.example .env
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173) and [API docs](http://localhost:8000/docs). Frontend `.env` uses `VITE_API_BASE_URL=http://localhost:8000`; restart Vite after edits. The API reads shell variables, not `.env`. Keep credentials out of browser configuration. Vite requires port 5173 to be free.

For simulator commands, verification and macOS/Linux variants, see [local tools and verification](docs/ARCHITECTURE.md#local-tools-and-verification).

## Repository structure

```text
apps/web/           React, TypeScript, Vite UI
services/api/       FastAPI and local-path tests
services/simulator/ Deterministic fixture generator
services/agents/    Reserved agent package; implementation pending
analytics/          Reserved analytics area; implementation pending
contracts/          Shared JSON Schemas and committed examples
docs/               Architecture, roadmap, and archived history
AGENTS.md           Primary coding-agent instructions
CLAUDE.md           Pointer to AGENTS.md
.cursor/rules/      Pointer to primary agent instructions
.github/            Pull-request template
```

Maintain four documents: this README, [AGENTS.md](AGENTS.md), [ROADMAP.md](docs/ROADMAP.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md). Prior context, component guides, decisions and verification history are preserved in [the archive](docs/archive/README.md). License selection is pending.
