# ADR-015: Fresh Targeted Final-Validation Repairs

Status: Accepted in MVPX v0.4.13.

## Context

v0.4.12 correctly routed a real Jest failure as code and finished the backend mission, but repair attempt 1 reused accumulated final-QA context and consumed 1,631,843 input tokens without closing the gate. Attempt 2 rotated to a fresh thread after the high-context threshold and consumed 263,282 input tokens before the gate passed. The second attempt was roughly 84% cheaper in input.

A targeted repair already has an explicit host-side contract: the failing gate, current failure output, deterministic classification, affected-file hints, and a narrow instruction not to re-audit the repository. Reusing conversational history is therefore unnecessary and can dominate cost.

## Decision

Every targeted final-validation repair attempt starts in a fresh Codex thread, including attempt 1.

Cross-attempt continuity is explicit rather than conversational. Later attempts receive only the immediately previous repair summary, changed files, decisions, and the newly rerun gate failure. Project memory for final repairs is independently capped by `finalRepairMemoryMaxChars` (6,000 by default).

Repair costs are persisted as `validation-repair` observations with gate, attempt, model, usage and pass/fail result. They are excluded from planner and implementation cost profiles.

## Consequences

Benefits:

- repair context cannot grow merely because implementation or a previous repair was long;
- every attempt starts from the latest host evidence;
- repeated failed hypotheses can still be avoided via the compact previous-attempt handoff;
- QA repair cost becomes measurable independently of implementation cost.

Trade-offs:

- a fresh model may need to inspect a small amount of repository context again;
- details not included in durable memory or the repair contract are intentionally discarded;
- if a repair genuinely requires broad architectural context, the narrow contract may require a direct dependency inspection, but broad re-audit remains prohibited.

## Rejected alternative

Keep the v0.4.12 threshold-based rotation policy. The real benchmark showed that this waits until after the expensive repair has already been paid for, so it does not prevent the dominant cost.
