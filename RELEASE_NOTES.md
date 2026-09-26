# MVPX v0.4.13 — Public Beta: Fresh Targeted Repairs

This is the first public-beta release of MVPX Orchestrator, a local orchestration layer for Codex focused on bounded context, autonomous progress, model-cost-aware routing, deterministic validation, and resumable execution.

## What is included

- bounded planning and execution threads;
- hierarchical technical-lead decomposition for broad or critical work;
- Luna / Terra / Sol routing by risk and execution semantics;
- decision-complete execution so already-resolved work can use a cheaper lane safely;
- critical-domain protections for auth, tenant isolation, payments, and data integrity;
- predictive token-first run budgets backed by local cost history;
- progress-aware activity/stall detection;
- Git checkpoints and interrupted-run recovery;
- evidence-aware final validation routing;
- fresh targeted repair threads with compact cross-attempt handoff;
- durable project memory and explicit blocker handling;
- benchmark history and architecture decision records.

## Status

This is a **public beta / stabilization release**. The 0.4.x architecture is intentionally single-worker. Parallel worktrees are deferred until this path has been exercised across multiple real projects.

## Installation

```bash
git clone https://github.com/KalioPacheco/mvpx-orchestrator.git
cd mvpx-orchestrator
nvm use 22
npm install
npm link
mvpx --version
```

## Important notes

- Node.js >= 22.12 is required.
- Codex CLI authentication is required.
- Model availability may depend on the user's Codex environment/account.
- Development benchmark percentages in `docs/BENCHMARKS.md` are observational and are not billing/capacity guarantees.
- MVPX does not automatically commit, push, deploy, or modify secrets.

## Why v0.4.13

The final 0.4.x optimization starts every final-validation repair in a fresh thread. In the development benchmark that motivated the change, a resumed-context repair used ~1.63M input tokens while the following fresh-thread repair used ~263k and closed the failing gate. v0.4.13 makes fresh targeted repair the default from attempt one.

See `CHANGELOG.md` and `docs/adr/015-fresh-targeted-repairs.md` for details.
