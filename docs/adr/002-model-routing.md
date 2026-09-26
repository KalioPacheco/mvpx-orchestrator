# ADR-002: Route planning to Luna, implementation to Terra, rescue to Sol

**Status:** Accepted for v0.4.1 experiment

## Context

Using Terra High everywhere produced correct work but spent expensive capability on planning/replanning that can be done with a smaller bounded model. Using a low reasoning tier indiscriminately risks a weak plan that causes much more expensive implementation waste.

## Decision

- Luna Medium: audit and replan.
- Deterministic local code: bookkeeping, known blocker classification, gates, memory and checkpoints.
- Terra High: implementation and standard repair.
- Sol High: only after repeated Terra failure (default attempt 3).

Luna Low is not invoked simply because it is cheap. It is reserved for future cases where a real ambiguous classification task remains after deterministic logic.

## Consequences

The planner is cheaper than Terra while retaining enough reasoning for coordinated work. Expensive models are concentrated where code quality benefits from them.
