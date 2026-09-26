# ADR-004: Replace fixed command budgets with a progress-aware guard

**Status:** Accepted

## Context

v0.4.1 aborted every implementation slice immediately after 20 command starts. In a real run, healthy work repeatedly reached exactly 21 commands, causing five guard trips across two milestones. One milestone completed only after two fresh continuations and another was paused after three slices.

A fixed low command count is not a reliable proxy for runaway behavior. Complex implementation may legitimately require dozens of shell operations. Repeatedly aborting useful work creates extra model turns and can consume more quota than allowing one healthy turn to finish.

## Decision

Use command count only as a **soft observation threshold**, not a normal abort condition.

After 50 commands, MVPX evaluates progress signals. It aborts when either:

- the same normalized command repeats 6 times without progress;
- at least 24 commands and 3 minutes occur without a progress signal;
- a high circuit breaker is crossed (200 commands, 350 tool events, 120 slice-local changed files);
- the 25-minute hard duration is reached.

Progress is observable and deterministic: file changes, newly completed todo items, successful validation commands, and clearly mutating shell commands reset stagnation/repetition state.

Allow only one automatic continuation after a guard trip. If the continuation also trips, pause the milestone for inspection rather than thrashing through multiple fresh threads.

## Consequences

Positive:

- healthy 40–100+ command work can complete uninterrupted;
- true repeated/stalled exploration is still bounded;
- fewer fresh-thread continuations;
- guard decisions become explainable through last-progress telemetry.

Tradeoffs:

- progress heuristics are imperfect;
- broad code generation can touch many files before a file-change event arrives;
- very active but low-value work can still reach a high circuit breaker;
- aborted slices may not expose final token usage.
