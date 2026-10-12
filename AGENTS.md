# OmniPitch coding-agent instructions

## Before starting
1. Read `AGENTS.md` and `README.md`.
2. Read the current status, blockers and assigned task in `docs/ROADMAP.md`.
3. Read relevant interfaces, requirements and decisions in `docs/ARCHITECTURE.md`.
4. Inspect actual code and tests before assuming documentation is current.
5. Check the working tree and preserve unrelated changes.

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
Maintain four active documents; historical material lives in `docs/archive/`.
At the end of meaningful work:
- Update `docs/ROADMAP.md` with completed work, dated actual verification, blockers and next tasks.
- Update `docs/ARCHITECTURE.md` when interfaces, data flow, technical requirements or consequential decisions change.
- Update `README.md` when current capabilities, setup commands or repository structure change.
- Update `AGENTS.md` only when coding-agent policies change.

Archive entries are historical references, not current instructions. Preserve prior decisions and results; do not present old checks as newly run. Update affected documents rather than every file mechanically.

## Final response
Report what changed, what was actually tested, known limitations or blockers, and the next recommended task.
