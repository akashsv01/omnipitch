# Roadmap

Phases describe intended work, not committed completion dates. Implement only the assigned task.

## Current state

**Phase 4 in progress (2026-10-20; merged to `main` via PR #12, live check on branch `phase4-live`).** Implemented and tested locally: meaning checks in code (score state, box position, pass counts, defender breach, transition direction, fan text that mentions missing data) with prompts v3 and derived facts in the evidence packet; a validated overlay that shows the narration worker's Cosmos insights in the UI (`OMNIPITCH_INSIGHTS=cosmos`), re-checking each one against the API's own moment and reporting its status; halftime/full-time recaps (`GET /api/v1/replay/recap`, contract `recap.schema.json`) built from verified moments, with an optional checked AI rewrite (`OMNIPITCH_RECAP_AI=on`); a Recap tab whose key moments seek the replay; a half-time/full-time prompt; AI/Template labels on every moment. Live check 2026-10-20 (`services/api/tests/phase4_live.py --run-id p4-live-20261020-a --seed-local --ai-jobs 6`): 55 moments and jobs created in Cosmos with the bridge's detector (Eventhouse hop UNVERIFIED for this run), 6 of 6 model-narrated jobs (prompts v3, `gpt-4.1-mini`) published validated AI insights, 49 fallback; the API overlay showed all 55 with 0 rejected, both recaps linked verified moments, and a restarted API restored score, clock and insights. Reading the six AI texts found one meaning error the checks missed ("keep the score intact" on a chance); the score-state rule was extended, and the overlay now rejects that stored insight on display (54 narrated, 5 AI, 1 rejected, seen in the browser after an API restart that restored the run). The same live check exposed an API defect the tests missed: with `OMNIPITCH_INSIGHTS=cosmos` every request returned 500 because `services/bridge` (the shared Cosmos client) was not on the API's import path; fixed, and a failed insight source is now reported in the snapshot instead of failing requests. Not yet done: the joint run through Eventhouse and Tanmayee's bridge, bilingual text, deployment.

**Current phase (2026-10-20): Phase 3 complete; Phase 4 next.** Phases 1–3 are implemented and verified. Phase 2: the cloud path simulator → Event Hubs → Fabric Eventstream → Eventhouse → API → browser was verified on `smoke-20261016-a`. Phase 3: the bridge worker writes moments and jobs to Cosmos DB, and the narration worker (live `gpt-4.1-mini`, Entra ID) turns each into exactly one validated insight with a labelled fallback; the joint gate passed on `gate-20261020-b`. Everything runs locally against the cloud services; nothing is deployed yet. Earlier summary of the local scope (2026-10-14): Phase 1 and the local scope of Phase 2 are implemented and verified (2026-10-14). That covers a seeded state-machine simulator with scenarios; replay with speed, seek and generate; contracts v1.1; a SQLite event ledger with deduplication and restart recovery; deterministic metrics (progression, illustrative threat, windowed PPDA with sample gates); five moment rules with frozen evidence; prepared agent prompts with a validator, fallback narrator and evaluation set; and a redesigned, motion-rich match room with an evidence drawer and fan/analyst modes. Cloud status is in the Phase 2 table below: the Event Hubs → Fabric Eventhouse path is verified end to end. No model is called; every insight is `generation_mode: fallback`.

**Phase 2 status (2026-10-16): complete.** Run `smoke-20261016-a` (seed 7, standard, 400 events + 25 deliberate duplicates) travelled simulator → Event Hubs (UMD tenant) → Fabric Eventstream → Eventhouse (UF tenant) → azure-mode API → browser. Fabric names (not secrets): workspace `OmniPitch` on the Fabric trial capacity (East US), Eventhouse `omnipitch`, KQL database `omnipitch`, table `OmniPitchEvents`, Eventstream `omnipitch-stream`. The send stage was confirmed by the publisher (Akash: 400 sent, 25 re-delivered) and is consistent with the 425 rows / 400 unique IDs ingested; the Fabric-side smoke run reports it UNVERIFIED because `--skip-publish` cannot see the sender.

| Stage | Status | Evidence or blocker |
| --- | --- | --- |
| Simulator → Event Hubs | Verified (2026-10-15; this run confirmed by the publisher 2026-10-16) | `simulator.publish` with Entra ID. For `smoke-20261016-a` the publisher reported 400 sent + 25 re-delivered; `cloud_smoke.py --skip-publish` reports `event_hubs_send` UNVERIFIED by design on the Fabric side. |
| Event Hubs → Eventstream → Eventhouse | Verified (2026-10-16) | Eventstream `omnipitch-stream` (source `azure-event-hub`, consumer group `fabric-eventstream`, listen-only SAS) → destination `omnipitch-eventhouse`, direct ingestion into the existing table and existing mapping `OmniPitchEvents_json`. Source and destination Active. |
| Event IDs queryable in Eventhouse | Verified (2026-10-16) | `smoke-20261016-a`: 425 rows, 400 unique `event_id`, max sequence 400, ingested 03:01:15 UTC; `.show ingestion failures` empty. |
| API reads Eventhouse | Verified (2026-10-16) | `/ready` → `ready`, mode `azure`; `cloud_smoke.py` stage `api_reads_eventhouse` PASS (source `eventhouse`, 400 events). |
| Browser shows the cloud run | Verified (2026-10-16) | Top bar `Azure · Eventhouse`; dock `Eventhouse run smoke-20261016-a`; Data quality → Fabric Eventhouse: 425 / 400 / 25 and 12 of 12 parity rows `match`; no console errors. |
| Dedup, fixture calculations, sparse windows | Verified on cloud data (2026-10-16) | `cloud_smoke.py`: `dedup_and_contract`, `metrics_parity`, `ppda_and_sparse_windows` PASS. |

2026-10-16 cloud verification (UF Fabric trial, East US; API and web app local). `cloud_smoke.py --run-id smoke-20261016-a --skip-publish --api http://localhost:8000`, run twice on 2026-10-16 (second run 03:11 UTC) with identical results: `event_hubs_send` UNVERIFIED (skipped; publisher machine); `eventhouse_query` PASS (425 rows, 400 unique); `dedup_and_contract` PASS (25 duplicate rows collapsed; payloads identical to the seeded fixture); `metrics_parity` PASS (counts and progression KQL vs Python, threat Eventhouse vs fixture); `ppda_and_sparse_windows` PASS (windows: 5 ok, 5 insufficient sample, 2 without defensive actions; 1 pressing claim, none from a sparse window); `api_reads_eventhouse` PASS; `browser_display` checked in a browser (Data quality → Fabric Eventhouse → Load run `smoke-20261016-a`: `Azure · Eventhouse`, dock `Eventhouse run smoke-20261016-a`, 12 of 12 parity rows `match`, no console errors). The report is `data/generated/cloud-smoke-smoke-20261016-a.json` (gitignored, not committed). The first live calls exposed three defects that the fake-reader tests could not: the Kusto server timeout was passed as a string (`/ready` returned 502); the browser aborted Eventhouse requests after 8 s (live run detail takes about 6 s); and card CSS enlarged icons. All three are fixed, along with a test fixture that let a developer's azure `.env` leak into tests. After the fixes: 77 Python tests, frontend contract and pitch checks and the production build passed. Not tested: Safari/Firefox, a deployed (non-local) API, latency percentiles.

Fabric setup notes: in the Eventhouse destination wizard, "Use existing mapping" lists `OmniPitchEvents_json` only after a data sample has loaded, and until then it offers an auto-generated `OmniPitchEvents_mapping`, which must not be used. The KQL database's internal ID differs from its display name; `EVENTHOUSE_DATABASE=omnipitch` works. A listen key was pasted into a chat during setup; rotating it (`az eventhubs eventhub authorization-rule keys renew ... --key PrimaryKey`) and updating the Fabric connection was recommended.

Resources created on 2026-10-15 in Azure for Students (Owner), then **deleted the same day (00:31 UTC) at the owner's request to save credit**. Total usage was about 30 minutes of 1 TU; afterwards the subscription has 0 resources. `infra/eventhubs.ps1` recreates the same names. The owner recreated the namespace on 2026-10-16 with the same names (the Eventstream preview showed probe run `probe-20261016-0203-recreate`); it exists again and draws credit. What existed: provider `Microsoft.EventHub` registered; `rg-omnipitch-dev` (East US); namespace `omnipitch-ehns-qn36t` (Standard, 1 TU, about $0.73/day of credit); hub `match-events`; consumer group `fabric-eventstream`; `Azure Event Hubs Data Sender` for the developer at hub scope; listen-only SAS rule `eventstream-listen`. No Fabric capacity was purchased. Verification on 2026-10-15: 77 Python tests passed, frontend contract and pitch checks and the build passed, and `cloud_smoke.py` reported Event Hubs PASS and the Eventhouse stage UNVERIFIED (not configured).

Next tasks, in order (2026-10-20; submission due 2026-10-27, 11:59 PM PT):

1. Phase 4: show validated insights and moments live in the UI from Cosmos (fan/analyst views and evidence), add halftime/full-time recaps linked to verified moments, and close the semantic gaps found at the gate (score state and inside-box facts in the evidence packet; no defender-breach phrasing). Implemented on `phase4-experience` (see Phase 4 below); remaining: a fresh live run (publish → bridge → narrate with prompts v3) shown through the overlay.
2. Deployment for judges, the largest open risk: the API, bridge and narration worker run on laptops today, and judges need a working URL until 2026-11-10.
3. Housekeeping: rotate the Event Hubs listen key that was exposed during setup and update the Fabric connection; decide whether to keep the Event Hubs namespace (about $0.73/day of credit).

2026-10-14 Phase 1 completion + Phase 2 (local) verification. 70 Python tests passed in about 23 s, covering simulator invariants for three scenarios, hand-calculated progression/threat/PPDA fixtures, both attack directions and the halftime switch, grid boundaries, zero-denominator and sparse PPDA, prefix-stable detection, duplicate and out-of-order ingestion with unchanged counts, gap handling, incremental snapshot polling, seek/speed/generate, SQLite restart recovery, and 34 validator evaluation cases. Also passing: `npm run test:contracts` (four fixtures plus three invalid examples rejected), `npm run test:pitch` (SSR pitch checks), `npm run build` (TypeScript and Vite; 543 kB JS bundle warning), and `npm run test:replay:browser` with `API_PORT=8011 WEB_PORT=5214` in headless Chrome (upload, play/pause/resume/finish, refresh recovery, seeded generation, analyst wording, evidence drawer, reset identity, no runtime errors). The UI was inspected manually via Playwright screenshots at 1440 × 900 and 390 × 844: no horizontal overflow on mobile, and zero console errors or warnings during a normal session. A live API restart restored the run paused at the same position. Not run: a Python security audit, cloud access checks, Safari/Firefox, and real-device mobile testing. No new Python dependencies; frontend added `motion` 12.23.12 and `lucide-react` 0.544.0 (npm audit reported 0 vulnerabilities). No commit or push.

Last recorded application verification before this work (2026-10-07): 25 Python tests passed with one upstream deprecation warning; pip check, three frontend fixture checks, TypeScript/production build and final live HTTP smoke check passed. npm installation audit reported zero vulnerabilities then; no Python security audit, browser interaction test or cloud access check was run. Details: [historical progress](archive/PROGRESS.md).

Documentation consolidation (2026-10-11): reduced active documentation to four files, preserved historical/component documents in the archive, transferred current requirements and decisions, and updated onboarding pointers. Verification: all 44 relative links/anchors across 16 Markdown files resolved; all 10 archived files matched their originals after accounting for relocated link destinations and newline normalization; `git diff --check` passed. Scope inspection confirmed only documentation and the Cursor onboarding pointer changed. Application tests were not rerun for this documentation-only change. No commit or push was made.

Known blockers (carried forward, not rechecked): Innovation Studio hardware-token authentication prompt; support was contacted. Local development is unaffected. Azure/Fabric/Foundry access remains unverified; license selection is pending. Start access probes alongside local work; provisioning requires authorization.

Documentation wording cleanup (2026-10-11): simplified project descriptions and task labels across active and archived guides. All 44 internal links/anchors resolved and `git diff --check` passed. Application functionality is unchanged; application tests were not rerun.

## Phase 0 — local scaffold and contracts

- [x] Local frontend/API scaffold and documented startup verified.
- [x] Deterministic fixture generator and contract checks verified.
- [ ] Choose repository license.
- [ ] Resolve Innovation Studio hardware-token blocker; probe Azure/Fabric/Foundry access without provisioning unless authorized.

## Phase 1 — synthetic replay and interactive 2D pitch

- [x] Draw a synthetic pass on a 2D React pitch using the existing generator and event endpoint; select passes and inspect event details.
- [x] Load a selected JSONL replay with run resets and ordered playback.
- [x] Add pause/resume controls and explicit coordinate/attack labels.

Phase 1 was first closed on 2026-10-13 with completed-pass replay only; the 2026-10-14 completion below adds the remaining guide items. Authentication/host control and cloud streaming are still not implemented.

2026-10-13 frontend slice: added a responsive SVG pitch, selectable API pass cards and synchronized event details with empty-state handling and accessible labels. Verification: `npm run test:contracts` passed for all three fixtures; `npm run test:pitch` passed both-direction/boundary, empty-state and initial-selection checks; `npm run build` passed including TypeScript; `git diff --check` passed. Existing locked dependencies were installed; no new dependencies or Microsoft services were added. Browser interaction/visual checks, live HTTP smoke and backend tests were not run for this frontend slice. No commit or push made.

2026-10-13 replay slice: added atomic replay snapshot schema/example, JSONL upload validation, locked API replay clock/control endpoints and polled frontend controls/progress. Verification: 42 Python tests passed (one upstream deprecation warning); four frontend contract fixtures, pitch checks, TypeScript/production build and `git diff --check` passed. A real headless Chrome run passed upload/order, play/pause/resume/finish, pass selection, page refresh, invalid-file preservation and reset-ID checks; the reset-state screenshot was inspected. Windows runtimes: Python 3.11.3, Node 24.13.1/npm 11.8.0. No new dependencies, Microsoft services, cloud access checks, commits or pushes. The original combined HTTP smoke script was not rerun; the new browser smoke exercised live API/Vite and replay paths.

2026-10-14 Phase 1 completion (gaps against the project guide): the simulator became a seeded state machine with scenarios (the guide asks for "state machine, not random rows"); contracts moved to v1.1 with shots, defensive actions, incomplete passes and period markers, plus invalid examples; replay gained speed selection (F01), seek and seeded generation; replay state now persists across API restarts. Cloud access probes remain blocked on authorization, so the guide's day-two fallback, the Python analytics adapter, was selected.

## Phase 2 — verified metrics and moment detection

- [x] Define deterministic metrics with units and test evidence attribution (`services/analytics`, `metrics-v1`, hand-calculated fixtures).
- [x] Detect a small set of moments; verify against labeled synthetic fixtures (goal, chance, threat gain, transition, pressing change; prefix-stable IDs; quiet run produces few moments).
- [x] Define duplicate and out-of-order delivery behavior (SQLite ledger keyed by run/event; identical repeats ignored, conflicting repeats rejected to diagnostics, gap-free prefix for metrics).
- [x] Typed metric cards, timeline, evidence panel and fan/analyst toggle connected to the API.
- [x] Event Hubs producer with Entra ID, partition key per run and match, verified live on 2026-10-15.
- [x] Fabric Eventstream → Eventhouse ingestion, plus a live run of the versioned KQL (`analytics/kql`), verified 2026-10-16 on `smoke-20261016-a`.
- [x] Live end-to-end smoke test (`services/api/tests/cloud_smoke.py --api`) with the browser showing the Eventhouse run (2026-10-16).

## Phase 3 — grounded AI narratives and validation

Phase 3 follows the guide's gate: a live detected moment becomes one validated insight; repeated events or worker restarts create no duplicates; a model failure yields a factual fallback. Work is split: the data half (bridge worker, `services/bridge/`) and the AI half (narration worker, `services/agents/`) meet at the job record (`contracts/schemas/job.schema.json`).

**Bridge, 2026-10-16 (merged to `main` as 479e3fa via PR #4).** `services/bridge/` polls Eventhouse for runs ingested after a durable cursor minus a 2-minute lookback (`analytics/kql/runs_since.kql`), re-reads each touched run deduplicated, validates rows, analyses only the gap-free prefix with the shared detector, and creates moment and job records only if absent. The cursor advances only after all touched runs are written, and a periodic reconcile re-reads recent runs regardless of the cursor. Records go to a local SQLite store (`data/generated/bridge.sqlite3`) whose interface is meant to be implemented by a Cosmos DB store. Jobs have conditional, version-checked claim and complete, lease expiry, `retry_wait`, and at most 2 attempts; an abandoned last attempt becomes `failed`. Verification: 10 new tests (87 in total) cover the job contract, one pending job per moment, 25 duplicates plus reprocessing creating nothing, restart from the persisted cursor, a late out-of-order event delaying moments without changing frozen evidence, the lookback, a failed cycle keeping the cursor, invalid rows, and lease, claim, complete and retry behaviour. Replacing create-only-if-absent with overwrite made the duplicate test fail, as intended. Live, against the UF Eventhouse: the first cycle read `smoke-20261016-a` (400 rows after dedup, 0 rejected) and created 24 moments and 24 pending jobs, matching local detection on the seeded fixture; a second process restart created 0. Not done: the Cosmos DB store (UF Azure for Students allows only westus, germanywestcentral, francecentral, norwayeast and denmarkeast; `Microsoft.DocumentDB` is not registered; no Cosmos account exists, so the free tier is unused), deployment, and the narration worker that claims jobs.

**Narration worker, 2026-10-16 (merged to `main` via PR #5).** `services/agents/` claims jobs with `claim_next`, builds the evidence packet, runs Analyst and Tactical Coach concurrently and then the Broadcaster, validates in code, allows one repair, and otherwise falls back deterministically.

- Outcomes: timeouts, 429s and 5xx responses use `retry_wait` with bounded backoff while attempts remain, and the fallback on the last attempt.
- Insights are created only if absent (`insight_id = moment_id`) in a local `SqliteInsightStore`. Jobs complete as `ready` (AI) or `fallback`.
- The model client (`AzureOpenAIClient`) uses Entra ID only. With no endpoint configured, the worker runs explicitly fallback-only.

Verification: 10 new tests (97 in total) against the bridge's `SqliteStore` and a scripted fake model, with no tokens. They cover:
- valid AI output becoming `ready`, with metrics copied from evidence;
- one successful repair;
- invalid output after repair becoming a fallback with a stated reason;
- timeout → `retry_wait` → fallback on attempt 2;
- `Retry-After` honoured;
- a non-transient error and fallback-only mode;
- two concurrent workers handling 12 jobs exactly once;
- a duplicate claim after lease expiry publishing one insight;
- budget-versus-lease validation;
- every detected rule's fallback being schema-valid.

Changing create-if-absent to overwrite made the duplicate-claim test fail, as intended. The CLI started in fallback-only mode against an empty store.

Not done:
- No live model call: `Microsoft.CognitiveServices` is not registered on Azure for Students, so quota is unknown. `gpt-4o-mini` and `gpt-4.1-mini` are offered in eastus. Nothing has been created.
- No run against the 24 live jobs (they are in the UF bridge store).
- No Cosmos client: where the store lives and how cross-tenant access works is still to be agreed with the bridge owner.
- Evidence actors beyond the moment's player are not on bridge moments, so the validator rejects other player names (stricter).

**Cosmos DB store, 2026-10-16.** Resources, each approved by the owner, in UF Azure for Students (the policy allows only westus, germanywestcentral, francecentral, norwayeast and denmarkeast):

- registered `Microsoft.DocumentDB`;
- resource group `rg-omnipitch-uf` (West US);
- account `omnipitch-cosmos-d5e1ec`: **free tier**, single region West US, Session consistency, local periodic backup;
- database `omnipitch` with **shared 1000 RU/s** (the free-tier allowance), containers `moments` and `jobs` (`/run_id`) and `cursors` (`/cursor_id`).

Access is Entra ID only, for the owner: built-in Data Contributor scoped to `/dbs/omnipitch`, plus a custom `OmniPitch Metadata Reader` role (only `readMetadata`) at the account root. Cross-partition queries need that root role; a database-scoped role alone returned 403. `CosmosStore` implements the same methods as `SqliteStore`, with create-if-absent (409) and ETag-conditional replace (412 → stale); both stores share one set of job-transition functions. The worker takes `--store cosmos` and runs the recovery pass every cycle.

Verification: the bridge tests run against both stores, 19 passed (9 against live Cosmos, opt-in with `OMNIPITCH_TEST_COSMOS_ENDPOINT`; each test uses its own run ID and purges its records). The first live attempt exposed a missing `close()` on the sync Cosmos client; it was fixed. Live: `run_bridge.py --store cosmos --once` on `smoke-20261016-a` created 24 moments and 24 `pending` jobs, all schema-valid and covering all five rules. A second process created 0, and the cursor persisted in Cosmos. The containers then held exactly 24 moments, 24 jobs and 1 cursor.

Cross-tenant access decided 2026-10-16: UF blocks guest accounts, so the narration worker uses the Cosmos secondary key, shared privately; the `insights` container (`/run_id`) was created for it. Not done: a Cosmos client for the narration worker (it uses the bridge's `SqliteStore` today, and `CosmosStore` has the same methods); deployment of the bridge.

**Narration on Cosmos DB and a live model, 2026-10-16 (branch `phase3-narration-cosmos`, not merged).** The narration worker can use Tanmayee's Cosmos DB (UF tenant, West US, free tier) through `--store cosmos`.

- **Insights:** a new `CosmosInsightStore` (container `insights`, `/run_id`, `create_item` only, 409 → no overwrite).
- **Auth:** an account key held only in the developer's local `.env`, because UF blocks guest accounts.
- **Run scope:** `--run-id` scopes claims to one run (`RunScopedStore`), because the store's `claim_next` is global.
- **No model:** `--fallback-only` forces deterministic narration.

Verification:

- **Offline:** 101 passed, 13 skipped (opt-in live tests).
- **Live Cosmos tests:** with `OMNIPITCH_TEST_COSMOS_ENDPOINT` and `COSMOS_KEY` set, `test_narration_cosmos.py` plus `test_bridge.py` gave **23 passed**:
  - fallback drain plus restart;
  - the AI-ready path with a fake model;
  - two concurrent workers;
  - a lease-expiry duplicate;
  - the Cosmos-backed bridge tests.
- **Incident during that run:** `test_bridge.py::test_retry_wait_is_claimable_after_its_delay` calls the global `claim_next` in a loop. On the shared account it claimed all 24 real `smoke-20261016-a` jobs (`worker-b`, attempt 1, test clock 03:00). Its cleanup purges only its own run. The 24 jobs were restored to `pending`/attempt 0 with ETag-conditional writes, touching only jobs with that exact fingerprint. No insights were written and nothing was deleted. **Do not run the Cosmos-backed bridge tests against a shared database until they scope claims to their own run.**
- **Dry run (fallback-only, two workers started together, then a restart) on `smoke-20261016-a`:**
  - workers A and B each processed 12;
  - the restart processed 0;
  - Cosmos afterwards: 24 jobs `fallback` (attempt 1, each pointing to its own insight) and 24 insights `fallback`;
  - 24 distinct IDs; 24 of 24 pass the insight schema and the code validator.

**Model, 2026-10-16** (Azure for Students, East US, `rg-omnipitch-dev`):

- `Microsoft.CognitiveServices` registered.
- Quota: `gpt-4o-mini` is 0 in eastus; `gpt4.1-mini` GlobalStandard is 200K TPM.
- Created `omnipitch-aoai-gvoh7` (Azure OpenAI S0, `disableLocalAuth=true`) with deployment `gpt-41-mini` (`gpt-4.1-mini` 2025-04-14, GlobalStandard, capacity 10 = 10K TPM cap).
- The developer has "Cognitive Services OpenAI User". A live Entra ID call succeeded.

Read-only probe (no writes) on three real moments:

- **prompts-v1:** 3 of 3 rejected even after repair. The model put evidence-ID digits (`0340`) and self-computed times (`48.583`) in prose; the prompt told it to "cite evidence IDs" while the validator rejected their digits.
- **Fix:**
  - The validator now ignores only this moment's own evidence IDs in prose; an unknown ID is an error.
  - The prompt (`prompts-v2`) supplies a clock label instead of milliseconds and forbids computed numbers.
  - Two tests were added.
- **prompts-v2:** 2 of 3 valid AI (goal, transition). The threat-gain moment was still rejected for an ID-like `0012`, which would fall back with the reason recorded.

Not done: the joint Phase 3 gate on a fresh run. `gate-20261016-a` (400 + 25 events) was published from Event Hubs, but no bridge jobs appeared within 7.5 minutes, so the bridge must be run on the Eventhouse side. `services/api/tests/phase3_gate.py` covers live AI, forced failure, restart and one-insight-per-moment, and currently reports `bridge_jobs` UNVERIFIED.

**Bridge follow-up, 2026-10-20 (branch `fix/bridge-test-isolation`).**

- The bridge (`--store cosmos --once`) processed `gate-20261016-a`: 400 rows, 0 rejected, 24 moments and 24 `pending` jobs (12 threat gain, 8 transition, 2 chance, 1 goal, 1 pressing change). `smoke-20261016-a` created 0.
- Fixed the shared-account incident: `claim_next` and `expire_exhausted` take an optional `run_id` (`SqliteStore`, and `CosmosStore` with one partition). The bridge tests pass it, and a new test checks that another run's jobs stay `pending`.
- Verification: 102 passed offline. 21 passed against live Cosmos, and the real `smoke` jobs were byte-identical before and after.
- During that window, the narration owner's gate script processed the 24 gate jobs (workers `gate-ai`, `gate-fallback`, `gate-forced-failure`): 3 `ready` (AI) and 21 `fallback`, each attempt 1, 24 insights. Some errors read `model error: analyst: HTTP 404`. The gate result is recorded by the narration owner.
- `agents/scoped.py` can be removed in favour of `run_id`; that is the narration owner's change.

**Phase 3 gate, 2026-10-20 (merged to `main` via PR #10). All checks passed.** Independently re-checked read-only in Cosmos on 2026-10-20: `gate-20261020-b` has 24 jobs on attempt 1 (3 `ready`, 21 `fallback`) and 24 insights (3 ai, 21 fallback), exactly one per moment, with every job linked to its own insight. The fallback reasons are 1 forced-failure 404 and 20 "gate cost cap".

- **The `HTTP 404` on `gate-20261016-a`** (read-only diagnosis):
  - The 24 jobs map to three gate workers: `gate-ai` 3 `ready`/ai; `gate-forced-failure` 1 fallback with the only 404; `gate-fallback` 20 fallback.
  - The 404 was the gate's deliberate forced failure: a deployment named `deployment-that-does-not-exist`.
  - Every call to the real deployment succeeded, and a fresh test call today returned correctly.
  - The configuration is correct: `omnipitch-aoai-gvoh7` / `gpt-41-mini` / `2024-10-21`.
  - The real problem was labelling. A model error didn't record the deployment, and the cost-capped drain said "no model configured".
- **Fix:**
  - Model errors now record the client/deployment in the job error and the insight trace.
  - The gate's no-model drain is labelled "gate cost cap: remaining jobs narrated without the model".
  - `agents/scoped.py` was removed. The worker calls `claim_next(..., run_id=...)`, and its `recover()` expires only its own run's abandoned jobs; unscoped workers leave recovery to the bridge's global pass.
  - Every live Cosmos test passes `run_id`.
- **Tests:**
  - 103 passed offline.
  - 25 passed against live Cosmos (narration and bridge).
  - The real runs `smoke-20261016-a` and `gate-20261016-a` had byte-identical job and insight snapshots before and after.
- **Gate on a fresh run `gate-20261020-b`** (400 + 25 duplicates via Event Hubs → Eventstream → Eventhouse; bridge by Tanmayee; `phase3_gate.py` at 22:45):
  - **bridge:** 24 moments (12 threat gain, 8 transition, 2 chance, 1 goal, 1 pressing change), 24 jobs;
  - **live AI:** 3 of 3 model-narrated jobs `ready`/ai (goal, chance, chance);
  - **forced failure:** 1 `fallback`, reason `model error (azure-openai:deployment-that-does-not-exist): analyst: HTTP 404 DeploymentNotFound`;
  - **cost-capped drain:** 20 `fallback`;
  - **restart:** processed 0;
  - **final:** 24 insights (3 ai, 21 fallback), 24 distinct, 0 invalid against the schema and validator; all jobs on attempt 1.
  - Report: `data/generated/phase3-gate-gate-20261020-b.json`.
- **Known limitation, which the gate does not check:** the validator catches unsupported numbers, names and IDs but not unsupported meaning. On both gate runs the AI text claimed:
  - "the save kept the score level" (Vale already led 1-0 at 25');
  - "outside the box" for a 16.2 m shot (the box is 16.5 m deep);
  - a "three-pass move" for 3 possession actions;
  - "broke through/penetrated Harbor's defense" on the first run.

  Phase 4 work: add the score and inside-box facts to the evidence packet, ban defender-breach phrasing, and tighten the prompt rules.

- [x] Bridge worker with durable cursor, lookback, stable moment IDs and conditional moment/job records in Cosmos DB (verified live 2026-10-16; not deployed).
- [x] Phase 3 gate (joint): a live moment becomes one validated insight, with no duplicates on restart and a fallback on model failure (passed 2026-10-20 on `gate-20261020-b`; semantic accuracy of AI prose is not covered by the validator, see above).
- [x] Define evidence bundles and validated narrative output boundaries (`agents.prompts.evidence_packet`, `agents.validation`, 34-case eval set).
- [ ] Integrate Microsoft Agent Framework/Foundry only when access and scope permit.
- [x] Grounded explanations, honest limitations and fixture/AI/fallback modes: implemented and verified with a live `gpt-4.1-mini` deployment (Entra ID). Semantic checks for the score state, the box, pass counts, defenders and transition direction were added in Phase 4 (`agents/semantics.py`, 2026-10-20).

## Phase 4 — highlights, recap, bilingual text and preferences

- [x] Evidence-linked key-moment highlights and halftime/full-time recaps (2026-10-20, local; branch `phase4-experience`). Recaps use only revealed events and verified moments: up to three key moments (strongest, one per possession, in match order) that seek the replay, a tactical trend only with at least two valid PPDA windows per team, a player focus from recorded events, provisional until the period ends.
- [x] Validated Cosmos insights in the UI (2026-10-20, local, tested with a fake insight source): `OMNIPITCH_INSIGHTS=cosmos` overlays each stored insight only if it re-validates against the API's moment; status (narrated, AI, rejected, error) is in every snapshot and on Data quality. Not yet shown with a live prompts-v3 run.
- [x] Reconnect restores score, clock and insights, and fan/analyst views read one insight per moment (tested 2026-10-20 in `test_phase4.py`).
- [ ] Bilingual text with validation.
- [x] Tactical explanations supported by available evidence; no invented tracking (meaning checks in code, 2026-10-20).

Verification 2026-10-20 (local): 120 Python tests passed, 14 cloud tests skipped (7 new in `services/api/tests/test_phase4.py`: overlay valid/rejected/error/version, recap scopes and key-moment links, AI recap validation and fallback, recap endpoint, reconnect, shared facts); `npm run test:contracts` (now with the recap fixture), `test:pitch`, typecheck, build and `test:replay:browser` (headless Chrome, ports 8011/5214) passed. Browser check in the desktop app's built-in browser at 1280 and 375 px: half-time prompt appears at the break and opens the first-half recap; a recap key moment seeks to 24:30 for a 25' goal; no horizontal overflow on mobile; no console errors after removing the pre-kickoff recap requests. Found and fixed during the check: the recap fetch was starved by a debounce at 10× speed, the panel jumped to a provisional full-time recap at the break (the second half's `period_start` shares the break's replay time), and the footer still said AI narration was not connected. Not verified: the smooth scroll to the recap (the pane did not render frames while hidden), Safari/Firefox, a live prompts-v3 run through the overlay.

**Phase 4 data half, 2026-10-20 (branch `phase4-bridge`, not merged).**

- **Period-end reconciliation** (bridge): one create-only record per run and period, missing moments and jobs created create-only, mismatches reported, frozen evidence never overwritten.
  - 6 new tests on a full 1,206-event match: one valid record per period; reruns and reconcile create nothing and never rewrite; a late event before `period_end` delays reconciliation; duplicates don't change the counts; a restart mid-reconciliation completes without duplicates; evidence_differs and unexpected_stored are reported and the stored moment kept.
  - Mutation check: counting every expected moment as "created" fails 2 tests.
  - Live Cosmos (container `reconciliations` provisioned 2026-10-20 with approval):
    - The first full run was 30 passed, 1 failed. The restart test reported every period as `mismatch`, because Cosmos returns `16.0` as `16` and the stored-vs-redetected comparison was textual.
    - Fixed by comparing number values, with a regression test. The rerun of the reconciliation tests passed 11 of 11, Cosmos variants included.
    - The real runs (`gate-20261016-a`, `gate-20261020-b`, `smoke-20261016-a`) were byte-identical before and after.
    - **Not verified on a real full-match run:** none has been published yet, because 400-event runs contain no `period_end`.
- **Latency and cost tracing:** `trace_report.py` plus 5 unit tests. Read-only on `gate-20261020-b`:
  - 24 moments, 24 jobs, 24 insights;
  - `ingest_to_detect` p50 593 s: the bridge was run by hand about 10 minutes after ingestion, so this is not pipeline latency;
  - `detect_to_job` 0 s;
  - `job_to_insight` p50 119 s, p95 128 s: it includes the wait before the gate script ran;
  - 9 model calls (3 AI insights x 3 roles), each role p50 3.2-4.3 s;
  - tokens not recorded by the narration trace;
  - `emit_to_ingest` not measurable (fixture clock);
  - publication not built.
- **Push contract proposed:** `push.schema.json` plus an example (the real goal moment of `gate-20261020-b`) and 2 tests. Awaiting the frontend owner's agreement.
- **Web PubSub (approved 2026-10-20):**
  - Registered `Microsoft.SignalRService`.
  - Created `omnipitch-wps-670966`: West US, Free_F1, local auth disabled.
  - Assigned *Web PubSub Service Owner* to the owner, on that resource only.
  - Entra-only check: a client token for a run group (200) and a send to that group (202).
  - The publisher and negotiation endpoint are not built.
- Totals: 133 Python tests passed, 19 cloud tests skipped (opt-in). `npm run test:contracts` passes.
- **Not done:**
  - Negotiation endpoint and outbox publisher (waiting on the push contract being agreed).
  - Live reconciliation on a full match.
  - Measured pipeline latency with the bridge polling continuously.
  - The joint Phase 4 gate.

**Phase 4 frontend push client and PR #14 answers, 2026-10-20 (Akash, branch `phase4-push-client`).**

- **Push contract agreed** with two clarifications to its description (no schema change):
  - Only `state` messages are ordered by `state_version`. `moment`, `insight` and `period_reconciled` messages are deduplicated by `message_id` only, because they are published after the state has moved on (the moment example has version 340 after state 400).
  - No gap rule is needed. Every accepted message and every (re)connect makes the browser fetch a snapshot, and the snapshot API stays authoritative.
- **Browser client** (`apps/web/src/lib/push.ts`):
  - Negotiates `GET /api/v1/negotiate?run_id=<source_run_id>` and opens `json.webpubsub.azure.v1`.
  - Handles group messages: drops duplicate, stale, foreign-run and invalid ones, and validates each envelope against `push.schema.json` with AJV.
  - A `state` or `moment` message triggers an incremental snapshot; `insight`, `period_reconciled` or a (re)connect triggers a full one.
  - Reconnects with backoff and a fresh token.
  - A 404/503 from negotiate means "not configured": polling only, no retries.
  - Data quality shows the push status.
- **Verification:**
  - `npm run test:push` drives the real module with a fake socket and the contract examples. A mutation that orders every type by `state_version` fails it.
  - `test:contracts` now validates the push examples. Typecheck and build passed.
  - Browser, with the API's negotiate endpoint not built yet: one 404, then "Not configured; polling only", no retries, and the narrated insights still shown.
  - **UNVERIFIED** until the negotiate endpoint exists: the real Web PubSub socket.
- **Token usage per role** in the insight trace (`trace[role].usage`, read by `trace_report`), tested with a fake HTTP client. It applies to runs narrated after this change.
- **Full match published for the joint gate:** `gate-20261020-d` (seed 7, standard, 1,206 events + 25 duplicates, `period_end` at 618 and 1206). Sent to Event Hubs by the publisher; Eventhouse arrival is not checked from this machine.
- 144 Python tests passed, 19 skipped.

## Phase 5 — dataset export and basic Producer Mode

- [ ] Export reusable synthetic datasets with provenance and schema version.
- [ ] Basic producer selection and recap tools.

## Phase 6 — cloud integration, reliability and submission polish

- [ ] Connect Event Hubs, Fabric Eventstream/Eventhouse and bridge worker.
- [ ] Add Cosmos persistence, grounded retrieval and Web PubSub delivery.
- [ ] Verify recovery, idempotence, latency and evaluation with recorded results.
- [ ] Prepare demo/submission assets and reproducible instructions.

## Stretch

- [ ] Simple 3D replay after the 2D path is reliable.
