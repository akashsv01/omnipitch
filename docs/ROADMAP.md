# Roadmap

Phases describe intended work, not committed completion dates. Implement only the assigned task.

## Current state

Current phase: Phase 1, interactive 2D pitch. The local frontend displays selectable static synthetic passes on a pitch with event details. No AI inference, replay playback, analytics engine, persistence or cloud integration exists. The English insight is a contract fixture, not an API narrative endpoint.

Next slice: load a selected validated JSONL replay with run reset, ordered playback and API-backed controls. Then define one deterministic pass metric with units and evidence references. Current event selection is inspection of static data, not playback.

Last recorded application verification (2026-10-07): 25 Python tests passed with one upstream deprecation warning; pip check, three frontend fixture checks, TypeScript/production build and final live HTTP smoke check passed. npm installation audit reported zero vulnerabilities then; no Python security audit, browser interaction test or cloud access check was run. Details: [historical progress](archive/PROGRESS.md).

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
- [ ] Load a selected JSONL replay with run resets and ordered playback.
- [ ] Add pause/resume controls and explicit coordinate/attack labels.

Coordinate and attack labels are implemented on the static pitch; pause/resume depends on the replay slice and remains pending.

2026-10-13 frontend slice: added a responsive SVG pitch, selectable API pass cards and synchronized event details with empty-state handling and accessible labels. Verification: `npm run test:contracts` passed for all three fixtures; `npm run test:pitch` passed both-direction/boundary, empty-state and initial-selection checks; `npm run build` passed including TypeScript; `git diff --check` passed. Existing locked dependencies were installed; no new dependencies or Microsoft services were added. Browser interaction/visual checks, live HTTP smoke and backend tests were not run for this frontend slice. No commit or push made.

## Phase 2 — verified metrics and moment detection

- [ ] Define deterministic metrics with units and test evidence attribution.
- [ ] Detect a small set of moments; verify against labeled synthetic fixtures.
- [ ] Define duplicate and out-of-order delivery behavior.

## Phase 3 — grounded AI narratives and validation

- [ ] Define evidence bundles and validated narrative output boundaries.
- [ ] Integrate Microsoft Agent Framework/Foundry only when access and scope permit.
- [ ] Add grounded explanations, honest limitations and distinguish fixture/AI/fallback output modes.

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
