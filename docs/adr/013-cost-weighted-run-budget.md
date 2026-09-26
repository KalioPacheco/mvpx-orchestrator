# ADR-013: Cost-Weighted Run Budget

Status: Accepted in MVPX v0.4.11.

## Context

Earlier run budgets used fixed model-turn counters because a single Terra High implementation turn could consume 0.8M–3M input tokens. After hierarchical decomposition and decision-complete routing, narrow critical Terra High slices in the backend benchmark fell to roughly 0.31M–0.48M input. A fixed limit of three Terra High turns then paused runs with more than half of the 4M token budget still available.

Turn count is therefore no longer a reliable cost proxy.

## Decision

Normal Luna/Terra execution is budgeted by input cost rather than turn count:

1. Keep the configured global run input budget (4M by default).
2. Before every slice, compute `actual run input + predicted next-slice input`.
3. Pause before the slice only when that projection exceeds the global budget.
4. Learn slice cost from completed work and persist observations in `.mvpx/cost-history.json`.
5. Match predictions by execution lane and nearby profile: complexity/risk, decision state, critical-domain flag, architecture flag, cross-module signal and file count.
6. Backfill slice observations from existing `state.json`/usage history so upgrades are not cold-started.
7. Use conservative heuristic estimates only when no lane history exists.
8. Keep the Sol-turn limit as a separate escalation safety circuit breaker.
9. Preserve all v0.4.10 routing rules; this ADR changes budgeting, not model selection.

## Consequences

- Several narrow Terra High slices can run in one batch when their measured/predicted cost fits the token budget.
- A single expensive predicted slice can still cause a clean pause before execution.
- The budget becomes increasingly project-specific as cost history accumulates.
- Prediction is advisory and conservative; correctness gates and critical-domain routing remain authoritative.
