# ADR-008 — Adaptive Implementer Routing and Cost-Aware Packaging

## Status

Accepted for MVPX v0.4.6.

## Context

After bounded contexts, Luna planning, progress-aware guards and targeted validation repairs, a clean 12-task mission consumed ~47 percentage points of the observed 5-hour Codex window. The orchestration failures had largely disappeared: 0 guard trips, targeted final validation, and 12/12 tasks completed. The remaining dominant cost was Terra High implementation on every work package regardless of complexity.

## Decision

1. Keep Luna Medium for audit/planning/replanning.
2. Route only strictly `simple`, `low` risk, local, non-architectural packages estimated at <=6 files to Luna High.
3. Route all other implementation to Terra High.
4. If a Luna package fails host incremental gates, promote immediately to Terra High.
5. Do not count the initial Luna probe against Terra's repair budget; Sol remains a later evidence-based rescue.
6. Persist package cost observations in `.mvpx/cost-history.json`.
7. Feed a compact historical cost profile to future planner turns.
8. Enforce one-task packages for complex/critical, cross-module, architectural, or broad (>=10 estimated files by default) work.

## Consequences

Expected benefits:

- fewer Terra calls on clearly bounded mechanical work;
- preserved quality through host gates and immediate Terra fallback;
- smaller packages for historically/broadly expensive work;
- explainable routing visible in CLI/state.

Risks:

- planner could under-classify work. Mitigation: conservative schema/prompt rules plus deterministic eligibility checks; `normal` is the default.
- simple work may still be harder than predicted. Mitigation: Luna High rather than Medium, then immediate Terra promotion on gate failure.
- token cost history is not identical to Codex quota percentage. Mitigation: history guides packaging only; user-observed quota remains the benchmark metric.
