# MVPX Roadmap

## v0.4.15 — Wait-Neutral Attempts (stabilization candidate)

Goals:

- execute a validated task DAG rather than priority-only milestone ordering;
- distinguish internal prerequisites from true external intervention;
- auto-resume downstream work after prerequisites finish;
- preserve v0.4.13 routing, slicing, budgeting, validation and repair behavior unchanged.

Exit criterion: use v0.4.15 across real repositories and confirm that internal prerequisites never require manual retry and that no downstream milestone executes before its declared dependencies. If stable, freeze 0.4.x and move parallel-worktree work to v0.5.

## v0.4.x — Mission UX / polish

After routing is validated:

- `mvpx new-goal` + mission archive;
- `mvpx doctor` for Node/Codex/PATH/runtime diagnostics;
- config validation/warnings;
- automatic benchmark snapshots and executive summaries.

## v0.5 — Controlled parallel worktrees

Only after adaptive single-worker efficiency is stable:

- use the stable v0.4.15 single-worker DAG to identify independent work packages;
- max 2 parallel workers initially;
- isolated Git worktrees;
- integration stage;
- conflict detection;
- internal usage budget.

Parallelism must never be used to hide inefficient single-worker behavior.

## v0.6 — Intelligent supervisor

Potential capabilities:

- deterministic already-satisfied checks;
- richer uncertainty signals;
- budget-aware optional polish;
- semantic gate-to-file targeting;
- learn routing thresholds from cost/fallback history while keeping hard safety rules.

## v0.7 — Skills and project policy

- required skills by mission type;
- repository-specific policy file;
- explicit forbidden actions;
- skill propagation into every derived work package;
- quality profiles per stack/product.

## v1.0 — Stable autonomous workflow

Target:

```bash
mvpx new-goal "Leave this product ready to sell"
mvpx run
```

Desired properties: autonomous plan→implement→validate→repair→finish, few genuine human interventions, predictable usage, reversible changes, explainable model routing and strong final evidence.
