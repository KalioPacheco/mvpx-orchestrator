# Model Routing Policy

## Principle

Use the **cheapest sufficient intelligence with conservative promotion rules**. MVPX never sends risky work to a cheaper model merely because it might save quota.

v0.4.15 preserves the v0.4.14 model-routing policy and makes WAIT states attempt-neutral; dependency readiness is resolved deterministically before any lane is selected; model choice still follows the conservative execution policy below:

| Role | Model | Reasoning | Rule |
|---|---|---|---|
| Initial audit / planner | GPT-5.6 Luna | Medium | Bounded coordination from a clear goal |
| Replan | GPT-5.6 Luna | Medium | Reconcile only unresolved work |
| Simple implementation | GPT-5.6 Luna | High | Only simple + low-risk + local + non-architectural + <=6 estimated files |
| Scoped normal slice | GPT-5.6 Terra | Medium | Lead-approved, local/non-architectural slice |
| Critical/architectural slice | GPT-5.6 Terra | High | High-risk or cross-module implementation |
| Technical lead decomposition | GPT-5.6 Terra | High | Break broad expensive work into buildable slices |
| Repair after Luna | GPT-5.6 Terra | High | Immediate promotion if host gates fail |
| Normal repair | GPT-5.6 Terra | High | Preserve coding capability |
| Repeated repair failure | GPT-6 Sol | High | Evidence-based rescue |

## Conservative simple lane

A package is eligible for Luna High only when **all** conditions hold:

```text
complexity == simple
risk == low
crossModule == false
requiresArchitectureChange == false
estimatedFiles <= 6
adaptiveImplementerRouting == true
```

Any uncertainty routes to Terra. The planner is explicitly instructed that `normal` is the safe default and that under-classifying work to save tokens is incorrect.

Examples that may qualify for Luna High when genuinely local:

- small form/feedback improvements;
- local accessibility fixes;
- bounded responsive adjustments;
- simple loading/empty/error states;
- mechanical component cleanup with explicit acceptance criteria.

Examples that stay on Terra High:

- architecture or cross-module refactors;
- auth/RBAC/security behavior;
- data contracts or migrations;
- transactional/POS flows with broad coupling;
- shared state changes;
- ambiguous work or medium/high risk packages.

## Fallback ladder

For a simple slice:

```text
Luna High → Terra Medium → Terra High → Sol High
```

For scoped/decision-complete work:

```text
Terra Medium → Terra High → Sol High
```

For genuinely critical/open-decision work:

```text
Terra High → Terra High → Sol High
```

Environment/credential/external blockers never escalate through this ladder.

## Why Luna Medium remains the planner

Planning is a bounded coordination task. Medium is intentionally used rather than Low because a weak plan can cause much more expensive implementation exploration. Deterministic bookkeeping/classification remains local code and consumes no model call.

## Why Luna High, not Medium, for simple implementation

The simple lane still writes production code. The goal is to save by choosing a cheaper model family, not by weakening reasoning on code changes. High gives Luna more room to satisfy acceptance criteria while the strict eligibility filter limits blast radius.

## Cost-aware packaging

MVPX stores completed package observations in:

```text
.mvpx/cost-history.json
```

The planner receives a compact historical profile on later goals/runs. It may use that history to make expensive classes of work smaller. Independent of the model's plan, MVPX enforces one-task packages when work is:

- `complex` or `critical`;
- cross-module;
- architectural;
- estimated to touch at least the configured `costAwareEstimatedFilesThreshold` (default 10).

Cost history is a packaging hint only. It must never override correctness, coupling, or risk.


## Slice fallback ladders

```text
Luna High → Terra Medium → Terra High → Sol High
Terra Medium → Terra High → Sol High
Terra High → Terra High → Sol High
```

The lead does not downgrade risk to save quota. A slice that cannot leave incremental gates passing must be merged with its coupled dependency rather than artificially split.


## Verification-backed high-risk slices (v0.4.9)

`complex/high` is eligible for Terra Medium only when the slice is non-architectural, <=2 files by default, and the Terra High lead sets `verificationBacked=true` with concrete `verificationEvidence` (for example a targeted unit/integration test or deterministic contract check). If the host gate fails, the next attempt is Terra High. `critical`, architecture-changing, broad, or unverifiable high-risk slices never use this lane.

## Decision-complete routing (v0.4.10)

A parent milestone being critical no longer means every child must reason at Terra High. The lead explicitly marks whether the hard decision is still `open` or already `locked`.

- `open`, architecture change, critical-domain, or `critical` → Terra High.
- `locked` + verification-backed + non-critical + non-architectural + bounded → Terra Medium.
- `normal/medium` bounded execution → Terra Medium.
- `simple/low/local` → Luna High.
- Failed Medium execution escalates immediately to Terra High, then Sol if needed.

A high-lane slice above the atomic threshold must explain why it cannot be split while keeping the repository buildable.

## Cost-weighted budgeting (v0.4.11)

Model selection remains the v0.4.10 decision-complete policy. Budgeting is independent of lane count: a fourth or fifth narrow Terra High slice is allowed when projected input still fits the run budget. Predictions prefer same-lane historical slices and weight similarity in complexity, risk, decision state, critical-domain/architecture flags and estimated files. No routing downgrade is performed merely to fit budget.


## Fresh validation repairs (v0.4.13)

Final gate repair model selection is unchanged (`Terra High`, escalating to `Sol High` at the configured retry threshold), but thread reuse is removed. Attempt 1, attempt 2 and escalation attempts each start in a fresh thread. The current gate failure and previous-attempt summary provide continuity. This deliberately trades conversational continuity for a smaller, more relevant context window.

### Wait-neutral escalation rule

`internal_dependency`, `external_dependency`, `environment`, `credential`, `product_decision`, and `unsafe_action` do not count as failed implementation attempts. They therefore do not promote a slice to a stronger model. Only real implementation/gate failures advance the escalation ladder. `orchestration_budget` is intentionally excluded.
