# MVPX Architecture

## Design goal

MVPX optimizes for **useful autonomous progress per unit of model usage**, not for the fewest prompts and not for maximum concurrency.

The key lesson from early versions is that both extremes are expensive:

- too many fresh threads force repeated repository rediscovery;
- one permanent thread accumulates enormous context and makes every later turn expensive.

v0.4+ therefore uses bounded, role-specific contexts.

## Components

```text
CLI
 │
 ├─ Preflight
 ├─ State Store
 ├─ Planner
 ├─ Orchestrator
 │   ├─ Work Package Runner
 │   ├─ Activity Guard
 │   ├─ Quality Gates
 │   ├─ Blocker Manager
 │   └─ Replanner
 ├─ Project Memory
 └─ Git Checkpoints
```

### Preflight

Runs before an AI turn and checks deterministic prerequisites such as package manager, dependencies and UI/Playwright setup. Preparation requiring downloads is explicit via `--prepare`.

### Planner

Uses a fresh read-only Luna thread. It audits once for a new goal and produces small work packages with:

- 1–2 tasks;
- acceptance criteria;
- priority;
- a narrow `fileScope`.

`fileScope` is important: implementation workers are told exactly where to start instead of paying to rediscover the whole repository.

### Orchestrator

Selects the next work package, creates a Git checkpoint, launches the worker, validates output, performs repairs if necessary and advances state.

### Work package runner

Each package receives a **fresh** implementation thread. Routing is conservative: strictly simple/low-risk/local/non-architectural packages (<=6 estimated files) may use Luna High; every other package uses Terra High. It receives only:

1. stable policy/instructions;
2. bounded project memory;
3. package description;
4. file scope;
5. 1–2 tasks and their acceptance criteria.

A work package thread is never reused for a different package. If a Luna package fails host gates, repairs are promoted to Terra immediately.

### Cost-aware packaging

Completed package observations are persisted in `.mvpx/cost-history.json`. Future planners receive only a compact aggregate/history hint. Complex/critical, cross-module, architectural, or broad packages are deterministically capped to one task. Cost history may make packaging more conservative, but never overrides correctness or coupling.

### Activity guard

Token usage is reported only after a Codex turn finishes, so a token threshold cannot prevent a runaway turn. v0.4.2 therefore uses a **progress-aware streaming guard** rather than a small fixed command budget.

Observable progress signals include:

- file-change events;
- completed todo-list items;
- successful validation commands (typecheck/test/lint/build/Playwright/quality);
- successful commands that clearly mutate the worktree (for example `apply_patch`, `sed -i`, redirection, formatter/fixer writes).

The default 50-command threshold is only a **soft observation threshold**. It never aborts healthy work by itself. After that point MVPX stops a slice only when it observes sustained no-progress activity, repeated identical commands without progress, or a deliberately high circuit breaker/duration.

Default safety valves:

- 200 commands hard circuit breaker;
- 350 tool events;
- 120 changed files within the slice;
- 25 minute hard duration;
- 24 commands + 3 minutes without progress after the soft threshold;
- 6 repeats of the same normalized command without progress.

If the guard trips, the worktree is preserved and one fresh bounded continuation may continue from the partial state. Repeated guard trips pause the package as `orchestration_budget`.

### Quality gates

Quality gates run in the host process, outside the model. A passing command costs no AI turn.

Typical incremental flow:

```text
implementation
 → typecheck
 → PASS → done
 → FAIL → send trimmed failure output to Terra
```

Full validation runs after executable work is complete.

### Durable memory

`.mvpx/PROJECT_MEMORY.md` is intentionally small. It keeps durable facts, not raw conversation history.

It contains:

- overall goal;
- compact project summary;
- durable decisions;
- active blockers;
- remaining work;
- recent completed-package handoffs that fit the memory budget.

### Git checkpoints

Before every package, MVPX writes a hidden Git commit under `refs/mvpx/checkpoints/...` using a temporary index. It does not create normal branch commits or move `HEAD`.

This supports rollback without polluting the user's history.

## Replanning policy

v0.4.2 is **event-driven**. Periodic replanning is disabled by default (`replanEveryMilestones = 0`).

Replanning happens when:

- migration requires repacking old work;
- an implementation explicitly reports that remaining assumptions materially changed;
- future orchestration logic marks `needsReplan`.

Successful packages do not trigger replanning simply because N packages passed.

## Why no parallelism yet

Parallelism multiplies throughput and consumption. It is intentionally postponed until one worker is efficient enough. v0.5 may add isolated Git worktrees only after v0.4.6 proves adaptive single-worker routing reduces usage without quality regression.


## v0.4.3 final-validation router

Final validation is a separate orchestration lane. Failed gates are retried deterministically when appropriate, classified before repair, and repaired one gate at a time. Environment/transient failures never enter the Terra repair loop. Aggregate quality scripts are decomposed into child gates when those child scripts are explicitly available, enabling targeted reruns and smaller repair context.


## Transport resilience (v0.4.4)

Failures before `thread.started` are treated as CLI/transport startup failures, not model failures. MVPX retries them without incrementing model attempts or changing checkpoints.

## Interrupted-run recovery (v0.4.5)

MVPX treats persisted `running` state as an interrupted process, not as completed or blocked work. On the next `mvpx run`, those milestones/tasks are restored to executable state before scheduling. A second invariant prevents final validation from marking a project `done` whenever executable tasks remain. If tasks and milestone states disagree, MVPX queues a safe replan instead of silently dropping work.


## v0.4.8 cheapest-safe hierarchical execution

Large milestones are treated as epics, not atomic implementation turns. Before execution, MVPX estimates cost from historical package observations and metadata. Broad/high-cost work receives a bounded Terra High lead turn that produces buildable execution slices. Slices receive independent model routing and Git checkpoints. Run budgets are evaluated between slices so MVPX can pause safely without interrupting useful work.


## v0.4.9 verification-backed execution

The Terra High technical lead can label an ultra-bounded `complex/high` slice as verification-backed only when concrete deterministic host checks strongly cover its acceptance criteria. Such a slice may start on Terra Medium, with immediate fallback to Terra High after a failed gate. Run budgeting has no independent lead counter; the scheduler pauses between milestones when current run input plus predicted next-milestone input would exceed the global budget.

## v0.4.10 decision-complete lead contract

The technical lead no longer emits only scope and risk. It also locks or leaves open the substantive decision for each slice. This allows the worker router to distinguish architectural judgment from implementation of an already-approved contract. Pending slice plans from earlier versions are refined once; completed slices are preserved.

The run budget is checked before each slice using a lane-aware prediction. A slice is never interrupted merely because its predicted cost is high; MVPX pauses cleanly before starting it.

## v0.4.11 cost-weighted run budget

The run budget is token-first. Normal Luna/Terra execution is no longer stopped by a fixed count of Terra High turns. Before each slice MVPX estimates cost from lane-aware historical slice observations and checks `current run input + predicted next slice <= runBudgetMaxInputTokens`. Completed slice observations are persisted and pre-v0.4.11 completed slices are backfilled from state/usage history. Sol retains its independent escalation cap.


## v0.4.12 evidence-aware final validation

Final gate classification is root-cause-first. Strong code evidence outranks weak wrappers; environment classification requires specific host/tooling signatures. Conflicting strong evidence is delegated to the isolated Luna Medium classifier. Completed implementation with an unresolved final gate uses `validation_pending`, separating project QA state from task-level blockers.


## v0.4.13 fresh targeted final repairs

Final validation repairs are intentionally stateless at the thread level. Every attempt starts a new Codex thread. The durable handoff is explicit and bounded: a compact project-memory excerpt, current gate failure, deterministic classification/file hints, and (for attempts after the first) the previous repair summary, changed files and decisions. This prevents a failed repair from dragging a large accumulated implementation/final-QA conversation into the next attempt.

Repair memory uses `finalRepairMemoryMaxChars` (default 6,000), separate from the normal 18,000-character project-memory budget. The host reruns only the failed gate after each attempt. Repair token observations are persisted as `validation-repair` cost records for benchmarking, but they are excluded from implementation cost prediction and planner packaging.
