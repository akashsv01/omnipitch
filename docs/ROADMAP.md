# Roadmap

Phases describe intended work, not committed completion dates. Start access probes early and in parallel with local work; external cloud access is unverified.

## Phase 0 — local scaffold and contracts
- [x] Local frontend/API scaffold and documented startup verified.
- [x] Deterministic fixture generator and contract checks verified.
- [ ] Owner chooses repository license.
- [ ] Resolve Innovation Studio hardware-token blocker; probe Azure/Fabric/Foundry access without provisioning unless authorized.

## Phase 1 — synthetic replay and interactive 2D pitch
- [ ] Generate a synthetic pass, serve it through the API, and draw it on a 2D React pitch.
- [ ] Load a selected JSONL replay with run resets and ordered playback.
- [ ] Add pause/resume controls and explicit coordinate/attack labels.

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
