# ADR-001: Use bounded contexts instead of one thread per task or one global thread

**Status:** Accepted

## Context

v0.2 used a fresh thread per task and consumed excessive quota rediscovering repository context. v0.3 used one persistent thread and achieved ~94% caching, but later turns grew to millions of input tokens and the run accumulated ~80M input tokens.

## Decision

Use separate roles/contexts:

- one audit thread for a new goal;
- fresh stateless replan threads;
- fresh implementation thread per small work package;
- repair may resume only the current package thread when sensible;
- durable knowledge is persisted in bounded project memory.

## Consequences

Positive:

- prevents unbounded history growth;
- avoids full repository rediscovery per individual task;
- makes context cost easier to reason about;
- supports future parallel isolation.

Tradeoff:

- fresh packages may have lower cache ratios;
- requires explicit memory/handoff design.

Optimization metric is total usage per useful completed work, not cache percentage alone.
