# ADR-010: Cheapest-safe slice routing

## Context

v0.4.7 safely decomposed a critical backend milestone, but a `normal/medium` four-file slice was still routed to Terra High because `crossModule=true` acted as an absolute veto. The lead also consumed the same Terra High run budget as implementation. Two completed slices plus lead cost 2.54M input tokens and 13 quota points.

## Decision

1. Classify child slices independently from parent milestone criticality.
2. Keep Luna High strict: simple + low-risk + local + no architecture change.
3. Route bounded simple/normal, medium-or-lower-risk, no-architecture-change slices to Terra Medium even if they cross a few layers.
4. Keep complex/critical, high-risk, or architecture-changing slices on Terra High.
5. Ask the lead to decompose for the cheapest safe execution model, separating tests, DTO/validation, migrations, adapters, and mechanical follow-up when independently buildable.
6. Allow up to 7 slices for predicted high-cost work.
7. Budget lead Terra High separately from implementation Terra High.
8. Re-refine pending pre-v0.4.8 slice plans while preserving completed slices.

## Consequences

The lead can spend one high-reasoning turn to make hard decisions, while bounded execution work can move to Terra Medium or Luna High. This may add slice overhead, so benchmarks must compare total quota and not just individual turn sizes.
