# ADR-014: Evidence-Aware Validation Routing

## Status
Accepted in MVPX v0.4.12.

## Context
The v0.4.11 backend benchmark completed all planned work efficiently (13 quota points, 9 AI turns, 1.61M input, 0 guard trips), then final Jest validation reported 17 failing tests. The failure contained explicit `Expected`/`Received` assertion diffs, yet MVPX classified it as `environment (100%)`. The root cause was an overly broad environment pattern: the bare word `sandbox` matched application identifiers such as `SandboxBillingProviderService`. Generic package-manager epilogues such as `ELIFECYCLE` are also unsuitable as root-cause evidence.

## Decision
Validation classification uses evidence precedence:

1. Strong visual evidence routes to `visual`.
2. Strong code evidence (Jest assertion/diff, failed-suite summary with assertion stack, TypeScript diagnostic, compiler/lint/runtime diagnostic) routes to `code`.
3. Strong environment evidence must be specific (permissions, port binding, missing executable/browser, explicitly blocked network, explicit sandbox restriction).
4. Strong code + strong environment is ambiguous and delegates to Luna Medium.
5. Transient and weak code signatures are evaluated only after strong evidence.
6. `ELIFECYCLE`, generic exit-code text and `command failed` are neutral wrappers.
7. A bare `sandbox` token is never sufficient environment evidence.

When all implementation tasks are done but final validation remains unresolved, project status is `validation_pending`, not task-level `blocked`.

## Consequences
- Application test failures no longer freeze merely because an identifier contains `sandbox`.
- Real host/tooling failures still avoid expensive repair turns.
- Ambiguous mixed failures keep the cheap Luna classifier as a safe fallback.
- Project status accurately distinguishes implementation blockers from final-quality-gate debt.
