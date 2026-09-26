# MVPX Orchestrator

**Cost-aware autonomous orchestration for Codex.** MVPX turns a high-level software goal into bounded plans, execution slices, deterministic validation, targeted repairs, checkpoints, and resumable progress—without requiring a human to keep typing “continue”.

> **Status:** public beta / stabilization candidate (`v0.4.13`). The single-worker architecture is intentionally being stabilized before any parallel-worktree release.

MVPX is an independent open-source project. It is not affiliated with or endorsed by OpenAI.

## Why MVPX exists

Long-running agent work tends to fail in one of two ways: the human has to supervise every step, or the agent accumulates so much context that each next step becomes expensive and fragile. MVPX keeps the workflow autonomous while deliberately bounding context and cost.

```text
goal
  ↓
Luna Medium planner
  ↓
bounded milestones
  ↓
Terra High technical lead when work is broad/critical
  ↓
execution slices
  ├─ Luna High     simple/local
  ├─ Terra Medium  scoped or decision-complete
  └─ Terra High    open decision / critical invariant / architecture
  ↓
host-side deterministic gates
  ↓
fresh targeted repair only when a gate really fails
  ↓
done / resumable pause / explicit external blocker
```

## Highlights

- **Bounded context:** fresh implementation threads instead of one ever-growing project conversation.
- **Hierarchical decomposition:** broad work is split by a technical lead into buildable execution slices.
- **Adaptive model routing:** inexpensive models handle work only when the risk and scope justify it.
- **Decision-complete execution:** a lead can lock the hard decision so a cheaper worker executes the contract rather than re-solving the architecture.
- **Critical-domain protection:** auth, authorization, tenant isolation, payment integrity, and data integrity remain conservatively routed.
- **Cost-weighted run budgets:** MVPX predicts the next slice cost from project history and pauses before starting work likely to exceed the configured input budget.
- **Progress-aware activity guard:** healthy long tasks may continue; stalls and repeated loops are stopped without arbitrary low command limits.
- **Evidence-aware validation routing:** Jest/compiler/lint evidence is distinguished from genuine environment failures before spending AI quota.
- **Fresh targeted repairs:** every final-validation repair starts from a fresh thread with a compact repair contract.
- **Resumability:** checkpoints, interrupted-run recovery, frozen blockers, and durable project memory survive CLI restarts.
- **Host-side validation:** deterministic gates run outside the Codex sandbox before an AI repair is considered.

## Requirements

- macOS or Linux
- Node.js **>= 22.12**
- Git
- Codex CLI authenticated for the current user
- A target software repository managed by Git

Model availability can vary by Codex installation/account. The defaults are configurable in `.mvpx/config.json`.

## Install from source

```bash
git clone https://github.com/KalioPacheco/mvpx-orchestrator.git
cd mvpx-orchestrator
nvm use 22
npm install
npm link
mvpx --version
```

Expected for this release:

```text
0.4.13
```

`npm install` runs the `prepare` script and builds the TypeScript sources. The repository is intentionally not published to npm yet; cloning from GitHub is the supported public-beta installation path.

Run regression tests:

```bash
npm run selftest
```

## Quick start

From the repository you want MVPX to work on:

```bash
cd /path/to/your/repository
mvpx init
mvpx preflight
```

Create a mission:

```bash
mvpx analyze --goal "Audit this backend and make it production-ready without unnecessary rewrites."
mvpx run --max-tasks 10
```

Or create the initial plan directly from `run`:

```bash
mvpx run --goal "Implement the requested feature and leave all quality gates passing." --max-tasks 10
```

For long goals stored in a file, current shells can pass the file content directly:

```bash
mvpx analyze --goal "$(cat goal.md)"
```

A native `--goal-file` option is not part of v0.4.13 yet.

## Main commands

```text
mvpx init
mvpx preflight [--prepare]
mvpx analyze --goal "..."
mvpx run [--goal "..."] [--max-tasks N] [--max-milestones N]
         [--prepare] [--allow-dirty] [--retry-blocked]
mvpx status
mvpx usage [--last N]
mvpx cost [--last N]
mvpx blockers
mvpx unblock <milestone>
mvpx checkpoints
mvpx rollback <checkpoint>
```

## Local state

MVPX stores orchestration state in the target repository under:

```text
.mvpx/
├── config.json
├── state.json
├── PROJECT_MEMORY.md
├── DECISIONS.md
└── cost-history.json
```

`.mvpx/` should remain local to the target project. MVPX adds its state directory to the target repository's local Git exclude when initialized, and this repository also ignores `.mvpx/` defensively.

## Safety model

Implementation workers run with conservative defaults:

- workspace write access only;
- approvals disabled for unattended execution;
- network and web search disabled inside implementation workers;
- no automatic commit, push, deploy, secret modification, or destructive Git/data operations;
- hidden Git checkpoints under `refs/mvpx/checkpoints/...` without moving the user's branch or `HEAD`.

MVPX is still an automation layer around an AI coding agent. Review diffs before deploying or applying changes to sensitive production systems.

## Default routing policy

| Work | Default lane |
|---|---|
| Audit / planning / replanning | GPT-5.6 Luna, medium reasoning |
| Simple, local, low-risk slice | GPT-5.6 Luna, high reasoning |
| Scoped normal / decision-complete slice | GPT-5.6 Terra, medium reasoning |
| Technical lead / open design / architecture / critical invariant | GPT-5.6 Terra, high reasoning |
| Evidence-based rescue after repeated failure | GPT-6 Sol, high reasoning |

Routing is deliberately conservative. `normal` is the safe default, and critical-domain rules override cost optimization.

## Run budget and cost history

The default run budget is token-first rather than turn-count-first:

```json
{
  "runBudgetEnabled": true,
  "runBudgetMaxInputTokens": 4000000,
  "runBudgetPredictiveEnabled": true,
  "runBudgetMaxSolTurns": 1
}
```

Completed slices are recorded in `.mvpx/cost-history.json`. MVPX uses the closest historical lane/profile to estimate the next slice and pauses before starting work projected to exceed the configured run budget. Final-validation repair observations are tracked separately and do not influence implementation packaging predictions.

## Validation behavior

When implementation is complete, host-side quality gates run before any repair call. MVPX distinguishes explicit code/test evidence from environment/tooling failures:

```text
Jest assertion / TypeScript diagnostic / lint/compiler failure
→ code failure → targeted fresh repair

EADDRINUSE / explicit permission denial / required external service unavailable
→ environment failure → no blind AI repair

strong evidence on both sides
→ bounded classifier only to resolve ambiguity
```

A project with all implementation tasks complete but an unresolved final gate is reported as `validation_pending`, not as a contradictory task-level blocker.

## Benchmarks

The repository includes the development benchmark history in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

These are **observational development measurements**, not universal performance claims. The reported Codex usage-window percentages vary with repository size, task mix, model availability, cache behavior, and product limits. Use them to understand why architecture decisions were made—not as a billing or capacity guarantee.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Benchmarks and experiment history](docs/BENCHMARKS.md)
- [Operations and troubleshooting](docs/OPERATIONS.md)
- [Roadmap](docs/ROADMAP.md)
- [Architecture Decision Records](docs/adr/)
- [Public release checklist](docs/PUBLIC_RELEASE_CHECKLIST.md)

## Project maturity and roadmap

`v0.4.13` is the stabilization candidate for the single-worker architecture. The current rule is intentionally conservative: use the single-worker path across real projects and fix evidence-backed defects before adding parallel worktrees.

The next major architecture milestone (`v0.5`) is expected to explore parallel worktrees only after the 0.4.x path demonstrates stable daily use.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), run the self-tests before opening a PR, and add an ADR for changes that materially alter routing, safety, persistence, or execution semantics.

For security-sensitive issues, follow [`SECURITY.md`](SECURITY.md) rather than opening a public issue with exploit details.

## License

MVPX Orchestrator is released under the [MIT License](LICENSE).
