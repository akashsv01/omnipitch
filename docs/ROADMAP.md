# Roadmap

Phases describe intended work, not committed completion dates. Implement only the assigned task.

## Current state

Current phase: Phase 1 and the local scope of Phase 2 are implemented and verified (2026-10-14). That covers a seeded state-machine simulator with scenarios; replay with speed, seek and generate; contracts v1.1; a SQLite event ledger with deduplication and restart recovery; deterministic metrics (progression, illustrative threat, windowed PPDA with sample gates); five moment rules with frozen evidence; prepared agent prompts with a validator, fallback narrator and evaluation set; and a redesigned, motion-rich match room with an evidence drawer and fan/analyst modes. Cloud status is in the Phase 2 table below: Event Hubs is live; Fabric is pending. No model is called; every insight is `generation_mode: fallback`.

**Phase 2 status (2026-10-15): not complete.** The local scope is done. On the cloud path, Event Hubs is verified live; the Fabric Eventstream → Eventhouse leg is coded but not yet connected or verified.

| Stage | Status | Evidence or blocker |
| --- | --- | --- |
| Simulator → Event Hubs | Verified | `simulator.publish` with Entra ID. The namespace `IncomingMessages` metric showed 20 messages at 00:08 UTC. Runs of 5 and 400+25 events were also sent. |
| Event Hubs → Eventstream → Eventhouse | Not done | UMD tenant has disabled Fabric trials. A UF teammate will start a trial and create the workspace, Eventhouse and Eventstream. |
| Event IDs queryable in Eventhouse | Unverified | Needs the above. The KQL queries are written but have never run against a live database. |
| API reads Eventhouse | Unverified live | Azure mode is tested only with a fake reader (`test_azure_mode.py`, 7 tests). |
| Browser shows the cloud run | Unverified | Needs a live Eventhouse. |
| Dedup, fixture calculations, sparse windows | Verified locally; cloud checks scripted | Checks are in `services/api/tests/cloud_smoke.py`. |

Resources created on 2026-10-15 in Azure for Students (Owner), then **deleted the same day (00:31 UTC) at the owner's request to save credit**. Total usage was about 30 minutes of 1 TU; afterwards the subscription has 0 resources. `infra/eventhubs.ps1` recreates the same names. The script has been syntax-checked but not run since. What existed: provider `Microsoft.EventHub` registered; `rg-omnipitch-dev` (East US); namespace `omnipitch-ehns-qn36t` (Standard, 1 TU, about $0.73/day of credit); hub `match-events`; consumer group `fabric-eventstream`; `Azure Event Hubs Data Sender` for the developer at hub scope; listen-only SAS rule `eventstream-listen`. No Fabric capacity was purchased. Verification on 2026-10-15: 77 Python tests passed, frontend contract and pitch checks and the build passed, and `cloud_smoke.py` reported Event Hubs PASS and the Eventhouse stage UNVERIFIED (not configured).

Next tasks, in order:

1. The owner recreates Event Hubs with `infra/eventhubs.ps1` when the teammate is ready for the Eventstream step. Then the teammate completes the Fabric setup (trial, workspace, Eventhouse `omnipitch-eh` / database `omnipitch`, `analytics/kql/setup.kql`, Eventstream from `match-events`).
2. Publish a fresh run, then run `cloud_smoke.py` with `--api` against the live Eventhouse, check the browser, and record actual results here.
3. Only after that, Phase 3: connect a Foundry model behind `agents.validation.finalize`.

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
- [ ] Fabric Eventstream → Eventhouse ingestion, plus a live run of the versioned KQL (`analytics/kql`). Code is ready; blocked on the Fabric workspace (UF teammate's trial).
- [ ] Live end-to-end smoke test (`services/api/tests/cloud_smoke.py --api`) with the browser showing the Eventhouse run.

## Phase 3 — grounded AI narratives and validation

- [x] Define evidence bundles and validated narrative output boundaries (`agents.prompts.evidence_packet`, `agents.validation`, 34-case eval set).
- [ ] Integrate Microsoft Agent Framework/Foundry only when access and scope permit.
- [~] Grounded explanations, honest limitations and fixture/AI/fallback modes: deterministic fallback narration and labels are done; AI generation is pending.

## Phase 4 — highlights, recap, bilingual text and preferences

- [ ] Evidence-linked key-moment highlights and halftime/full-time recaps.
- [ ] Bilingual text with validation and fan/analyst preferences.
- [ ] Tactical explanations supported by available evidence; no invented tracking.

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
