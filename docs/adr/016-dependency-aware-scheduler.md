# ADR-016: Dependency-Aware Scheduler

Status: Accepted in MVPX v0.4.14.

## Context

A fresh-repository mission showed that priority-only milestone selection could execute downstream work before foundational tasks. The downstream workers then reported missing `TASK-*` prerequisites and MVPX froze them as external dependencies, even though the prerequisites were already part of the same backlog.

This caused premature model spend, incorrect blocker semantics and unnecessary manual retry instructions.

## Decision

Represent task prerequisites explicitly with `dependsOnTaskIds` and validate them as a DAG.

Scheduler rules:

1. Unknown task IDs, self-dependencies and cycles are deterministic plan errors.
2. A milestone enters the ready queue only when every dependency outside that milestone is `done` or `superseded`.
3. Priority orders only milestones already in the ready queue.
4. Non-ready planned work is parked as `internal_dependency`.
5. If a worker discovers an omitted in-plan prerequisite, it reports/mentions the prerequisite `TASK-*` ID; MVPX adds the edge and parks the milestone internally.
6. Internal waiters are re-evaluated after each completion and on restart and resume without human action.
7. `external_dependency` is reserved for conditions outside the current MVPX graph.

## Consequences

- Foundational work executes before dependent integration work.
- Internal orchestration dependencies no longer masquerade as user blockers.
- Existing v0.4.13 states can recover automatically when blocker text names known task IDs.
- Planner output is slightly stricter because every task must declare `dependsOnTaskIds`, including an empty list.
- Replans must preserve existing dependency edges unless work is explicitly superseded.
