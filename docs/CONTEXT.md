# OmniPitch context

OmniPitch transforms synthetic, football-realistic events into explainable match intelligence for fans, analysts, and broadcast producers, with reusable datasets for AI and analytics.

Two developers work in small vertical slices: agree contracts first, split frontend/backend work, review each other's changes, and keep handoffs current. Coding agents follow `AGENTS.md`.

Current phase: Phase 0, local scaffold and contracts.

Implemented: React/TypeScript/Vite sample-data screen; FastAPI health, demo state and event endpoints; deterministic completed-pass JSONL CLI; JSON Schemas, examples and focused verification checks. No AI inference occurs. English fixture insight is a contract example, not an API narrative endpoint.

Planned: synthetic replay and 2D pitch, verified analytics and moment detection, evidence-grounded narratives, tactical explanations, highlights, multilingual and personalized experiences, halftime/full-time recaps, dataset export, Producer Mode, and cloud integration. 3D replay is stretch scope.

Conventions: 105 × 68 metre fixed global pitch frame; x along length, y along width. Origin is one fixed pitch corner; no halftime coordinate rotation. Attack direction is explicit. Match time is milliseconds within a period. UTC emission timestamps are fixed in fixture mode. Replay resets create new run IDs; identity is `(run_id, event_id)`. Evidence IDs resolve within the insight's run. All current players/teams are fictional; no missing tracking is invented.

Stack: React/TypeScript/Vite, Python/FastAPI/Pydantic, JSON Schema draft 2020-12. Dependencies are local and pinned; see README for verified versions.

Non-goals for initialization: full analytics, multi-agent workflows, authentication, databases, WebSockets, deployment, cloud SDK placeholders, provisioning, and 3D pitch.

Known blocker: Innovation Studio access is blocked by a hardware-token authentication prompt. The user has contacted support. This does not block local development.

Azure and Fabric access have not been verified. Repository license decision is pending.

Details: [Architecture](ARCHITECTURE.md), [Roadmap](ROADMAP.md), [Decisions](DECISIONS.md), [Progress](PROGRESS.md), [Handoff](HANDOFF.md), [local commands](../README.md).
