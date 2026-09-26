# ADR 006 — Transport failures are not model failures

## Context

During M-006, Codex Exec exited before an agent thread started with:

`Codex Exec exited with code 1: Reading prompt from stdin...`

The official TypeScript SDK sends the prompt to the Codex CLI over stdin. A failure before any SDK event/thread start is therefore an infrastructure/transport failure, not evidence that the selected model could not solve the milestone.

## Decision

MVPX retries recognized pre-thread startup failures up to `maxTransportRetries` (default: 2). These retries:

- do not increment milestone AI attempts;
- do not trigger Terra → Sol escalation;
- reuse the existing milestone checkpoint;
- do not create a continuation/handoff because no agent work started.

If all transport retries fail, the milestone is returned to `todo` and remains safe to retry later.

## Consequence

Model escalation now reflects actual model failures rather than CLI/session/network startup noise.
