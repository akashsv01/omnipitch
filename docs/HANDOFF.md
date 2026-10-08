# Handoff

Current functionality: local React screen fetches deterministic sample match and five completed passes from FastAPI, with refresh and loading/error/success states. JSON Schemas/Pydantic/TypeScript share conventions. Simulator generates validated reproducible JSONL; no JSONL ingestion, AI, analytics engine, databases, WebSockets or cloud integrations.

Repository root: existing checkout `C:\Users\akash\Desktop\omnipitch\omnipitch`; remote preserved. Do not create another nested directory.

Run: see [README](../README.md) for installation and PowerShell fallback. From root, `.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir services/api --host localhost --port 8000` with `CORS_ORIGINS=http://localhost:5173`. From `apps/web`, copy `.env.example` to `.env`, `npm ci`, `npm run dev`; `VITE_API_BASE_URL=http://localhost:8000`.

Last verified: 2026-10-07, 25 Python tests passed (one upstream deprecation warning), pip check passed, three frontend fixtures valid, final TypeScript/production build passed (Vite 8.3.3), combined live HTTP smoke check passed on the final baseline. Final npm install audit reported zero vulnerabilities. See [PROGRESS](PROGRESS.md) for recorded details. No browser interaction test or cloud access check.

Blockers: Innovation Studio access is blocked by a hardware-token authentication prompt. The user has contacted support. This does not block local development. Azure/Fabric access unverified; license pending owner decision.

Next three concrete tasks (do only the assigned task):
1. Generate a synthetic pass, serve it through the API, and draw it on a 2D React pitch.
2. Load a selected validated JSONL replay with explicit run reset and ordered playback controls.
3. Define and test one deterministic pass metric with units and run-scoped evidence references.

Relevant files: `apps/web/src/App.tsx`, `src/lib/api.ts`, `src/types/contracts.ts`; `services/api/app/main.py`, `schemas.py`, `sample_data.py`, `tests/test_local_path.py`, `tests/smoke_local.py`; `services/simulator/simulator/generate.py`; `contracts/schemas/` and `contracts/examples/`. Read `AGENTS.md` and `CONTEXT.md` first; keep docs aligned with actual code and checks.
