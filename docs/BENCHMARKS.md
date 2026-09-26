# Benchmarks and Experiment History

These measurements come from real MVPX runs during development. Usage-window percentages are user-observed values from Codex's 5-hour window. They are **not** a linear token-to-percent conversion and should be treated as comparative operational measurements, not billing formulas.

## v0.2 — thread per task

Architecture:

```text
audit thread
TASK-001 fresh thread
TASK-002 fresh thread
TASK-003 fresh thread
...
```

Observed:

- 3 tasks completed
- ~59 percentage points of the 5-hour window consumed
- ~19.7 percentage points per completed task

Finding: too much repeated repository/context discovery.

## v0.3 — one persistent project thread

Architecture:

```text
one global thread
 → audit
 → milestone
 → milestone
 → milestone
 → replan
```

Observed:

- 11 tasks completed
- 1 environment-blocked task
- ~69 percentage points consumed
- 7 AI turns
- input: **80,049,840**
- cached input: **75,586,560 (94%)**
- output: **409,447**
- reasoning: **115,875**
- ~6.27 percentage points per completed task

Individual later turns reached ~18.9M input tokens.

Finding: caching was excellent, but the conversation became enormous. A high cache percentage does not make an indefinitely growing context efficient enough.

## v0.4 — bounded thread per milestone

Architecture:

```text
bounded planner
fresh thread per 3-task milestone
host gates
```

Observed run:

- start usage remaining: 85%
- end usage remaining: 21%
- **64 percentage points consumed**
- 12 tasks completed
- 3 tasks remained
- 7 AI turns
- input: **13,851,809**
- cached input: **12,984,576 (94%)**
- output: **98,713**
- reasoning: **32,536**
- ~5.33 percentage points per completed task

Compared with v0.3:

- input tokens reduced ~82.7%
- output tokens reduced ~75.9%
- reasoning tokens reduced ~71.9%
- quota per completed task improved ~15%

Finding: bounded context solved the giant-history problem, but individual implementation turns still reached ~2.7M–3.6M input tokens. The configured 750k token budget was only a **post-turn alarm**, because usage is reported after completion.

## v0.4.1 — efficiency router + fixed activity guard

Changes:

- Luna Medium for audit/replan;
- Terra High only for implementation/repair;
- Sol High only after repeated failures;
- max 1–2 tasks per package;
- planner-generated `fileScope`;
- event-driven replanning only;
- proactive streaming activity guard;
- deterministic host gates;
- smaller 18k-character project memory;
- trimmed gate failure payloads.

### Original success target

For a comparable 10–12 task mission:

- acceptable: **≤ 35–40%** of a 5-hour window;
- strong result: **~25–30%**;
- total input target: **< 6–8M**.

These are experimental targets, not guarantees.

### Observed follow-up run

A smaller continuation run provided the key guard signal:

- 5-hour-window remaining: **57% → 39%** (18 percentage points consumed);
- secondary observed limit: **100% → 94%**;
- 2 tasks completed;
- 1 task paused by `orchestration_budget`;
- **5 guard trips** total;
- every trip occurred at exactly 21 commands because the configured hard limit was 20.

The cumulative token line in `mvpx status` was historical project telemetry, not a clean per-run total, and aborted slices may not emit `turn.completed` usage. The reliable finding is therefore behavioral: the 20-command guard was too aggressive and caused restart thrashing.

## v0.4.2 hypothesis

Keep Luna/Terra/Sol routing and bounded work packages unchanged, but replace low fixed command limits with progress-aware detection. Success means:

- healthy packages can exceed 50 commands without interruption;
- guard trips occur only on genuine stalls/repetition/high circuit breakers;
- ideally ≤1 guard trip per difficult package;
- no regression in the usage-window improvement observed in v0.4.1.

## Benchmark procedure

Before run:

1. record Codex 5-hour usage remaining;
2. run a mission large enough to produce ~10–12 tasks;
3. do not change model/config midway unless documenting the change.

After run:

```bash
mvpx usage --last 30
mvpx status
```

Record:

- usage remaining before/after;
- tasks completed;
- milestones completed;
- total input/output/reasoning;
- guard trips;
- Terra→Sol escalations;
- blockers.

Primary metric:

```text
usage-window percentage consumed / useful completed tasks
```

Secondary metrics:

- input tokens per completed task;
- AI turns per completed task;
- guard trips per package;
- number of human interventions.


## v0.4.3 — targeted final validation proof

A validation-only continuation started at 92% and ended at 90% of the observed 5-hour window:

- initial host pass: typecheck/test/build passed; lint failed;
- deterministic classifier routed lint as a code failure;
- exactly **1 Terra High** targeted repair;
- repair input: **200,202** tokens;
- 0 guard trips;
- lint passed after the targeted repair;
- final host-only confirmation passed.

Finding: Validation Router removed the previous multi-million-token full-suite repair loop and proved that deterministic routing + one-gate repair can make final QA cheap.

## v0.4.5 — clean full-mission baseline before adaptive implementation routing

A clean mission completed the final 2 tasks after an external Codex outage recovered, producing a complete 12-task measurement:

- observed 5-hour window: **90% → 43%** = 47 percentage points consumed;
- 12/12 tasks completed;
- 0 guard trips;
- input: **10,028,880**;
- cached input: **9,242,368 (92%)**;
- output: **97,533**;
- reasoning: **24,864**;
- ~**3.92 percentage points/task**;
- ~**836k input tokens/task**.

Compared with v0.4's ~5.33 percentage points/task, this is ~26% lower quota usage per task. Compared with v0.2's ~19.7 points/task, it is ~80% lower.

Finding: the major orchestration waste had been removed. The dominant remaining cost was Terra High implementation on every package, including locally bounded work. This benchmark is the baseline for v0.4.6 adaptive Luna/Terra routing.

### v0.4.6 target

For a comparable 10–12 task mission:

```text
<= 30–35 percentage points   desired exit range
0–1 guard trips              expected
rare Luna→Terra fallback     desired
Sol escalation               exceptional
```

Quality and acceptance remain hard constraints. A lower usage result is not a success if Luna causes regressions or frequent repairs.


## v0.4.6 — backend stress case that motivated hierarchical decomposition

A production-readiness backend mission started with 43% remaining in the observed 5-hour window and exhausted the remaining capacity after four completed broad milestones. The completed packages were all complex/critical and cross-module, touching ~10–18 estimated files each:

- 2.11M input — complex/medium, ~16 files;
- 2.87M input — critical/high, ~16 files;
- 2.07M input — critical/high + architecture change, ~18 files;
- 1.94M input — complex/high + architecture change, ~10 files.

Total completed-turn input before capacity exhaustion: ~8.99M. Adaptive Luna implementation had effectively no opportunity because the planner correctly classified almost all work as broad/risky.

Finding: the remaining bottleneck was **unit-of-work size**, not model-family routing. v0.4.7 therefore introduces technical-lead decomposition, Terra Medium for scoped normal slices, and an internal run budget.

## v0.4.7 backend hierarchical checkpoint (2026-09-25)

For a critical cross-module payment-security milestone predicted at ~2.06M input, v0.4.7 used one Terra High lead plus two Terra High slices before the run budget paused: 2.54M input, 91% cached, 13 quota points, 0 guard trips. The lead produced a `normal/medium` four-file slice but the router still selected Terra High because `crossModule` was an absolute veto. This directly motivated v0.4.8: child-independent routing, cheapest-safe lead decomposition, separate lead/implementation budgets, and up to 7 slices for predicted high-cost work.


## v0.4.8 payment-security continuation

A continuation of the critical payment-security milestone consumed 16 quota points (87% → 71%) for one Terra High lead plus four completed slices. Run delta was 2.44M input tokens, 88% cached, 0 guard trips. Routing improved: one `normal/medium` one-file slice used Terra Medium (256k input), while two `complex/high` two-file slices still used Terra High (448k and 682k). The independent one-lead cap then paused the next milestone despite the lead costing only 330k. This motivated v0.4.9: verification-backed Terra Medium for ultra-bounded complex/high slices and predictive global budgeting instead of a lead-count cap.

## v0.4.9 backend architecture benchmark

A critical architecture milestone ran from 71% to 45% of the 5-hour window (26 quota points). It executed one Terra High lead and six slices before the 4M input budget paused the run. Run delta: 4.33M input, 90% cached, 0 guard trips.

Observed implementation costs:
- Terra High slices: ~787k–845k input for the three broad/high-judgment slices.
- Terra Medium slices: ~456k, 541k, and 592k; all three passed without fallback.

The result validated Terra Medium for bounded execution, but showed that parent risk/architecture labels still kept too much already-decided work on Terra High. It also showed that checking the 4M budget only after a slice allowed the run to reach 4.33M. v0.4.10 addresses both issues with decision-complete routing and predictive per-slice budgeting.


## v0.4.10 decision-complete backend benchmark

A continuation of the architecture/configuration milestone consumed **13 quota points** while completing one Terra High lead plus four slices. Run delta was **1,944,062 input**, 89% cached, 0 guard trips.

Observed slice costs:

- Terra Medium S07: 589,001 input; completed without fallback.
- Terra High S08: 339,537 input; payment-integrity critical domain.
- Terra High S09: 314,497 input; tenant-provisioning critical domain.
- Terra High S10: 483,635 input; authentication critical domain.
- Terra High narrow/locked average in this sample: ~379k input, versus ~824k for the broader Terra High slices observed in v0.4.9.

The routing behaved as intended: critical payment/tenant/auth slices stayed on Terra High while decision-complete normal work used Terra Medium. The run nevertheless paused at only 1.94M input because the legacy `3 Terra High` implementation-turn cap fired. This showed that **turn count had stopped being a useful proxy for cost** once hierarchical decomposition made Terra High slices much narrower. v0.4.11 therefore switches normal execution budgeting to actual + lane-aware predicted input cost.


## v0.4.11 token-first completion + validation-router failure (2026-09-26)

The backend continuation ran from **87% to 74%** (13 quota points) while completing the remaining M-002 slices plus both M-001 work packages. Run delta: **9 AI turns**, **1,611,498 input**, 80% cached, **0 guard trips**. The run successfully used all intended lanes: narrow critical work on Terra High, bounded work on Terra Medium, and genuinely simple one-file work on Luna High.

Final host validation passed typecheck/build but Jest reported **5 failed suites / 17 failed tests / 308 passed** with explicit assertion diffs (for example an expected webhook error JSON body versus `{}`). MVPX incorrectly classified the test gate as `environment (100%)`. Investigation found the bare `/sandbox/i` environment pattern matching application names such as `SandboxBillingProviderService`. This benchmark motivated v0.4.12: evidence-priority classification and `validation_pending` state semantics.


## v0.4.12 final-validation completion benchmark (2026-09-26)

The backend resumed with all 8 implementation tasks complete and final validation pending. The run moved from **74% to 65%** of the observed 5-hour window (9 quota points). Evidence-aware routing correctly classified Jest failures as `code (100%)`, performed targeted repair, and reached `done` with all final gates passing.

Run delta: **2 AI repair turns**, **1,895,125 input**, 91% cached, 0 guard trips. The first targeted repair reused the existing final-repair thread/context and consumed **1,631,843 input** but did not close the gate. Because it crossed the high-context threshold, attempt 2 rotated to a fresh thread and consumed only **263,282 input**, after which the test gate passed. The fresh attempt used about **84% less input** than the resumed attempt; the first turn represented about 86% of total repair input.

Finding: evidence-aware validation routing is correct, but waiting until a repair becomes high-context before rotating wastes quota. v0.4.13 therefore starts **every** targeted final-validation repair attempt fresh and transfers only a compact repair contract between attempts. This is the final planned 0.4.x optimization before a stability period.
