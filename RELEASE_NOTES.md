# MVPX v0.4.15 — Public Beta: Wait-Neutral Attempts

`v0.4.15` fixes a retry-accounting defect discovered after the v0.4.14 dependency scheduler successfully auto-resumed previously blocked work. A slice whose declared route was `terra-medium` could resume with `gpt-5.6-terra (high)` because the earlier dependency WAIT had already incremented its implementation attempt counter.

## What changed

- Dependency/environment/user-action WAITs are now attempt-neutral.
- Existing v0.4.14 waiters are repaired once when they wake.
- Transport startup failures remain attempt-neutral.
- `orchestration_budget` remains non-neutral by design.
- Real implementation/gate failures are still the only events that advance the model escalation ladder.
- If a retry uses a model different from the base lane, MVPX prints the explicit escalation reason.

## Motivating observation

In the validating v0.4.14 run, the dependency DAG worked correctly (`M-002` completed and released `M-003` automatically), but two slices retained `Route: terra-medium` while executing on Terra High. Both were slices that had previously entered WAIT because prerequisites were missing. This release removes that silent escalation path.

## Compatibility

State and config migrate in place. Do not delete `.mvpx/`. Config version is 13.
