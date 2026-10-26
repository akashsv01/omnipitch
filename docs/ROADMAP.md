# Roadmap

Phases describe intended work, not committed completion dates. Implement only the assigned task.

## Current state

**Phase 5 complete (2026-10-25); Phase 6 next.** The deployed candidate runs the latest `main` with the default judge run, HTTP health probes and a budget alert. All gate tests pass: duplicates, late events, outages (including the bridge's store outage), reconnect, quiet runs and measured latency (`latency-20261025-a`). Scope is frozen: bug fixes only. Phase 6 in progress: fresh-clone check, live smoke test and judge runbook done (2026-10-25); cross-browser checks, video, release tag and submission remain.

**Phase 4 complete (2026-10-21).** The joint gate passed on the full match `gate-20261020-d` through the real pipeline: simulator → Event Hubs → Eventhouse → bridge (moments, jobs, both period reconciliations) → narration (prompts v3, checked in code) → validated Cosmos insights in the UI → Web PubSub push → reconnect. Reconnect restores score, clock and insights (API restart and tab reopen); the halftime and full-time recaps are final, link to verified moments and show "Reconciled" from the bridge's records; fan and analyst views read one checked insight per moment. Details: Phase 4 below. Next: deployment for judges (Phase 6 work brought forward), then Phase 5 polish. Earlier Phase 4 note: Implemented and tested locally: meaning checks in code (score state, box position, pass counts, defender breach, transition direction, fan text that mentions missing data) with prompts v3 and derived facts in the evidence packet; a validated overlay that shows the narration worker's Cosmos insights in the UI (`OMNIPITCH_INSIGHTS=cosmos`), re-checking each one against the API's own moment and reporting its status; halftime/full-time recaps (`GET /api/v1/replay/recap`, contract `recap.schema.json`) built from verified moments, with an optional checked AI rewrite (`OMNIPITCH_RECAP_AI=on`); a Recap tab whose key moments seek the replay; a half-time/full-time prompt; AI/Template labels on every moment. Live check 2026-10-20 (`services/api/tests/phase4_live.py --run-id p4-live-20261020-a --seed-local --ai-jobs 6`): 55 moments and jobs created in Cosmos with the bridge's detector (Eventhouse hop UNVERIFIED for this run), 6 of 6 model-narrated jobs (prompts v3, `gpt-4.1-mini`) published validated AI insights, 49 fallback; the API overlay showed all 55 with 0 rejected, both recaps linked verified moments, and a restarted API restored score, clock and insights. Reading the six AI texts found one meaning error the checks missed ("keep the score intact" on a chance); the score-state rule was extended, and the overlay now rejects that stored insight on display (54 narrated, 5 AI, 1 rejected, seen in the browser after an API restart that restored the run). The same live check exposed an API defect the tests missed: with `OMNIPITCH_INSIGHTS=cosmos` every request returned 500 because `services/bridge` (the shared Cosmos client) was not on the API's import path; fixed, and a failed insight source is now reported in the snapshot instead of failing requests. Not yet done: the joint run through Eventhouse and Tanmayee's bridge, bilingual text, deployment.

**Current phase (2026-10-20): Phase 3 complete; Phase 4 next.** Phases 1–3 are implemented and verified. Phase 2: the cloud path simulator → Event Hubs → Fabric Eventstream → Eventhouse → API → browser was verified on `smoke-20261016-a`. Phase 3: the bridge worker writes moments and jobs to Cosmos DB, and the narration worker (live `gpt-4.1-mini`, Entra ID) turns each into exactly one validated insight with a labelled fallback; the joint gate passed on `gate-20261020-b`. Everything runs locally against the cloud services; nothing is deployed yet. Earlier summary of the local scope (2026-10-14): Phase 1 and the local scope of Phase 2 are implemented and verified (2026-10-14). That covers a seeded state-machine simulator with scenarios; replay with speed, seek and generate; contracts v1.1; a SQLite event ledger with deduplication and restart recovery; deterministic metrics (progression, illustrative threat, windowed PPDA with sample gates); five moment rules with frozen evidence; prepared agent prompts with a validator, fallback narrator and evaluation set; and a redesigned, motion-rich match room with an evidence drawer and fan/analyst modes. Cloud status is in the Phase 2 table below: the Event Hubs → Fabric Eventhouse path is verified end to end. No model is called; every insight is `generation_mode: fallback`.

**Phase 2 status (2026-10-16): complete.** Run `smoke-20261016-a` (seed 7, standard, 400 events + 25 deliberate duplicates) travelled simulator → Event Hubs (the Event Hubs owner's tenant) → Fabric Eventstream → Eventhouse (the Fabric owner's tenant) → azure-mode API → browser. Fabric names (not secrets): workspace `OmniPitch` on the Fabric trial capacity (East US), Eventhouse `omnipitch`, KQL database `omnipitch`, table `OmniPitchEvents`, Eventstream `omnipitch-stream`. The send stage was confirmed by the publisher (Akash: 400 sent, 25 re-delivered) and is consistent with the 425 rows / 400 unique IDs ingested; the Fabric-side smoke run reports it UNVERIFIED because `--skip-publish` cannot see the sender.

| Stage | Status | Evidence or blocker |
| --- | --- | --- |
| Simulator → Event Hubs | Verified (2026-10-15; this run confirmed by the publisher 2026-10-16) | `simulator.publish` with Entra ID. For `smoke-20261016-a` the publisher reported 400 sent + 25 re-delivered; `cloud_smoke.py --skip-publish` reports `event_hubs_send` UNVERIFIED by design on the Fabric side. |
| Event Hubs → Eventstream → Eventhouse | Verified (2026-10-16) | Eventstream `omnipitch-stream` (source `azure-event-hub`, consumer group `fabric-eventstream`, listen-only SAS) → destination `omnipitch-eventhouse`, direct ingestion into the existing table and existing mapping `OmniPitchEvents_json`. Source and destination Active. |
| Event IDs queryable in Eventhouse | Verified (2026-10-16) | `smoke-20261016-a`: 425 rows, 400 unique `event_id`, max sequence 400, ingested 03:01:15 UTC; `.show ingestion failures` empty. |
| API reads Eventhouse | Verified (2026-10-16) | `/ready` → `ready`, mode `azure`; `cloud_smoke.py` stage `api_reads_eventhouse` PASS (source `eventhouse`, 400 events). |
| Browser shows the cloud run | Verified (2026-10-16) | Top bar `Azure · Eventhouse`; dock `Eventhouse run smoke-20261016-a`; Data quality → Fabric Eventhouse: 425 / 400 / 25 and 12 of 12 parity rows `match`; no console errors. |
| Dedup, fixture calculations, sparse windows | Verified on cloud data (2026-10-16) | `cloud_smoke.py`: `dedup_and_contract`, `metrics_parity`, `ppda_and_sparse_windows` PASS. |

2026-10-16 cloud verification (Fabric trial, East US; API and web app local). `cloud_smoke.py --run-id smoke-20261016-a --skip-publish --api http://localhost:8000`, run twice on 2026-10-16 (second run 03:11 UTC) with identical results: `event_hubs_send` UNVERIFIED (skipped; publisher machine); `eventhouse_query` PASS (425 rows, 400 unique); `dedup_and_contract` PASS (25 duplicate rows collapsed; payloads identical to the seeded fixture); `metrics_parity` PASS (counts and progression KQL vs Python, threat Eventhouse vs fixture); `ppda_and_sparse_windows` PASS (windows: 5 ok, 5 insufficient sample, 2 without defensive actions; 1 pressing claim, none from a sparse window); `api_reads_eventhouse` PASS; `browser_display` checked in a browser (Data quality → Fabric Eventhouse → Load run `smoke-20261016-a`: `Azure · Eventhouse`, dock `Eventhouse run smoke-20261016-a`, 12 of 12 parity rows `match`, no console errors). The report is `data/generated/cloud-smoke-smoke-20261016-a.json` (gitignored, not committed). The first live calls exposed three defects that the fake-reader tests could not: the Kusto server timeout was passed as a string (`/ready` returned 502); the browser aborted Eventhouse requests after 8 s (live run detail takes about 6 s); and card CSS enlarged icons. All three are fixed, along with a test fixture that let a developer's azure `.env` leak into tests. After the fixes: 77 Python tests, frontend contract and pitch checks and the production build passed. Not tested: Safari/Firefox, a deployed (non-local) API, latency percentiles.

Fabric setup notes: in the Eventhouse destination wizard, "Use existing mapping" lists `OmniPitchEvents_json` only after a data sample has loaded, and until then it offers an auto-generated `OmniPitchEvents_mapping`, which must not be used. The KQL database's internal ID differs from its display name; `EVENTHOUSE_DATABASE=omnipitch` works. A listen key was pasted into a chat during setup; rotating it (`az eventhubs eventhub authorization-rule keys renew ... --key PrimaryKey`) and updating the Fabric connection was recommended.

Resources created on 2026-10-15 in the Azure subscription (Owner), then **deleted the same day (00:31 UTC) at the owner's request**. Total usage was about 30 minutes of 1 TU; afterwards the subscription has 0 resources. `infra/eventhubs.ps1` recreates the same names. The owner recreated the namespace on 2026-10-16 with the same names (the Eventstream preview showed probe run `probe-20261016-0203-recreate`); it exists again. What existed: provider `Microsoft.EventHub` registered; the resource group (East US); a Standard namespace (1 TU); hub `match-events`; consumer group `fabric-eventstream`; `Azure Event Hubs Data Sender` for the developer at hub scope; listen-only SAS rule `eventstream-listen`. No Fabric capacity was purchased. Verification on 2026-10-15: 77 Python tests passed, frontend contract and pitch checks and the build passed, and `cloud_smoke.py` reported Event Hubs PASS and the Eventhouse stage UNVERIFIED (not configured).

Next tasks, in order (2026-10-20; submission due 2026-10-27, 11:59 PM PT):

1. Phase 4: show validated insights and moments live in the UI from Cosmos (fan/analyst views and evidence), add halftime/full-time recaps linked to verified moments, and close the semantic gaps found at the gate (score state and inside-box facts in the evidence packet; no defender-breach phrasing). Implemented on `phase4-experience` (see Phase 4 below); remaining: a fresh live run (publish → bridge → narrate with prompts v3) shown through the overlay.
2. Deployment for judges, the largest open risk: the API, bridge and narration worker run on laptops today, and judges need a working URL until 2026-11-10.
3. Housekeeping: rotate the Event Hubs listen key that was exposed during setup and update the Fabric connection; decide whether to keep the Event Hubs namespace.

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

**Bridge, 2026-10-16 (merged to `main` as 479e3fa via PR #4).** `services/bridge/` polls Eventhouse for runs ingested after a durable cursor minus a 2-minute lookback (`analytics/kql/runs_since.kql`), re-reads each touched run deduplicated, validates rows, analyses only the gap-free prefix with the shared detector, and creates moment and job records only if absent. The cursor advances only after all touched runs are written, and a periodic reconcile re-reads recent runs regardless of the cursor. Records go to a local SQLite store (`data/generated/bridge.sqlite3`) whose interface is meant to be implemented by a Cosmos DB store. Jobs have conditional, version-checked claim and complete, lease expiry, `retry_wait`, and at most 2 attempts; an abandoned last attempt becomes `failed`. Verification: 10 new tests (87 in total) cover the job contract, one pending job per moment, 25 duplicates plus reprocessing creating nothing, restart from the persisted cursor, a late out-of-order event delaying moments without changing frozen evidence, the lookback, a failed cycle keeping the cursor, invalid rows, and lease, claim, complete and retry behaviour. Replacing create-only-if-absent with overwrite made the duplicate test fail, as intended. Live, against the Eventhouse: the first cycle read `smoke-20261016-a` (400 rows after dedup, 0 rejected) and created 24 moments and 24 pending jobs, matching local detection on the seeded fixture; a second process restart created 0. Not done: the Cosmos DB store (no Cosmos account existed yet), deployment, and the narration worker that claims jobs.

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
- No live model call: `Microsoft.CognitiveServices` is not registered on the Azure subscription, so quota is unknown. `gpt-4o-mini` and `gpt-4.1-mini` are offered in eastus. Nothing has been created.
- No run against the 24 live jobs (they are in the bridge's store).
- No Cosmos client: where the store lives and how cross-tenant access works is still to be agreed with the bridge owner.
- Evidence actors beyond the moment's player are not on bridge moments, so the validator rejects other player names (stricter).

**Cosmos DB store, 2026-10-16.** Resources, each approved by the owner, in the Fabric owner's Azure subscription (the policy allows only westus, germanywestcentral, francecentral, norwayeast and denmarkeast):

- registered `Microsoft.DocumentDB`;
- resource group the resource group (West US);
- a Cosmos DB account: single region, Session consistency, local periodic backup;
- database `omnipitch` with **shared 1000 RU/s** (the free-tier allowance), containers `moments` and `jobs` (`/run_id`) and `cursors` (`/cursor_id`).

Access is Entra ID only, for the owner: built-in Data Contributor scoped to `/dbs/omnipitch`, plus a custom `OmniPitch Metadata Reader` role (only `readMetadata`) at the account root. Cross-partition queries need that root role; a database-scoped role alone returned 403. `CosmosStore` implements the same methods as `SqliteStore`, with create-if-absent (409) and ETag-conditional replace (412 → stale); both stores share one set of job-transition functions. The worker takes `--store cosmos` and runs the recovery pass every cycle.

Verification: the bridge tests run against both stores, 19 passed (9 against live Cosmos, opt-in with `OMNIPITCH_TEST_COSMOS_ENDPOINT`; each test uses its own run ID and purges its records). The first live attempt exposed a missing `close()` on the sync Cosmos client; it was fixed. Live: `run_bridge.py --store cosmos --once` on `smoke-20261016-a` created 24 moments and 24 `pending` jobs, all schema-valid and covering all five rules. A second process created 0, and the cursor persisted in Cosmos. The containers then held exactly 24 moments, 24 jobs and 1 cursor.

Cross-tenant access decided 2026-10-16: guest accounts aren't allowed in the Cosmos owner's tenant, so the narration worker uses the Cosmos secondary key, shared privately; the `insights` container (`/run_id`) was created for it. Not done: a Cosmos client for the narration worker (it uses the bridge's `SqliteStore` today, and `CosmosStore` has the same methods); deployment of the bridge.

**Narration on Cosmos DB and a live model, 2026-10-16 (branch `phase3-narration-cosmos`, not merged).** The narration worker can use Tanmayee's Cosmos DB (in the Fabric owner's tenant) through `--store cosmos`.

- **Insights:** a new `CosmosInsightStore` (container `insights`, `/run_id`, `create_item` only, 409 → no overwrite).
- **Auth:** an account key held only in the developer's local `.env`, because the Cosmos owner's tenant doesn't allow guest accounts.
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

**Model, 2026-10-16** (the Azure subscription, East US, the resource group):

- `Microsoft.CognitiveServices` registered.
- Quota: `gpt-4o-mini` is 0 in eastus; `gpt4.1-mini` GlobalStandard is 200K TPM.
- Created the Azure OpenAI resource (Azure OpenAI S0, `disableLocalAuth=true`) with deployment `gpt-41-mini` (`gpt-4.1-mini` 2025-04-14, GlobalStandard, capacity 10 = 10K TPM cap).
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
  - The configuration is correct: the Azure OpenAI resource / `gpt-41-mini` / `2024-10-21`.
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
- [ ] Bilingual text with validation. Moved to Phase 5: the project guide allows a second language only after the MVP gates pass.
- [x] Web PubSub live updates: negotiate endpoint, durable outbox publisher (Tanmayee, PR #16) and browser push client (Akash, PR #15); verified live 2026-10-21 (PR #17).
- [x] Period-end reconciliation shown in recaps: the API reads the bridge's `reconciliations` records read-only (agreed 2026-10-21) and labels a recap "Reconciled" only when the record covers the same events; verified live on `gate-20261020-d` (P1 through 618, P2 through 1206, 0 mismatches).
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
  - Created the Web PubSub resource: West US, Free_F1, local auth disabled.
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

**Phase 4 publish and live reconciliation, 2026-10-21 (Tanmayee, branch `phase4-publish`).**

- **Live period-end reconciliation: VERIFIED** on the full match `gate-20261020-d`:
  - Eventhouse: 1,231 rows, 1,206 unique, sequences 1–1206.
  - `run_bridge.py --store cosmos --once` created 55 moments and 55 `pending` jobs.
  - Period 1: through 618, 618 events, 29 expected and created, `reconciled`.
  - Period 2: through 1206, 588 events, 26 expected and created, `reconciled`.
  - Both records are schema-valid. A second run created 0 and reconciled nothing again.
  - That cycle cost 1,813.9 RU, and an idle rerun 220 RU, mostly 409s from create-only writes. Worth optimising if a continuous bridge strains the 1000 RU/s budget.
- **Negotiate endpoint and outbox publisher: implemented; live push VERIFIED for state, moment and period messages (2026-10-21).**
  - Live setup: Cosmos container `outbox` provisioned with approval; an API on port 8010 with `WEBPUBSUB_ENDPOINT`; a Node listener using the browser's subprotocol `json.webpubsub.azure.v1`.
  - Negotiate returned 200 and a `wss://` URL for group `run-gate-20261020-d`; the real socket opened and connected.
  - `run_bridge.py --store cosmos --once --push --reconcile-every 1` sent 58 messages for the run (1 state at version 1206, 55 moments, 2 period_reconciled) with 0 failures. The listener received exactly those 58: 58 distinct IDs, only its own group, `state` first.
  - The same pass sent 75 messages for three older runs to their own groups; none reached this socket.
  - A rerun published 0. `trace_report.py` counted 58 Web PubSub messages.
  - **Insight messages: not verified live.** `gate-20261020-d` had no insights yet; they appear once the narration worker runs (joint gate).
  - Fixed during the live check: a reconcile pass enqueued messages but sent them only on the next cycle. It now publishes in the same pass (test added).
  - 8 new tests with a fake publisher and a fake Web PubSub client cover: valid envelopes; state first; 55 moments and 2 period messages for the full match; state versions growing with the prefix (300 → 700); reruns and duplicates publishing nothing new; a failed send retried with the same `message_id`; a restart between send and mark resending once and counting once; one insight message after a job completes; and negotiate 503/200/422.
  - Mutation check: never marking `sent` fails 6 of the 8.
  - Live push needs the Cosmos `outbox` container (awaiting approval) and an API started with `WEBPUBSUB_ENDPOINT`.
- `trace_report.py` now reads publication times and counts from the outbox.
- 153 Python tests passed, 19 skipped (opt-in cloud).
- **Not done:**
  - Live insight messages.
  - The browser UI against the live socket (Akash).
  - The joint gate with reconnect. Akash's `phase4_live.py` can now run against the 55 `pending` jobs of `gate-20261020-d`.

**Phase 4 joint gate: live push and reconnect on `gate-20261020-d`, 2026-10-21 (run on Tanmayee's machine, the identity with the Web PubSub role).**

Setup:
- An API on port 8000 in azure mode with `OMNIPITCH_INSIGHTS=cosmos` and `WEBPUBSUB_ENDPOINT` (local `.env`, Entra ID).
- The UI on Vite :5173 in the in-app browser.
- The run loaded from Data quality → Fabric Eventhouse, then seeked to full time through the replay control API.
- Merged `main` code (`be58569`).
- No token or client URL was printed, logged or captured; the page HTML contained no `access_token`.

| Check | Result | Evidence |
| --- | --- | --- |
| Negotiate | **PASS** | `GET /api/v1/negotiate?run_id=gate-20261020-d` returned 200, group `run-gate-20261020-d`, a `wss://` URL and `expires_at`. |
| UI live | **PASS** | Live updates `Live` (Web PubSub, run `gate-20261020-d`); Narrated insights 55 from Cosmos, 5 AI-written, 0 rejected; AI cards on the goals at 25', 58', 69' and the chances at 26', 27'; scoreboard 2-1 at full time (90:00 +2). |
| Insight messages | **PASS** | With the UI open, one `run_bridge.py --store cosmos --push --once` cycle sent 55 and failed 0. The outbox for the run holds 55 insight messages, all `sent`, with no failed attempts and 55 distinct IDs (113 in total: 1 state, 55 moment, 2 period_reconciled, 55 insight). The UI showed 55 messages used, 0 ignored, last `insight`, and its counts and score stayed unchanged. A second cycle published 0. |
| Trace report | **Recorded** | Stage timings, model and message counts below. |
| API restart recovery | **PASS** | API stopped for about 12 s: the UI showed `Offline` ("Can't reach the API… Showing the last received state") and kept 2-1. After the restart, the UI recovered without a reload. The snapshot was identical: 1206/1206 `finished`, 2-1, period 2, 2,822,767 ms; 55 moments (5 ai, 50 fallback); overlay `ok` 55/5/0. |
| Tab reopen recovery | **PASS** | Old tab closed, fresh tab opened at :5173: run `gate-20261020-d` restored, 2-1 at full time, Live updates `Live` (new negotiation), 55/5/0, the same 5 AI cards. |
| Console errors | **PASS** (fresh tab) | The fresh tab had 0 console messages. The long-lived tab from earlier sessions had stale network errors (`ERR_NETWORK_IO_SUSPENDED` from the machine sleeping, `ERR_CONNECTION_REFUSED` from stopping the old API) that predate this run, so it was not used as evidence. |
| Recaps (optional) | **PASS / UNVERIFIED** | `first_half` final through 618 (3 key moments: goal, chance, chance, all AI); `full_time` final through 1206 (3 goals, all AI); recap AI rewrite `off`. **UNVERIFIED:** clicking a key moment to seek the replay. |

Trace report (`trace_report.py`, report `data/generated/trace-gate-20261020-d.json`, gitignored):
- **Moments, jobs, insights:** 55 each.
- **Stage timings reflect when people ran things, not pipeline latency:**
  - `ingest_to_detect` p50 320 s: the bridge was run by hand about 5 minutes after ingestion;
  - `detect_to_job` 0 s;
  - `job_to_insight` p50 1,679 s, p95 1,699 s: narrated later by `phase4_live.py`;
  - `insight_to_published` p50 658 s, p95 711 s: the push cycle was run about 11 minutes after narration.
- **Model:** 17 calls to `azure-openai:gpt-41-mini` (5 AI insights × 3 roles, plus 2 broadcaster repairs), **16,065 tokens**. Role p50 2.4–3.8 s.
- **Messages:** 113 Web PubSub messages.
- `emit_to_ingest` not measurable (fixture clock).

**Observation, not a failure:** while the API was stopped, Live updates stayed `Live` rather than going to `Reconnecting`. The browser's socket connects to Azure Web PubSub directly, not through the API, so an API outage doesn't drop it. Recovery came from the snapshot API as designed. Whether the push status should also reflect API reachability is a frontend decision.

**Phase 4 gate:** reconnect restores the correct score, clock and insights (PASS for both API restart and tab reopen); the halftime recap links to verified moments (final, through 618, key moments from reconciled moments); fan and analyst views share one insight per moment (verified by the narration owner on this run). Live push works for every message type.

**Phase 4 completion, 2026-10-21 (Akash, branch `phase4-complete`).**
- **Reviewed and merged** PR #16 (negotiate and outbox) and PR #17 (joint gate results).
- **Recaps carry a read-only `reconciliation` status:** off, not_applicable, pending, reconciled, mismatch, differs or error, with per-period detail.
  - The source is `services/api/app/reconciliations.py`, enabled with `OMNIPITCH_INSIGHTS=cosmos`.
  - The Recap tab shows a "Reconciled" chip, with per-period details in Analyst view.
  - Live on `gate-20261020-d`: first half reconciled through 618, full time through 1206.
- **Recap key-moment seek** (UNVERIFIED in PR #17) was verified in the built-in browser: the 25' goal seeks to 24:11.
- **Data quality's Live updates card** now says the socket is independent of the API, so "Live" can stay on during an API outage. The top bar shows API reachability.
- **Smoke test fix:** `test:replay:browser` failed about 1 run in 8, on `main` before Phase 4 as well. Clicks right after a reload found the New match button briefly disabled. The script now retries clicks until the control is usable (10 of 10 runs passed) and reports the browser's exception text instead of "Uncaught".
- **Tests:** 155 Python passed, 19 skipped. `test:contracts`, `test:push`, `test:pitch`, the build and `test:replay:browser` passed.
- **Known:** when push isn't configured, the browser logs one 503 from negotiate per page load; the page then stays on polling, as designed.

**Deployment prep, 2026-10-21 (Tanmayee, branch `deploy-prep`).**

- **Bridge Cosmos cost:** each cycle now reads a run's existing moment and job IDs (two single-partition ID-only queries) and attempts writes only for missing records. Writes stay create-only. Measured live on `gate-20261020-d`: an idle rerun went from **220 RU / ~23 s to 8.2 RU / 2.5 s** (0 created). Reprocessing four recent runs created nothing. Test added (no write attempts for known records). 156 passed, 19 skipped.
- **Read-only deployment checks** (the Fabric owner's Azure subscription):
  - Azure Static Web Apps is **not available** in any region the subscription policy allows (Static Web Apps: Central US, East US 2, West US 2, West Europe, East Asia; the policy allows West US, Germany West Central, France Central, Norway East, Denmark East).
  - Container Apps is available in West US.
  - `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.ManagedIdentity`, `Microsoft.ContainerRegistry` and `Microsoft.Web` are not registered.
- **Plan:**
  - API and UI as two Container Apps (consumption plan, scale to zero) in West US;
  - images on GitHub Container Registry (no Azure Container Registry);
  - no Log Analytics workspace;
  - the bridge runs locally when a demo run is published (not 24/7).

## Phase 5 — hardening and scope freeze (project guide, Oct 20–23)

Goal: stabilise the deployed experience and stop feature creep. Gate: duplicate, late-event, outage, reconnect and quiet-run tests pass; shared deployment works; no new features after the freeze (Oct 23). Artifacts: test report, deployed candidate, measured latency and costs.

- [x] Deployed candidate (Tanmayee, PR #19, 2026-10-21): UI and API on Container Apps (scale to zero, managed identity, no keys), verified from the internet.
- [x] Redeployed with the default judge run (Tanmayee, 2026-10-25): both apps on `main` `dacd426`. Verified from the internet: `default_run.outcome = loaded`; the live UI bundle matches the `dacd426` image; a fresh visitor lands on the Eventhouse run with the skip link, `main` landmark and page heading; 0 console errors.
- [x] Default judge run (Akash, 2026-10-21): `OMNIPITCH_DEFAULT_RUN` loads one Eventhouse run on a fresh start in azure mode, so a scale-to-zero restart doesn't leave visitors on an empty replay. It never replaces a restored or chosen run; failures show in `/api/v1/backend`. **Pending:** set `OMNIPITCH_DEFAULT_RUN=gate-20261020-d` on `omnipitch-api` and redeploy both images (Tanmayee).
- [x] Accessibility and states (Akash, 2026-10-21):
  - **Automated audit** (AccessLint, live DOM, full match loaded): 69 violations before, 1 after. The remaining one is a false positive: the selected Audience label is `#0f1e26` on a full-width `#eaf0ea` thumb, about 15.6:1.
  - **Fixes:**
    - `--chalk-faint` raised to `#839da5` (4.66:1 or better on every panel colour);
    - the event chips became a labelled group of toggle buttons;
    - a `<main>` landmark, a skip link and an `<h1>`;
    - the brand link's name now matches its text;
    - the recap period switch uses pressed buttons;
    - `touch-action: manipulation`;
    - the evidence drawer traps Tab and contains overscroll.
  - **Verified:** Tab then Enter on the skip link focuses `main`; Tab and Shift+Tab stay inside the drawer; Escape closes it (headless smoke test).
- [x] Quiet and alternate seeds (Akash): `test_phase5.py` runs whole matches through the match room (quiet 1/7/21, high_press 3, standard 42). For each it checks the snapshot contract, evidence integrity, every insight's checks, both recaps (schema-valid, final, at most 3 verified key moments, trend only with valid windows) and the score. Quiet matches have under half the moments of a standard match. A goalless final reads "Ends level at 0-0".
- [x] Evidence display: provenance now says who wrote the text and what was checked (AI: three roles plus code checks plus API re-check; template: no model).
- [x] Frontend hosting: same-origin nginx Container App with the API under `/api` (PR #19), instead of Static Web Apps. No CORS change was needed.
- [x] Bridge-side outage tests (Tanmayee, 2026-10-25). Store (Cosmos) down mid-write: the cursor stays put and the partial write is completed on retry, with exactly one job per moment (`test_store_outage_mid_write_leaves_no_partial_state_after_recovery`). Down before any write: nothing is written and the cursor stays (`test_store_outage_before_any_write_keeps_cursor`). **Fix:** the worker loop caught only Eventhouse errors, so a Cosmos outage would have crashed the polling process. It now logs any dependency error (type and status only) and retries on the next cycle (`test_worker_cycle_survives_any_dependency_outage`; restoring the old handler fails it). Eventhouse down (`test_failed_cycle_keeps_cursor_and_retries`) and Web PubSub down (`test_failed_send_is_retried_with_the_same_message_id`) are already covered.
- [x] Health probes, budget alert and stop-everything (Tanmayee, 2026-10-25). **Probes:** liveness and readiness are HTTP checks (API `GET /health`, UI `GET /`); the platform's TCP startup probe is kept for cold starts. Both apps came back Healthy and ready with 0 restarts, and the site and `/health` answered 200. **Budget:** a monthly subscription budget with email alerts at 50, 80 and 100 % of actual spend. **Stop-everything:** documented in ARCHITECTURE → Operations.
- [x] Measured pipeline latency with the bridge polling continuously (Tanmayee and Akash, 2026-10-25). Run `latency-20261025-a`: seed 7, standard, full match plus 25 duplicates; bridge polling every 2 s with push on; narrator running continuously. *Every moment was attempted with the live model under a 10K tokens-per-minute cap; 46 jobs fell back after 2 rate-limited attempts; job→insight timings include retry waits.*

  | Stage | p50 | p95 | n |
  | --- | --- | --- | --- |
  | ingest → detect | 6.5 s | 6.5 s | 55 |
  | detect → job | 0 s | 0 s | 55 |
  | job → insight | 322.5 s | 521.2 s | 55 |
  | insight → published | 7.7 s | 25.0 s | 55 |
  | ingest → insight (end to end) | 329.0 s | 527.7 s | 55 |
  | emit → ingest | not measurable (simulator fixture clock) | | |

  - **Model:** 30 calls, 28,492 tokens (9 AI insights × 3 roles plus 3 broadcaster repairs); per-role p50 3.5–5.8 s.
  - **Insights:** 55, of which 9 AI and 46 template fallback.
  - **Bridge:** 55 moments and jobs; both periods reconciled (29 + 26, 0 mismatches); 134 cycles with 0 errors.
  - **Push:** 113 messages (1 state, 55 moment, 2 period_reconciled, 55 insight), 0 failures.
  - **Reading:** detection and publication take seconds. End-to-end time is dominated by narration queueing behind the model rate limit, not by per-call latency. Ingest → detect includes about one extra cycle, while the previous run was still inside the bridge's 2-minute re-check window.
  - Cost per day is tracked outside the repository.
- [x] Freeze contracts and scope (joint; recorded 2026-10-25 and agreed through review of this change). From here on, bug fixes only.
- [ ] Bilingual text: only if time allows after the freeze; the guide makes a second language optional once the MVP gates pass.

**Repository hygiene (Tanmayee, 2026-10-25):** subscription and tenant IDs, resource names, deployed URLs, university names and cost figures were removed from the docs, README and infra scripts before the repository goes public. The infra scripts now take every environment-specific name as a required parameter. Earlier commits in git history still contain some of these identifiers; none is a key, password or connection string.

**Phase 5 test report, 2026-10-21 (local; 167 Python tests passed, 19 cloud tests skipped; `test:contracts`, `test:push`, `test:pitch`, build and `test:replay:browser` 3/3 passed):**

| Gate item | Evidence | Status |
| --- | --- | --- |
| Duplicates | `test_phase2::test_duplicate_and_out_of_order_ingestion_do_not_change_counts`; `test_bridge::test_duplicate_delivery_and_reprocessing_create_nothing`, `test_duplicates_do_not_change_reconciliation`; `test_push::test_reruns_and_duplicates_publish_nothing_new`; `test_narration::test_duplicate_claim_after_lease_expiry_publishes_one_insight`; live: 25 duplicates on `gate-20261020-d` (1,231 rows, 1,206 unique) | PASS |
| Late events | `test_bridge::test_late_event_delays_moments_then_fills_in_without_changing_frozen_evidence`, `test_late_event_before_period_end_delays_reconciliation`; `test_phase2::test_gap_stops_windowed_metrics_at_contiguous_prefix` | PASS |
| Outages | Bridge: `test_failed_cycle_keeps_cursor_and_retries` (Eventhouse), `test_failed_send_is_retried_with_the_same_message_id` and `test_restart_between_send_and_mark_resends_once_and_counts_once` (Web PubSub). API: `test_phase5` Cosmos overlay, reconciliation and push outages; `test_azure_mode` default-run failure. Narration: timeout, rate-limit and fallback tests | PASS, except bridge-side Cosmos outage (not written yet) |
| Reconnect | `test_phase4::test_reconnect_restores_score_clock_and_insights`; `test_phase2::test_restart_restores_replay_position`; push client reconnect (`test:push`); live joint gate on `gate-20261020-d` (PR #17: API restart and tab reopen) | PASS |
| Quiet run | `test_phase5::test_whole_match_room_holds_for_quiet_and_alternate_seeds`, `test_quiet_matches_stay_quiet_in_the_match_room`; `test_phase2::test_quiet_scenario_has_fewer_shots_and_moments` | PASS |
| Shared deployment works | PR #19, verified from the internet on 2026-10-21. Known limit: one shared replay per API instance (max 1 replica), so concurrent visitors see the same replay state | PASS, with known limit; default run pending redeploy |
| Measured latency | `latency-20261025-a` with continuous bridge and narrator (see the latency item above) | PASS (2026-10-25) |
| No new features after the freeze | Freeze recorded 2026-10-25 | PASS |

## Phase 6 — release and submission (project guide, Oct 24–27)

- [x] Fresh-clone setup check (2026-10-25, Windows, Python 3.11.3, Node 24.13.1). Following the README from a clean clone: `npm ci`, `test:contracts`, `test:pitch`, `test:push`, `typecheck` and `build` pass; the local API and UI start, and the browser plays the match, shows moments and opens the evidence drawer with no console errors. Backend tests: 170 passed, 21 skipped with `services/bridge/requirements.txt` installed. With only the README's dev requirements, 7 tests failed on a missing Azure SDK: 5 were a test helper (fixed), and the README now says to install the bridge requirements for the other 2.
- [x] Final smoke test of the live site (2026-10-25): PASS. Cold start: the first load showed "can't reach the match API" while the API started, and a reload worked. Then play, the moments feed with AI and Template labels (24 moments at 29', 3 AI), the goals filter, the evidence drawer, Fan/Analyst wording, the recap (Reconciled, AI key moments), Data quality (Live push, 24 insights from Cosmos, 0 rejected), the phone width (375 px, no horizontal scroll) and 0 console errors. The default run in Cosmos has 55 moments (5 AI, 50 template after rate limiting) and both periods reconciled. The replay was left paused at the start.
- [x] Judge runbook (README, "Try the live demo") and pre-judging checks (ARCHITECTURE, Operations); public README updated to the current capabilities.
- [ ] Release tag and submission verification (Tanmayee).
- [ ] Cross-browser demo, storyboard, screenshots, a video under two minutes, link checks and the final submission review (Akash).
- [ ] Delete the Event Hubs namespace after the freeze, unless a new demo run is needed (Akash).

## Stretch

- [ ] Export reusable synthetic datasets with provenance and schema version (was the repo's Phase 5).
- [ ] Basic producer selection and recap tools (was the repo's Phase 5; the guide allows a producer queue only if the core is stable).

- [ ] Simple 3D replay after the 2D path is reliable.
