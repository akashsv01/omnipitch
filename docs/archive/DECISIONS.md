# Decision log

## D001 — Monorepo

Status: Accepted.

Decision: Keep apps, services, contracts, analytics and docs in the existing Git checkout.

Rationale: Keep interfaces and tests together in one repository.

Consequences: Preserve the remote; current checkout is inside the workspace's pre-existing `omnipitch/` directory. Do not create another nested project.

## D002 — Local-first initialization

Status: Accepted.

Decision: Run without cloud credentials or services.

Rationale: Cloud access is unverified and Innovation Studio is blocked.

Consequences: Use static fixtures; no deployment, database, authentication or streaming.

## D003 — Frontend and backend stack

Status: Accepted.

Decision: React/TypeScript/Vite with ordinary CSS; Python/FastAPI/Pydantic.

Rationale: Small modules provide a readable local HTTP path.

Consequences: Pin direct dependencies, keep npm lockfile, and verify on the available runtimes. No routing or state framework.

## D004 — Coordinates and time

Status: Accepted.

Decision: Fixed global 105 × 68 metre pitch frame, explicit attack direction, elapsed milliseconds within each period, UTC wall-clock emissions.

Rationale: Avoid coordinate rotation and ambiguous time interpretation.

Consequences: Fixture baselines are reproducible; replay resets get a new run ID and identity is run-scoped.

## D005 — Synthetic fictional data

Status: Accepted.

Decision: Use fictional Harbor Comets and Vale Owls, with fictional player identifiers; support completed passes only.

Rationale: Clearly demonstrate contracts without implying real tracking or football evaluation.

Consequences: Preserve possession and pass continuity; other events and off-ball tracking are not implemented.

## D006 — JSON contracts

Status: Accepted.

Decision: JSON Schema draft 2020-12 is the documented wire reference; explicit Pydantic and TypeScript models are manually aligned and fixtures validated.

Rationale: Catch drift without a code-generation pipeline.

Consequences: Schema changes require examples, models, checks and documentation changes. AJV validates browser responses; jsonschema validates generated JSONL. Fixture insight has explicit metric units and generation_mode `fixture`.

## D007 — Defer cloud SDKs

Status: Accepted.

Decision: Add cloud SDKs only for an authorized integration task that needs them.

Rationale: Placeholder integrations would obscure current functionality and require unnecessary configuration.

Consequences: Azure/Fabric/Foundry access is not claimed; agent and analytics implementations remain pending.

## D008 — Share the fixture algorithm

Status: Accepted.

Decision: API sample_data imports the simulator using a single repository-relative local module path; state remains a committed fixture.

Rationale: One algorithm prevents two divergent sample sequences while avoiding packaging infrastructure.

Consequences: Run the API in the monorepo. Tests guard event/state consistency. Independent packaging and JSONL replay ingestion are future tasks.

## D009 — License

Status: Pending owner decision.

Decision: Do not select a repository license during initialization.

Rationale: Licensing belongs to the owner.

Consequences: No LICENSE file added; decide before wider distribution.

## D010 — Verified dependency baseline

Status: Accepted.

Decision: Pin current Vite 8.3.3/plugin 6.1.2 on Node 24.11.0; use AJV 8.20.0 and RFC3339 date-time validation support.

Rationale: Initial older Vite build stalled, and npm reported Vite/AJV advisories. The adjusted baseline builds and serves shared-schema imports successfully. Python format checking required an explicit optional validator dependency.

Consequences: Record exact tested versions in README and lockfile, and validate calendar dates in regression checks. This baseline is not a claim that every package is the latest release or that cloud integrations have been verified.

