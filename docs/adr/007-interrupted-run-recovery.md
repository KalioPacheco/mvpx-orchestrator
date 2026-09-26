# ADR 007 — Interrupted run recovery

## Status
Accepted in v0.4.5.

## Context
A Codex transport failure can occur after MVPX persists a milestone as `running` but before an agent turn completes. A later process starts with no live worker, yet the persisted milestone still says `running`. Prior to v0.4.5, `nextMilestone()` selected only `todo`/`failed`, so the orphaned milestone was skipped. Final validation could then pass and incorrectly mark the project `done` even while tasks remained.

## Decision
1. At the beginning of every run, recover persisted `running` milestones/tasks to executable state.
2. Remove the phantom in-flight AI attempt from recovered milestones.
3. Never enter/finalize final validation as `done` while executable tasks remain.
4. If executable tasks are not attached to an executable milestone, queue a replan instead of dropping them.

## Consequences
- Process/CLI crashes are resumable without manual state editing.
- Transport startup failures cannot silently strand work.
- `Done` becomes a state invariant rather than a best-effort conclusion.
