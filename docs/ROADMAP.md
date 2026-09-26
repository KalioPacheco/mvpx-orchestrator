# MVPX Roadmap

## v0.4.13 — Fresh Targeted Repairs (stabilization candidate)

Goals:

- preserve v0.4.12 execution, routing, slicing, budgeting and evidence-aware classification unchanged;
- start targeted final-validation repair attempt 1 in a fresh bounded thread instead of inheriting large final-QA context;
- keep later repair attempts fresh as well, using a compact previous-attempt handoff rather than conversation history;
- cap repair project-memory handoff independently from normal implementation memory;
- measure repair cost separately without feeding those observations into implementation planning.

Exit criterion: run v0.4.13 across several real projects and confirm that final repairs remain focused, resumable and materially cheaper than resumed-thread repairs. If stability holds, freeze 0.4.x and move future architecture work to v0.5.

## v0.4.x — Mission UX / polish

After routing is validated:

- `mvpx new-goal` + mission archive;
- `mvpx doctor` for Node/Codex/PATH/runtime diagnostics;
- config validation/warnings;
- automatic benchmark snapshots and executive summaries.

## v0.5 — Controlled parallel worktrees

Only after adaptive single-worker efficiency is stable:

- dependency graph between work packages;
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
