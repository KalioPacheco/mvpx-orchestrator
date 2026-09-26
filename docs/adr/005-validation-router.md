# ADR 005: Route validation failures before AI repair

## Status
Accepted in MVPX v0.4.3; classification precedence hardened by ADR-014 in v0.4.12.

## Context
In v0.4.2, final validation sent every failed gate directly to Terra. A real test failure was repaired, but a remaining `quality:ui` failure triggered additional multi-million-token Terra turns even when the cause could be environmental.

## Decision
Use deterministic classification first, Luna Medium only for ambiguous classification, host-only retry for potentially flaky gates, and Terra only for confirmed code/visual failures. Rerun only the failed gate after repair.

## Consequences
- Environment failures consume zero Terra repair calls.
- Flaky failures can recover with zero AI calls.
- Repair prompts are substantially smaller.
- A single final confirmation pass protects against regressions introduced by targeted repairs.
