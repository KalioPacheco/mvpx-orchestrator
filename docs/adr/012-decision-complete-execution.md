# ADR-012 — Decision-Complete Execution

## Status
Accepted in MVPX v0.4.10.

## Context
v0.4.9 proved that Terra Medium can execute bounded backend work more cheaply than Terra High, but several slices remained on Terra High solely because they inherited high risk or architecture context from a parent milestone. In the benchmark that motivated this ADR, a 71%→45% run completed six slices with 4.33M input tokens. Three Terra Medium slices completed successfully at roughly 456k–592k input each, while three Terra High slices consumed roughly 787k–845k each.

The missing distinction was between **making a difficult decision** and **executing a difficult decision that a technical lead has already resolved**.

## Decision
Each execution slice now declares:

- `decisionState`: `open` or `locked`.
- `decisionSummary`: the concrete contract/algorithm/invariant chosen by the lead.
- `criticalDomain` and `criticalDomainReason`: whether the slice directly changes a core auth, authorization, tenant-isolation, payment-integrity, or data-integrity invariant.
- `atomic` and `atomicReason`: required justification for broad Terra High slices.

Routing is conservative:

- `OPEN`, architectural, critical-domain, or critical slices remain Terra High.
- A `LOCKED` complex/high slice may use Terra Medium only when it is bounded, non-architectural, non-critical-domain, and strongly verification-backed.
- Normal bounded decision execution remains Terra Medium.
- Simple/local/low-risk work remains eligible for Luna High.

A Terra High slice touching more than four files must be explicitly atomic. Otherwise the plan is rejected once and the lead receives a bounded refinement request.

## Predictive slice budget
The run budget is checked before each execution slice using a conservative lane-aware estimate. This prevents a run from reaching 4.3M input when the configured budget is 4M simply because the previous implementation only checked after the slice completed.

## Consequences
- Terra High is concentrated on unresolved judgment and core invariants.
- Terra Medium can safely execute more work after the lead has locked the decision.
- The planner must explain criticality and atomicity instead of treating them as inherited labels.
- There can be one extra lead turn when a returned plan violates deterministic decomposition rules; this is bounded to one refinement.
