# OmniPitch coding-agent instructions

## Before starting
1. Read `AGENTS.md`.
2. Read `docs/CONTEXT.md`.
3. Read `docs/HANDOFF.md`.
4. Read the relevant architecture, decisions, and roadmap sections.
5. Inspect actual code and tests before assuming documentation is current.
6. Check the working tree and preserve unrelated changes.

## Source of truth
- Code and reproducible verification establish implemented behavior.
- Documentation describes intended behavior and recorded decisions.
- If code and documentation disagree, explicitly identify the mismatch.
- Never silently treat a planned feature as implemented.
- Ask for clarification only when conflicting requirements materially affect the work.

## Scope discipline
- Implement the user's current task. Do not automatically start the next roadmap item.
- Do not add services or dependencies without a concrete need.
- Do not provision cloud resources, publish, or send messages without authorization.
- Do not invent metrics, evaluation results, or successful checks.

## Engineering conventions
- React/TypeScript frontend; Python/FastAPI backend.
- Keep calculations deterministic and outside LLM prompts.
- Validate inputs and generated outputs at boundaries.
- Use structured errors and explicit units.
- Keep secrets out of source control, logs, and browser bundles.
- Preserve run IDs, event IDs, and evidence references.
- Design later event processing for duplicate delivery; event identity is `(run_id, event_id)`.
- Label synthetic data and illustrative metrics honestly.
- Keep changes small and understandable.

## Documentation maintenance
At the end of every meaningful implementation task:
- Update `docs/PROGRESS.md` with completed work and actual verification.
- Update `docs/HANDOFF.md` with current state, blockers, and next steps.
- Update `docs/CONTEXT.md` when current capabilities or scope change.
- Update `docs/ARCHITECTURE.md` when actual interfaces or data flow change.
- Add consequential decisions to `docs/DECISIONS.md`.
- Update README instructions when commands or configuration change.

Do not modify every document mechanically for a trivial edit. Update affected documents and keep status truthful.

## Final response
Report what changed, what was actually tested, known limitations or blockers, and the next recommended task.
