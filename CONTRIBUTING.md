# Contributing to MVPX Orchestrator

Thanks for helping improve MVPX.

## Development setup

Requirements:

- Node.js >= 22.12
- Git
- an authenticated Codex CLI for end-to-end local testing

```bash
nvm use 22
npm install
npm run typecheck
npm run selftest
```

For CLI development:

```bash
npm run dev -- --help
```

Or link the local CLI:

```bash
npm link
mvpx --version
```

## Pull requests

Keep pull requests narrow and explain the behavior change, not only the code change. Include:

1. the problem being solved;
2. the expected behavior before and after;
3. tests or a reproducible manual validation path;
4. any impact on model usage, safety, state migration, checkpoints, or resumability;
5. documentation updates when user-visible behavior changes.

Run before opening a PR:

```bash
npm run typecheck
npm run selftest
npm run build
```

## Architecture decisions

Add an ADR under `docs/adr/` when a change materially affects any of the following:

- model routing;
- context or cost strategy;
- state format/migration;
- Git checkpoint semantics;
- validation or blocker classification;
- safety boundaries;
- concurrency/parallelism.

Small bug fixes do not need an ADR.

## Safety and privacy

Do not commit:

- API keys, tokens, credentials, `.env` files, or private certificates;
- `.mvpx/` state from a real target repository;
- private project logs or customer code;
- user-specific absolute paths;
- production data or database dumps.

MVPX should not weaken target-project tests or quality gates merely to make a run pass.

## Scope

The 0.4.x line is a single-worker stabilization branch. Avoid adding parallel agents/worktrees to 0.4.x unless the roadmap explicitly changes after evidence from real usage.
