# Public Release Checklist

Use this before making the repository public or creating a GitHub release.

## Repository hygiene

- [x] No known API keys, credentials, personal absolute paths, private project names, or customer data in the current source tree.
- [x] `.mvpx/`, `.env*`, logs, editor files, and generated build output are ignored.
- [x] MIT license added.
- [x] Security and contribution guidance added.
- [x] GitHub issue/PR templates added.
- [x] CI workflow added.
- [x] Dependabot configuration added.
- [ ] Run a fresh secret scan after `git init` / before the first public push, including Git history if any history is imported.

## Build / test

- [ ] `nvm use 22`
- [ ] `npm install` or `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run selftest`
- [ ] `npm run build`
- [ ] `mvpx --version` prints `0.4.15`
- [ ] Smoke-test `mvpx init`, `mvpx preflight`, and `mvpx status` in a disposable Git repository.

## Dependency / legal checks

- [ ] Review dependency licenses from the npm registry before any npm publication. This workspace could not reach the registry during the open-source audit, so no third-party license claims were invented.
- [ ] Review GitHub's dependency graph after the first push.
- [ ] Keep model/provider trademarks factual; MVPX is independent and not endorsed by OpenAI.

## GitHub setup

Recommended repository name: `mvpx-orchestrator` (or the shorter `mvpx` if available).

Suggested description:

> Cost-aware autonomous orchestration for Codex: bounded planning, model routing, resumable execution, validation, and targeted repair.

Suggested topics:

```text
codex
ai-agents
agent-orchestration
coding-agent
typescript
cli
developer-tools
llm
software-engineering
```

Recommended settings:

- default branch: `main`;
- enable Issues;
- enable Discussions only if you want to support community Q&A;
- enable private vulnerability reporting / security advisories;
- enable secret scanning and push protection when available;
- enable dependency graph / Dependabot alerts;
- require CI on pull requests once the workflow has passed at least once.

## Initial release

Recommended tag: `v0.4.15`

Recommended release title:

> MVPX v0.4.15 — Public Beta: Wait-Neutral Attempts

Mark the GitHub release as **pre-release** rather than changing the CLI/package semver. Use `RELEASE_NOTES.md` as the release body.

## npm

Do not publish to npm as part of the initial GitHub release. The current package is marked `private` to prevent accidental publication. Remove that guard only in a deliberate npm-release change that adds reproducible package metadata, a lockfile/publish test, and verified dependency licensing.
