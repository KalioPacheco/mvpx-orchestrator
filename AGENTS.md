# MVPX Orchestrator development rules

- MVPX is CLI-first and dependency-light.
- Optimize for autonomous progress per unit of model usage, not for the fewest model calls and not for maximum concurrency.
- Node.js >= 22.12 is the supported runtime for the current dependency set.
- Prefer deterministic local code over an AI call whenever the decision can be made reliably from Git state, process results, schemas or explicit rules.
- Use bounded context: audit/planning threads are isolated, and each implementation work package gets a fresh Codex thread.
- Never reuse a project-wide implementation thread across work packages.
- Keep work packages small: default maximum 1–2 closely related tasks.
- Every planned work package should include a narrow `fileScope`; implementation workers inspect that scope first and leave it only for a concrete direct dependency.
- Persist durable knowledge in `.mvpx/PROJECT_MEMORY.md` and `.mvpx/DECISIONS.md`, not in an ever-growing chat history.
- Replanning is event-driven by default. Do not replan merely because N milestones completed.
- Frozen blockers must not be silently reintroduced by replanning.
- Preserve explicitly requested skills/workflows from the project goal in relevant work-package prompts.

## Model routing

- Use `gpt-5.6-luna` with `medium` reasoning for audit/planning/replanning.
- Do not call Luna Low for deterministic classification that code can already perform.
- Use `gpt-5.6-luna` with `high` reasoning only for strictly simple + low-risk + local + non-architectural implementation packages (<=6 estimated files).
- Use `gpt-5.6-terra` with `medium` reasoning for lead-approved scoped normal execution slices.
- Use `gpt-5.6-terra` with `high` reasoning for technical-lead decomposition, critical/architectural slices, broad direct work, and high-risk repairs.
- Escalate to `gpt-6-sol` with `high` reasoning only at the configured retry threshold (default attempt 3).
- Do not escalate because a task merely appears difficult; require evidence such as repeated failure.
- Treat `normal` as the safe routing default. Never under-classify work merely to reduce usage.
- Persist completed package cost observations and use them only to improve packaging, never to weaken quality/risk constraints.
- Treat broad/critical/cross-module/architectural/high-predicted-cost work as candidates for hierarchical decomposition. Every slice must be buildable under incremental gates; never split coupled contract changes merely to force cheaper routing.
- Respect the internal run budget between slices/work packages. Pause cleanly instead of starting another expensive turn once the bounded run budget is reached.

## Efficiency controls

- Run implementation with `runStreamed()` so tool activity can be observed during the turn.
- Use a progress-aware activity guard. Command count is only a soft observation signal; never abort healthy work merely for exceeding 40/50 commands.
- Token usage is a post-turn metric; never describe `maxTurnInputTokens` as a hard proactive token cap.
- Treat file changes, successful write/validation commands and completed todo items as progress signals. When the guard detects a real stall/repetition/high circuit-breaker trip, preserve the worktree and allow at most one fresh bounded continuation.
- Pause repeated guard trips as `orchestration_budget` instead of consuming indefinitely.
- Record per-turn input, cached input, output and reasoning token usage for completed turns.
- Keep quality-gate failure payloads sent to AI concise and relevant.
- Final-validation targeted repairs must always start in fresh threads. Carry prior-attempt continuity only through a compact structured handoff; never resume a repair thread merely because it is below a token threshold.

## Validation / blockers

- Treat environment/credential/product/external blockers as frozen work. Do not automatically retry them until explicitly unblocked.
- Host-side validation may resolve environment blockers that exist only inside the Codex sandbox.
- Run cheap incremental gates during work packages and the full suite only when planned work is complete.
- Avoid duplicate quality gates when an umbrella script explicitly invokes child scripts.
- Never silently weaken tests, lint, type checking, build gates or UI quality gates.
- Run preflight before spending an AI turn when local prerequisites can be checked deterministically.
- Dependency/network preparation must be explicit (`--prepare`); Codex itself stays network-disabled by default.

## Git / safety

- Create an internal Git checkpoint before each work package without changing the user's branch or HEAD.
- Roll back automatically only when a work package exhausts retries and rollback is enabled.
- Do not add normal branch commits, push, deploy, modify secrets or run destructive product/data operations.
- Persist orchestration state under `.mvpx/` and preserve resumability across CLI invocations.

## Roadmap gate

- Treat v0.4.13 as the 0.4.x stabilization candidate. Do not add parallel agents/worktrees until fresh targeted repairs have been exercised across real projects and the single-worker path is stable. Parallelizing an inefficient worker only burns quota faster.
