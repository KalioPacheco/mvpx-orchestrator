# ADR-011: Verification-backed routing and predictive global budget

## Context

v0.4.8 improved hierarchical throughput on a critical payment-security milestone: lead + four remaining slices used 2.44M input tokens and 16 quota points. One `normal/medium` one-file slice correctly moved to Terra Medium, but two `complex/high` slices were only two files each and had strong targeted tests. They still used Terra High because high risk was an unconditional veto. Separately, the independent one-lead-per-run cap paused the next milestone even though the lead itself cost only ~330k input tokens.

## Decision

1. Keep Luna High strict for truly simple/local/low-risk work.
2. Keep bounded normal work on Terra Medium.
3. Permit `complex/high` work to start on Terra Medium only when all of the following are true:
   - no architecture change;
   - at most 2 estimated files by default;
   - a Terra High lead explicitly marks the slice `verificationBacked=true`;
   - `verificationEvidence` names concrete deterministic host-side checks that should catch an incorrect implementation.
4. A verification-backed Terra Medium failure escalates immediately to Terra High. Critical, architectural, broad, or unverifiable high-risk slices remain Terra High.
5. Remove the independent technical-lead turn cap. Lead turns consume the same global input budget as all other work.
6. Before starting a subsequent milestone in the same run, pause when `current run input + predicted next milestone input` would exceed the configured run budget. The first milestone of a fresh run is always allowed so a prediction cannot deadlock progress; between-slice actual budget checks still apply.
7. Re-refine unfinished pre-v0.4.9 slice plans once while preserving completed slices.

## Consequences

The lead continues to make the high-judgment architectural/security decision, while deterministic tests can safely back a cheaper implementation lane for ultra-bounded follow-up. The system avoids pausing merely because a lead was used and instead pauses for expected total cost. Misclassification risk is bounded by strict evidence requirements and immediate Terra High fallback.
