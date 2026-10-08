# Web

Current status: React/TypeScript/Vite development screen with backend connection status, fictional match score, latest completed pass, refresh, loading and error states. Match/event data comes from FastAPI; no separate frontend fixture. Ordinary CSS, no router or global state framework.

From this directory:

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

Set `VITE_API_BASE_URL=http://localhost:8000` in `.env`; restart Vite after edits. It is a public URL, never a place for credentials. Defaults to the same localhost URL. Vite serves `http://localhost:5173` with a strict port, matching API CORS. FastAPI must run separately; see [root startup](../../README.md).

```powershell
npm run test:contracts
npm run typecheck
npm run build
```

AJV validates wire responses using shared JSON Schemas. HTTP/network/contract errors become visible UI messages. `contract-check.ts` checks TypeScript fixture alignment during typecheck. No analytics, replay, 2D/3D pitch or narrative endpoint yet.
