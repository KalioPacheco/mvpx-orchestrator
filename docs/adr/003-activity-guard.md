# ADR-003: Add a proactive streaming activity guard

**Status:** Superseded by ADR-004

## Context

v0.4 configured a 750k input-token threshold, but several implementation turns ended at ~2.7M–3.6M input tokens. The threshold could only rotate the *next* repair because usage is reported when a turn completes.

## Decision

Use streaming events during implementation to monitor observable activity:

- command starts;
- tool/file-change events;
- unique files changed;
- elapsed time.

Abort a turn when limits are exceeded using the SDK's cancellation signal. Preserve the worktree, derive changed files from the checkpoint and continue in a fresh bounded thread.

After repeated guard trips, pause the milestone as `orchestration_budget` rather than spending indefinitely.

## Consequences

Positive:

- can stop runaway exploration before turn completion;
- preserves partial useful edits;
- provides a practical pre-token-limit guard.

Tradeoffs:

- an aborted turn may not produce normal final token telemetry;
- thresholds need empirical tuning;
- too-aggressive limits can create unnecessary continuation overhead.
