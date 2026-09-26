# ADR-009 — Hierarchical decomposition and run budgets

## Context

v0.4.6 reduced waste for simple/local work, but a production-readiness backend audit produced almost exclusively complex/critical cross-module tasks touching 10–18 files. Four Terra High turns consumed the remaining 43% of the observed 5-hour Codex window. Adaptive model routing had little opportunity to help because the unit of work itself was still too broad.

## Decision

Broad/high-cost milestones are no longer handed directly to one implementer.

1. A bounded **technical-lead** turn (Terra High) inspects only the milestone scope and creates 2–5 buildable execution slices.
2. Each slice has its own file scope, acceptance criteria, complexity/risk and estimated file count.
3. Routing happens per slice:
   - simple + low-risk + local + small → Luna High;
   - scoped normal + non-architectural → Terra Medium;
   - critical/high-risk/cross-module/architectural → Terra High;
   - repeated failure → Sol High.
4. Every slice must leave the configured incremental gate passing. If a contract change and its consumers cannot safely be separated, the lead keeps them together.
5. A checkpoint is created per slice so a failed slice can roll back without discarding previously completed slices.

## Cost-aware trigger

Hierarchical decomposition is enabled when any of these is true:

- milestone complexity is `critical`;
- cross-module;
- architecture-changing;
- estimated files exceed the configured threshold (default 10);
- historical/heuristic predicted input exceeds the configured threshold (default 900k).

Historical cost is read from `.mvpx/cost-history.json` and is a packaging hint only.

## Run budget

MVPX cannot read the user's exact ChatGPT/Codex usage-window percentage. Instead it uses a conservative internal budget based on completed-turn telemetry.

Default run budget:

- 4,000,000 input tokens;
- 3 Terra High completed turns;
- 1 Sol completed turn.

The budget is checked **between** slices/work packages. It never aborts a healthy slice merely to hit a number. Once reached, MVPX saves state/checkpoints and pauses before beginning another expensive unit. Running `mvpx run` again starts another bounded batch.

## Consequences

Positive:

- complex backend work can use expensive reasoning for architecture while delegating bounded execution to cheaper lanes;
- previous slice progress is preserved across budget pauses;
- a single 16–18 file task is less likely to consume an entire usage window;
- routing quality becomes explainable at slice level.

Trade-offs:

- one additional lead turn for broad work;
- more state/checkpoints;
- decomposition quality matters, so the lead remains Terra High;
- tightly coupled changes may still require a large Terra High slice.
