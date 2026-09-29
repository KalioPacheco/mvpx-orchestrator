# Changelog

> `v0.4.13` is the first public-beta/stabilization release prepared for a public GitHub repository. Public-release hygiene (license, CI, contribution/security docs, templates) does not change runtime behavior.

## 0.4.15 — Wait-Neutral Attempts

- Fixed a bookkeeping defect where a slice that paused on an internal/external/environment WAIT could resume as attempt 2 and silently escalate `terra-medium → terra-high`.
- WAIT causes that are not implementation failures (`internal_dependency`, `external_dependency`, `environment`, `credential`, `product_decision`, `unsafe_action`) now refund the current attempt exactly once.
- Added v0.4.14 state repair: legacy waiting slices/milestones are normalized on wake without repeating completed work or double-refunding attempts.
- Transport failures before thread start remain attempt-neutral. `orchestration_budget` is intentionally not neutralized.
- Added explicit escalation logging whenever the actual model differs from the slice's base route.
- Added regression coverage for neutral waits and dependency-wake migration.
- Model routing, dependency DAG, slicing, cost budgets and validation policy are otherwise unchanged.

## 0.4.14 — Dependency-Aware Scheduler

- Add explicit `dependsOnTaskIds` to every planned/replanned task and validate the resulting DAG.
- Make dependency readiness the first scheduler criterion; milestone priority now only orders the ready queue.
- Park downstream work as `internal_dependency` rather than executing it prematurely.
- Detect runtime-discovered in-plan prerequisites from structured blocker output / referenced `TASK-*` IDs and add them to the DAG.
- Auto-unblock internal waiters as soon as prerequisite tasks become `done`/`superseded`; no `--retry-blocked` or manual `mvpx unblock` is required.
- Keep true external dependencies separate and human-actionable.
- Reject unknown dependency IDs, self-dependencies, and dependency cycles deterministically.
- Migrate the observed v0.4.13 empty-repository state where M-003/M-002 were incorrectly frozen as external even though TASK-001/TASK-002 were internal prerequisites.
- Add dependency scheduler regression tests and config version 12.

## 0.4.13 — Fresh Targeted Repairs

- Start every final-validation repair attempt in a fresh Codex thread, including attempt 1.
- Carry cross-attempt continuity through a compact repair contract: current gate failure, affected-file hints, previous repair summary, previous changed files and previous decisions.
- Add `finalRepairMemoryMaxChars` (default 6,000) so validation repair handoffs do not inherit the full 18k implementation memory budget.
- Keep evidence-aware validation classification from v0.4.12 unchanged.
- Record final-validation repair observations separately in `.mvpx/cost-history.json`, including gate, attempt, model, token usage and whether the rerun passed.
- Exclude repair-cost observations from milestone/slice planning predictions so QA telemetry cannot distort implementation packaging.
- Add migration to config version 11 and repair-specific regression tests.
- Add ADR-015 and record the v0.4.12 final-repair benchmark that motivated fresh-first repairs.

## 0.4.12 — Evidence-Aware Validation Routing

- Replace broad string-first validation classification with evidence-priority routing.
- Treat explicit Jest assertions/diffs, TypeScript diagnostics, compiler errors and lint diagnostics as strong code evidence.
- Narrow sandbox detection: a bare `sandbox` token (for example `SandboxBillingProviderService`) is no longer an environment signal.
- Treat package-manager wrappers such as `ELIFECYCLE`, generic exit code 1 and `command failed` as neutral rather than root-cause evidence.
- Delegate only genuine strong-evidence conflicts to the existing Luna Medium validation classifier.
- Introduce project status `validation_pending` when implementation is complete but final gates still require resolution; task-level blocked counts remain independent.
- Migrate legacy `blocked` final-validation state with no executable tasks to `validation_pending` on load.
- Preserve v0.4.11 execution routing, slicing and token-first budgeting unchanged.
- Add ADR-014 and record the v0.4.11 backend benchmark that exposed the false environment classification.

## 0.4.11 — Cost-Weighted Run Budget

- Remove the rigid normal-work cap of 3 Terra High implementation turns per run; Luna/Terra execution is governed by actual + predicted input cost instead.
- Keep the Sol turn cap as a separate escalation circuit breaker.
- Persist per-slice cost observations (lane, complexity/risk, decision state, critical-domain flag, architecture flag and file count) in `.mvpx/cost-history.json`.
- Backfill slice cost observations from completed slices already present in `state.json` during upgrade/run startup, so v0.4.11 immediately learns from previous v0.4.10 work.
- Predict the next slice using the closest lane-aware historical observations, with conservative cold-start fallbacks.
- Re-evaluate the predictive budget before every slice and pause before starting work projected to exceed the 4M default input budget.
- Preserve v0.4.10 decision-complete routing and all critical-domain protections unchanged.
- Add ADR-013 documenting token-first cost-weighted run budgeting.

## 0.4.10 — Decision-Complete Execution

- Separate decision making from decision execution with `decisionState=open|locked`.
- Route locked, bounded, verification-backed complex/high slices to Terra Medium when they are non-critical and non-architectural.
- Preserve Terra High for open decisions, architecture changes, critical slices, and core auth/tenant/payment/data-integrity invariants.
- Require broad Terra High slices (>4 files by default) to justify atomicity; otherwise request one bounded lead refinement.
- Add predictive run-budget checks before every execution slice using lane-aware cost estimates.
- Refine unfinished pre-v0.4.10 slice plans while preserving completed slices.
- Add ADR-012 documenting the decision-complete model.

## 0.4.9 — Verification-Backed Routing

- Allow ultra-bounded `complex/high` slices (<=2 files by default) to start on Terra Medium only when a Terra High lead marks them `verificationBacked` with concrete deterministic evidence.
- Verification-backed Terra Medium failures escalate immediately to Terra High; broad, critical, architectural, or unverifiable high-risk work stays Terra High.
- Extend slice plans with `verificationBacked` and `verificationEvidence`, with strict lead instructions against gaming the flag.
- Remove the independent technical-lead turn cap; lead turns are governed by the global input budget.
- Add predictive global budget pauses using `current run input + predicted next milestone input`, while never deadlocking the first milestone of a fresh run.
- Re-refine unfinished pre-v0.4.9 slice plans once while preserving completed slices.
- Keep Luna High strict for simple/local/low-risk work and Terra Medium for normal bounded work.

## 0.4.8 — Cheapest-Safe Slice Routing

- Fixed `normal/medium` bounded slices being promoted to Terra High solely because they cross a few backend layers.
- Parent milestone criticality no longer leaks into child routing; each slice is classified independently.
- Technical lead now explicitly decomposes for the cheapest safe execution model without under-classifying risk.
- Predicted high-cost milestones may use up to 7 slices to isolate mechanical/tests/DTO/migration work from the high-judgment core.
- Lead Terra High budget is separate from implementation Terra High budget.
- Existing pre-v0.4.8 pending slices are re-refined once while completed slices are preserved.
- Routing logs now explain why each slice received Luna High, Terra Medium, or Terra High.


## 0.4.7 — Hierarchical Decomposition

- Add Terra High technical-lead decomposition for broad/high-cost milestones.
- Add execution slices with independent file scopes, acceptance criteria, routing and checkpoints.
- Add Terra Medium as the scoped normal implementation lane.
- Route slices conservatively: Luna High → Terra Medium → Terra High → Sol High as evidence requires.
- Add historical/heuristic input-cost prediction before implementation.
- Add an internal run budget (default 4M input, 3 Terra High turns, 1 Sol turn) evaluated between slices/work packages.
- Pause cleanly with resumable slice state when the run budget is reached.
- Document the v0.4.6 backend stress case that exhausted a usage window on 10–18-file critical packages.
- Preserve v0.4.6 adaptive routing, v0.4.5 recovery, v0.4.3 Validation Router and v0.4.2 progress-aware guard.


## 0.4.6 — Adaptive Implementer Routing

- Add conservative work metadata: complexity, risk, cross-module, architecture-change and estimated file count.
- Route only simple + low-risk + local + non-architectural packages (<=6 estimated files) to GPT-5.6 Luna High.
- Keep GPT-5.6 Terra High as the default implementation lane.
- Promote Luna failures immediately to Terra; do not charge the Luna probe against Terra's retry budget.
- Preserve GPT-6 Sol High as evidence-based rescue after repeated Terra repair failures.
- Persist completed package cost observations in `.mvpx/cost-history.json`.
- Feed compact historical cost guidance into future audit/replan turns.
- Enforce one-task packages for complex/critical, cross-module, architectural, or broad (>=10 estimated files) work.
- Rename the post-turn token threshold message to `High-context turn detected`; it is telemetry, not a proactive token cap.
- Preserve v0.4.5 interrupted-run recovery and all v0.4.3 validation routing behavior.

## 0.4.5 — Interrupted run recovery

- Recover milestones/tasks persisted as `running` after a CLI/process interruption.
- Decrement the phantom in-flight milestone attempt so recovery does not trigger premature model escalation.
- Add a completion invariant: final validation cannot mark a project `done` while `todo`, `failed`, or `running` tasks remain.
- Queue a safe replan when executable tasks exist but their milestone state is inconsistent.
- Fix the observed case where a transport failure left M-006 `running`, causing MVPX to skip it and report `done` with two tasks remaining.

## 0.4.4 — Transport resilience

- Retry Codex CLI/SDK startup failures that happen before `thread.started`.
- Treat stdin/pipe startup errors as infrastructure failures, not AI/model attempts.
- Keep the same milestone checkpoint during transport retries.
- Prevent transport failures from incorrectly escalating Terra work to Sol.
- Return the milestone to `todo` if infrastructure retries are exhausted.

## 0.4.3 — Validation Router

- Added deterministic-first final validation routing.
- Added Luna Medium fallback classification for ambiguous gate failures.
- Added one host-only retry for test/browser/UI gates before spending AI quota.
- Decomposes aggregate quality scripts into explicit child gates when available.
- Added targeted Terra repair packages scoped to one failing gate.
- Reruns only the repaired gate instead of the full validation suite after every repair.
- Stops repair loops when a failure becomes environmental or transient.
- Keeps the v0.4.2 progress-aware activity guard unchanged.


## 0.4.2 — Progress-Aware Guard

- Replace the v0.4.1 hard 20-command cutoff with a progress-aware guard.
- A soft command threshold now activates monitoring only; healthy work may continue well beyond it.
- Stop on sustained no-progress activity, repeated identical commands, or deliberately high circuit breakers.
- Default guard circuit breakers: 200 commands, 350 tool events, 120 changed files, 25 minutes.
- Default stagnation rule: after the 50-command soft threshold, stop only after 24 commands + 3 minutes without progress.
- Detect progress from file changes, completed todo items, and successful validation commands.
- Reduce automatic guard continuations from 2 to 1 to avoid restart thrashing.
- Report per-slice changed files separately from total changed files since checkpoint.
- Add per-run usage deltas so cumulative project telemetry is not mistaken for current-run cost.
- Document that aborted slices may consume quota without emitting `turn.completed` usage telemetry.

## 0.4.1 — Efficiency Router

- Route audit/replanning to GPT-5.6 Luna Medium.
- Keep GPT-5.6 Terra High for implementation and repair.
- Keep GPT-6 Sol High as retry-threshold escalation.
- Cap planned work packages at 1–2 tasks.
- Add planner-produced `fileScope` to reduce repository rediscovery.
- Disable periodic replanning by default; use event-driven replanning.
- Add proactive streamed activity guard (commands, tool events, files, duration).
- Preserve worktree and continue in a fresh thread when the guard trips.
- Add `orchestration_budget` blocker for repeated guard trips.
- Reduce default durable memory from 24k to 18k characters.
- Trim quality-gate failure payloads sent back to repair workers.
- Preserve/migrate v0.4 state and repackage remaining executable work.
- Add comprehensive architecture, model-routing, benchmark, operations, roadmap and ADR documentation.
- Document Node.js >=22.12 requirement; Node 20 is unsupported with the current dependency set.

## 0.4.0 — Bounded Context

- Fresh implementation thread per milestone.
- Fresh planner thread for replanning.
- Durable project memory and decisions.
- Frozen environment blockers.
- Host-side quality validation.
- Token telemetry.

## 0.3.0 — Persistent Project Thread

- Project-wide thread and milestone grouping.
- Git checkpoints and rollback.
- Revealed unbounded-context cost in benchmark runs.
