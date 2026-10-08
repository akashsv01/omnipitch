# API

Current status: local FastAPI application serving explicit Pydantic models with deterministic fictional data.

- `GET /health`: `{ "status": "ok", "application": "omnipitch-api" }`.
- `GET /api/v1/matches/demo/state`: committed match-state fixture.
- `GET /api/v1/matches/demo/events`: `{ "events": [...] }`, the shared five-pass generator output.
- `/docs`: interactive OpenAPI documentation.

From repository root, PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/Activate.ps1
python -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
python -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

If activation is blocked, do not globally weaken execution policies. Invoke the environment directly:

```powershell
.venv/Scripts/python.exe -m pip install -r services/api/requirements-dev.txt
$env:CORS_ORIGINS = "http://localhost:5173"
.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000
```

`.env.example` documents configuration. The backend does not auto-load `.env`; set the shell environment explicitly. `CORS_ORIGINS` accepts comma-separated explicit localhost origins. No arbitrary origins or credentialed CORS. Default is `http://localhost:5173`.

Tests from root: `.venv/Scripts/python.exe -m pytest services/api/tests -q`. Runtime-only installation can use `requirements.txt`; tests and simulator CLI additionally need `requirements-dev.txt`.

See [contracts](../../contracts/README.md). No JSONL ingestion, event streaming, analytics, persistence, authentication or agents. Sample data imports the local simulator; run from this monorepo.
