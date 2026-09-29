# Operations and Troubleshooting

## Required Node version

MVPX v0.4.15 requires Node.js >= 22.12.

Recommended:

```bash
nvm use 22
node -v
```

If Node 20 is active, current dependencies may fail before the CLI starts. An observed symptom was an exception inside `execa/lib/arguments/encoding-option.js` around `Set.union(...)`.

## Install / relink

```bash
npm install
npm link
rehash  # useful in zsh if the shell cached command lookup
mvpx --version
```

If `mvpx` is not found:

```bash
npm prefix -g
ls -la "$(npm prefix -g)/bin/mvpx"
export PATH="$(npm prefix -g)/bin:$PATH"
rehash
```

## Before spending AI quota

```bash
mvpx preflight
```

If preparation is required:

```bash
mvpx preflight --prepare
```

## Starting another goal

Current workflow:

```bash
mvpx analyze --goal "NEW GOAL"
mvpx run --max-tasks 10
```

`analyze` replaces the active orchestration plan for the repository but does not undo product code changes.

A dedicated mission archive / `mvpx new-goal` command remains planned.

## Inspect state

```bash
mvpx status
mvpx usage --last 20
mvpx cost --last 20
mvpx blockers
mvpx checkpoints
```

## Blockers

External blockers are frozen. MVPX does not repeatedly ask a model to solve something reasoning cannot change.

After resolving the condition:

```bash
mvpx unblock M-005
mvpx run
```

Or explicitly retry all:

```bash
mvpx run --retry-blocked
```

## Progress-aware activity guard

The guard no longer treats a command count as a normal work budget. A package may legitimately execute 60, 80 or more commands if it keeps producing observable progress.

Defaults:

```text
50 commands       soft observation threshold (NO abort)
200 commands      hard circuit breaker
350 tool events   hard circuit breaker
120 changed files hard circuit breaker
24 commands + 3 min with no progress after soft threshold → stop
6 repeats of the same command with no progress → stop
25 minutes        hard duration
1 automatic bounded continuation
```

Progress resets the stagnation counter when MVPX observes:

- a file-change event;
- a newly completed todo item;
- a successful typecheck/test/lint/build/Playwright/quality command;
- a successful command that clearly writes/modifies files.

When tripped:

1. Codex execution is aborted;
2. current worktree changes are preserved;
3. MVPX records per-slice changed files separately from all files changed since the milestone checkpoint;
4. at most one fresh thread receives a concise continuation instruction;
5. a second guard trip pauses the milestone as `orchestration_budget`.

Aborted turns may consume Codex quota but do not always emit a `turn.completed` event, so token telemetry can under-report the cost of aborted slices. The CLI therefore also prints guard-trip counts and a **run delta** for completed-turn telemetry.

## Checkpoint rollback

List:

```bash
mvpx checkpoints
```

Restore:

```bash
mvpx rollback <checkpoint-id>
```

This restores the working tree without moving the current branch to the hidden checkpoint commit.

## Configuration

Edit:

```text
.mvpx/config.json
```

Important knobs:

```json
{
  "plannerModel": "gpt-5.6-luna",
  "plannerReasoningEffort": "medium",
  "adaptiveImplementerRouting": true,
  "simpleImplementerModel": "gpt-5.6-luna",
  "simpleImplementerReasoningEffort": "high",
  "simpleImplementerMaxEstimatedFiles": 6,
  "defaultModel": "gpt-5.6-terra",
  "defaultReasoningEffort": "high",
  "escalationModel": "gpt-6-sol",
  "escalationReasoningEffort": "high",
  "escalateAtAttempt": 3,
  "maxTasksPerMilestone": 2,
  "costAwareEstimatedFilesThreshold": 10,
  "costHistoryMaxRecords": 80,
  "replanEveryMilestones": 0,
  "memoryMaxChars": 18000,
  "finalRepairMemoryMaxChars": 6000,
  "guardSoftCommandThreshold": 50,
  "guardHardCommandLimit": 200,
  "guardHardToolEventLimit": 350,
  "guardHardFilesChangedLimit": 120,
  "guardMaxCommandsWithoutProgress": 24,
  "guardMaxRepeatedCommand": 6,
  "guardMaxNoProgressMs": 180000,
  "maxTurnDurationMs": 1500000,
  "maxGuardContinuations": 1
}
```

Do not tune all knobs after one run. Keep benchmark conditions stable long enough to identify which change actually helps.

## v0.4.11 token-first pauses

A normal run pause should now cite either the actual input budget, a projected input-budget overrun before the next milestone/slice, or the Sol escalation circuit breaker. `Terra High implementation budget reached` is a legacy v0.4.10 message and should not be emitted by v0.4.11. On first run after upgrade, MVPX may print that it learned historical completed slice-cost observations from existing state; this is expected and does not spend an AI turn.


## v0.4.12 final-validation evidence routing

If all tasks are complete but a final gate remains unresolved, `mvpx status` reports `validation_pending`. A Jest assertion, TypeScript diagnostic, lint diagnostic or compiler/runtime error is code evidence even when package-manager output also contains `ELIFECYCLE` or generic `command failed` text. A bare application identifier containing `sandbox` is not environmental; only explicit restriction/denial language is. Genuine mixed strong evidence is classified by Luna Medium.


## v0.4.13 fresh targeted repairs

Every targeted final-validation repair prints `[fresh thread]`, including attempt 1. This is intentional. Repair attempts do not resume each other; continuity is supplied by the current failure plus a compact summary of the immediately previous attempt. The default repair memory handoff is 6,000 characters and can be tuned with `finalRepairMemoryMaxChars` independently from `memoryMaxChars`.

`mvpx cost` now includes `FINAL-QA/<gate>#<attempt>` observations. These records are QA telemetry only and are excluded from planner/package cost profiles. A healthy pattern is that repeated targeted repairs remain bounded rather than growing with prior conversation history.


## v0.4.14 dependency scheduler

`internal_dependency` means the prerequisite exists in the current MVPX task graph. Do not manually unblock it. `mvpx blockers` shows the unresolved task IDs and MVPX automatically resumes the milestone when they complete.

`external_dependency` means the condition is outside the graph (for example an unavailable third-party service or artifact). Resolve that condition first, then use `mvpx unblock <milestone>` or `--retry-blocked` when appropriate.

The scheduler validates unknown IDs/self-dependencies/cycles and refuses to continue an invalid DAG.

## v0.4.15 wait-neutral retries

When a slice pauses on an internal/external/environment/user-action WAIT, rerun normally after the blocker clears. MVPX preserves the base route and does not charge that pause as an implementation failure. An actual model escalation is always logged with its reason. Existing v0.4.14 dependency waiters are normalized automatically.
