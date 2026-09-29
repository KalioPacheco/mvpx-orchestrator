# ADR-017: Wait-Neutral Attempts

Status: Accepted in MVPX v0.4.15.

## Context

v0.4.14 correctly introduced dependency-aware scheduling and automatic downstream wake-up. A resumed slice could still execute at a stronger model than its displayed route because `attempts` was incremented before the agent returned a dependency WAIT. On wake, `sliceModel(..., attempt=2)` interpreted the pause as a failed implementation.

## Decision

A WAIT that is not an implementation failure does not advance the model escalation ladder. The neutral blocker classes are `internal_dependency`, `external_dependency`, `environment`, `credential`, `product_decision`, and `unsafe_action`. Transport failures before a model thread starts are also neutral. `orchestration_budget` is excluded because it represents problematic execution behavior rather than an external pause.

A marker prevents double refunds. Legacy v0.4.14 WAIT state without the marker is repaired once when it wakes.

Actual escalation must be visible in logs, including the base model, selected model, and the number of prior implementation/gate failures that justify the change.

## Consequences

- `terra-medium` work no longer becomes Terra High merely because a prerequisite was missing.
- Genuine gate failures still drive `Luna → Terra Medium → Terra High → Sol` or `Terra Medium → Terra High → Sol`.
- Resuming a WAIT preserves real failures that occurred before the WAIT instead of resetting all retry history.
