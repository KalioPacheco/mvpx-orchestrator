#!/usr/bin/env node
import { Command } from "commander";
import { CodexRunner } from "./codex/runner.js";
import { costProfileForPlanner, loadCostHistory, summarizeCostHistory } from "./cost/history.js";
import { unresolvedMilestoneDependencies } from "./dependencies.js";
import { rollbackToCheckpoint } from "./git/checkpoints.js";
import { refreshMemoryFiles } from "./memory/store.js";
import { runOrchestrator } from "./orchestrator.js";
import { runPreflight } from "./preflight/index.js";
import { loadConfig, loadState, saveConfig, saveState } from "./state/store.js";
import { createInitialState } from "./supervisor.js";
import { ensureMvpxLocallyIgnored, isGitDirty, resolveProjectRoot } from "./utils/project.js";
import type { Milestone, ProjectState, UsageTotals } from "./types.js";

const program = new Command();

function printPreflight(report: Awaited<ReturnType<typeof runPreflight>>): void {
  if (report.packageManager) console.log(`Package manager: ${report.packageManager}`);
  for (const item of report.prepared) console.log(`✓ Prepared: ${item}`);
  for (const issue of report.issues) {
    const icon = issue.severity === "blocking" ? "⛔" : "ℹ";
    console.log(`${icon} ${issue.message}`);
    if (issue.remediation) console.log(`   ${issue.remediation}`);
  }
  if (report.ok) console.log("✓ Preflight ready");
}

function printUsage(state: ProjectState, label = "Cumulative usage"): void {
  const u = state.usage;
  const cachePct = u.inputTokens > 0 ? Math.round((u.cachedInputTokens / u.inputTokens) * 100) : 0;
  console.log(`${label}: ${u.turns} completed AI turn(s)`);
  console.log(`  Input: ${u.inputTokens.toLocaleString()} | Cached: ${u.cachedInputTokens.toLocaleString()} (${cachePct}%) | Cache writes: ${u.cacheWriteInputTokens.toLocaleString()}`);
  console.log(`  Output: ${u.outputTokens.toLocaleString()} | Reasoning: ${u.reasoningOutputTokens.toLocaleString()}`);
}

function emptyUsage(): UsageTotals {
  return { turns: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

function usageDelta(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    turns: Math.max(0, after.turns - before.turns),
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    cachedInputTokens: Math.max(0, after.cachedInputTokens - before.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, after.cacheWriteInputTokens - before.cacheWriteInputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    reasoningOutputTokens: Math.max(0, after.reasoningOutputTokens - before.reasoningOutputTokens),
  };
}

function printRunDelta(before: UsageTotals, after: UsageTotals, guardTrips: number): void {
  const delta = usageDelta(after, before);
  const cachePct = delta.inputTokens > 0 ? Math.round((delta.cachedInputTokens / delta.inputTokens) * 100) : 0;
  console.log(`Run delta: ${delta.turns} completed AI turn(s) | ${guardTrips} guard trip(s)`);
  console.log(`  Input: ${delta.inputTokens.toLocaleString()} | Cached: ${delta.cachedInputTokens.toLocaleString()} (${cachePct}%)`);
  console.log(`  Output: ${delta.outputTokens.toLocaleString()} | Reasoning: ${delta.reasoningOutputTokens.toLocaleString()}`);
  if (guardTrips > 0) console.log("  Note: aborted guard slices may consume quota but do not always emit turn.completed token telemetry.");
}

function printGuardConfig(config: Awaited<ReturnType<typeof loadConfig>>): void {
  console.log(
    `  Progress guard: soft ${config.guardSoftCommandThreshold} commands (monitor only) | ` +
    `hard ${config.guardHardCommandLimit} | stall ${config.guardMaxCommandsWithoutProgress} commands + ` +
    `${Math.round(config.guardMaxNoProgressMs / 60000)} min no progress | repeat ${config.guardMaxRepeatedCommand}x | ` +
    `hard duration ${Math.round(config.maxTurnDurationMs / 60000)} min | ${config.maxGuardContinuations} continuation(s)`,
  );
}

function milestoneIcon(milestone: Milestone): string {
  if (milestone.status === "done") return "✓";
  if (milestone.status === "waiting") return "⏸";
  if (milestone.status === "blocked") return "⛔";
  if (milestone.status === "running") return "▶";
  if (milestone.status === "superseded") return "–";
  return "·";
}

function resetMilestone(state: ProjectState, milestone: Milestone): void {
  milestone.status = "todo";
  milestone.blocker = undefined;
  milestone.blockerType = undefined;
  milestone.threadId = undefined;
  milestone.lastTurnInputTokens = undefined;
  milestone.attempts = 0;
  for (const id of milestone.taskIds) {
    const task = state.tasks.find((item) => item.id === id);
    if (task && (task.status === "waiting" || task.status === "blocked")) {
      task.status = "todo";
      task.blocker = undefined;
      task.blockerType = undefined;
      task.attempts = 0;
    }
  }
}

program
  .name("mvpx")
  .description("Bounded-context, checkpointed Codex orchestration for software repositories")
  .version("0.4.15");

program
  .command("init")
  .argument("[directory]", "Git repository to initialize", ".")
  .description("Create .mvpx configuration in a repository")
  .action(async (directory: string) => {
    const root = await resolveProjectRoot(directory);
    await ensureMvpxLocallyIgnored(root);
    const config = await loadConfig(root);
    await saveConfig(root, config);
    console.log(`✓ MVPX initialized in ${root}`);
    console.log(`  Config: ${root}/.mvpx/config.json`);
    console.log(`  Planner: ${config.plannerModel} (${config.plannerReasoningEffort})`);
    console.log(`  Simple slice: ${config.simpleImplementerModel} (${config.simpleImplementerReasoningEffort})`);
    console.log(`  Scoped / decision-complete slice: ${config.scopedImplementerModel} (${config.scopedImplementerReasoningEffort})`);
    console.log(`  Technical lead / critical slice: ${config.leadModel} (${config.leadReasoningEffort}) / ${config.defaultModel} (${config.defaultReasoningEffort})`);
    console.log(`  Escalation: ${config.escalationModel} (${config.escalationReasoningEffort}) at attempt ${config.escalateAtAttempt}`);
    console.log(`  Work packages: max ${config.maxTasksPerMilestone} task(s); broad work decomposes into <=${config.maxSlicesPerMilestone} slices (<=${config.highCostMaxSlicesPerMilestone} when predicted high-cost)`);
    console.log(`  Run budget: ${config.runBudgetEnabled ? `${config.runBudgetMaxInputTokens.toLocaleString()} input tokens${config.runBudgetPredictiveEnabled ? " + cost-weighted predictive slice guard" : ""} / ${config.runBudgetMaxSolTurns} Sol turn(s); normal model lanes are token-budgeted` : "disabled"}`);
    printGuardConfig(config);
    console.log(`  Memory budget: ${config.memoryMaxChars.toLocaleString()} chars`);
  });

program
  .command("preflight")
  .argument("[directory]", "Git repository to check", ".")
  .option("--prepare", "Install missing project dependencies and Playwright Chromium when detected", false)
  .description("Check local prerequisites without spending an AI turn")
  .action(async (directory: string, options: { prepare?: boolean }) => {
    const root = await resolveProjectRoot(directory);
    const report = await runPreflight(root, Boolean(options.prepare));
    printPreflight(report);
    if (!report.ok) process.exitCode = 2;
  });

program
  .command("analyze")
  .argument("[directory]", "Git repository to analyze", ".")
  .requiredOption("-g, --goal <goal>", "Overall project goal")
  .option("--prepare", "Prepare missing dependencies before analysis", false)
  .description("Audit once and create a milestone-based bounded-context backlog")
  .action(async (directory: string, options: { goal: string; prepare?: boolean }) => {
    const root = await resolveProjectRoot(directory);
    await ensureMvpxLocallyIgnored(root);
    const report = await runPreflight(root, Boolean(options.prepare));
    printPreflight(report);
    if (!report.ok) throw new Error("Preflight has blocking issues. Resolve them before spending an AI planning turn.");

    const config = await loadConfig(root);
    await saveConfig(root, config);
    console.log(`Analyzing repository once with planner ${config.plannerModel} (${config.plannerReasoningEffort})...`);
    const costProfile = await costProfileForPlanner(root);
    const runner = new CodexRunner(root, config, costProfile);
    const state = await createInitialState(root, options.goal, runner);
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);

    console.log(`✓ Plan created: ${state.milestones.length} milestones / ${state.tasks.length} tasks`);
    for (const milestone of state.milestones) {
      console.log(`  ${milestone.id}  P${milestone.priority}  ${milestone.title} (${milestone.taskIds.length} tasks)`);
    }
    console.log("  Audit thread closed; implementation will use fresh bounded milestone threads.");
    printUsage(state);
  });

program
  .command("run")
  .argument("[directory]", "Git repository to run against", ".")
  .option("-g, --goal <goal>", "Goal used when no backlog exists")
  .option("--max-tasks <count>", "Soft maximum underlying tasks to complete this run", (value: string) => Number.parseInt(value, 10))
  .option("--max-milestones <count>", "Maximum milestones to complete this run", (value: string) => Number.parseInt(value, 10))
  .option("--allow-dirty", "Allow the first MVPX run to start from a dirty Git worktree", false)
  .option("--prepare", "Install missing project dependencies and Playwright Chromium during preflight", false)
  .option("--retry-blocked", "Explicitly retry all previously waiting/blocked milestones", false)
  .description("Continue bounded milestone execution until done, waiting, blocked, or the run limit is reached")
  .action(async (directory: string, options: {
    goal?: string;
    maxTasks?: number;
    maxMilestones?: number;
    allowDirty?: boolean;
    prepare?: boolean;
    retryBlocked?: boolean;
  }) => {
    const root = await resolveProjectRoot(directory);
    await ensureMvpxLocallyIgnored(root);

    const report = await runPreflight(root, Boolean(options.prepare));
    printPreflight(report);
    if (!report.ok) throw new Error("Preflight has blocking issues. Resolve them or rerun with --prepare; no AI quota was spent.");

    const config = await loadConfig(root);
    await saveConfig(root, config);

    let state = await loadState(root);
    const usageBeforeRun = state ? { ...state.usage } : emptyUsage();
    const guardTripsBeforeRun = state?.milestones.reduce((sum, milestone) => sum + (milestone.guardTrips ?? 0), 0) ?? 0;
    if (!state && !options.allowDirty && await isGitDirty(root)) {
      throw new Error("Git worktree is dirty. Commit/stash your changes first, or explicitly pass --allow-dirty.");
    }

    if (!state) {
      if (!options.goal) throw new Error("No .mvpx/state.json exists. Pass --goal or run mvpx analyze first.");
      console.log("No plan found. Performing the one-time repository audit...");
      const costProfile = await costProfileForPlanner(root);
      const runner = new CodexRunner(root, config, costProfile);
      state = await createInitialState(root, options.goal, runner);
      await refreshMemoryFiles(state, config.memoryMaxChars);
      await saveState(state);
      console.log(`✓ Plan created: ${state.milestones.length} milestones / ${state.tasks.length} tasks`);
    } else {
      await refreshMemoryFiles(state, config.memoryMaxChars);
      await saveState(state); // Persists any legacy -> v0.4.2 migration immediately.
    }

    console.log("Context policy: dependency-aware DAG + bounded decision-complete slices + scoped execution + progress-aware activity guard");
    console.log(`Planner: ${config.plannerModel} (${config.plannerReasoningEffort})`);
    console.log(`Simple slice: ${config.simpleImplementerModel} (${config.simpleImplementerReasoningEffort})`);
    console.log(`Scoped / decision-complete slice: ${config.scopedImplementerModel} (${config.scopedImplementerReasoningEffort})`);
    console.log(`Technical lead / critical: ${config.leadModel} (${config.leadReasoningEffort}) / ${config.defaultModel} (${config.defaultReasoningEffort})`);
    console.log(`Escalation: ${config.escalationModel} (${config.escalationReasoningEffort})`);
    console.log(`Work package: max ${config.maxTasksPerMilestone} task(s) | slices <= ${config.maxSlicesPerMilestone} (<=${config.highCostMaxSlicesPerMilestone} high-cost) | Memory: ${config.memoryMaxChars.toLocaleString()} chars`);
    console.log(`Run budget: ${config.runBudgetEnabled ? `${config.runBudgetMaxInputTokens.toLocaleString()} input${config.runBudgetPredictiveEnabled ? " + cost-weighted predictive" : ""} | ${config.runBudgetMaxSolTurns} Sol turn(s) | Luna/Terra lanes governed by token cost` : "disabled"}`);
    printGuardConfig(config);

    const finalState = await runOrchestrator(state, {
      maxTasks: options.maxTasks,
      maxMilestones: options.maxMilestones,
      retryBlocked: options.retryBlocked,
    });
    const done = finalState.tasks.filter((task) => task.status === "done").length;
    const waiting = finalState.tasks.filter((task) => task.status === "waiting").length;
    const blocked = finalState.tasks.filter((task) => task.status === "blocked").length;
    const remaining = finalState.tasks.filter((task) => task.status === "todo" || task.status === "failed" || task.status === "running").length;

    const guardTripsAfterRun = finalState.milestones.reduce((sum, milestone) => sum + (milestone.guardTrips ?? 0), 0);
    console.log(`\nMVPX status: ${finalState.status}`);
    console.log(`Done: ${done} | Waiting: ${waiting} | Blocked: ${blocked} | Remaining: ${remaining}`);
    if (finalState.status === "validation_pending") console.log("Final validation: PENDING");
    printRunDelta(usageBeforeRun, finalState.usage, Math.max(0, guardTripsAfterRun - guardTripsBeforeRun));
    printUsage(finalState);
    if (finalState.lastMessage) console.log(finalState.lastMessage);
  });

program
  .command("status")
  .argument("[directory]", "Git repository", ".")
  .description("Show milestones, tasks and cumulative Codex token usage")
  .action(async (directory: string) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state) {
      console.log("MVPX has no state for this repository.");
      return;
    }

    console.log(`Goal: ${state.goal}`);
    console.log(`Status: ${state.status}`);
    if (state.status === "validation_pending") console.log(`Final validation: PENDING${state.lastMessage ? ` — ${state.lastMessage.split("\n")[0]}` : ""}`);
    console.log("Context: bounded/scoped; fresh implementation thread per work package");
    console.log(`Updated: ${state.updatedAt}`);
    for (const milestone of state.milestones) {
      console.log(`${milestoneIcon(milestone)} ${milestone.id} [${milestone.status}] ${milestone.title}`);
      for (const id of milestone.taskIds) {
        const task = state.tasks.find((item) => item.id === id);
        if (task) {
          const deps = (task.dependsOnTaskIds ?? []).length > 0 ? ` | depends on ${(task.dependsOnTaskIds ?? []).join(", ")}` : "";
          console.log(`    ${task.status === "done" ? "✓" : task.status === "waiting" ? "⏸" : "·"} ${task.id} [${task.status}] ${task.title}${deps}`);
        }
      }
      if ((milestone.fileScope ?? []).length > 0) console.log(`    Scope: ${milestone.fileScope!.join(", ")}`);
      console.log(`    Route: ${milestone.complexity ?? "normal"}/${milestone.risk ?? "medium"} | ${milestone.implementationLane ?? "unassigned"} | ~${milestone.estimatedFiles ?? "?"} files${milestone.predictedInputTokens ? ` | predicted ~${Math.round(milestone.predictedInputTokens / 1000).toLocaleString()}k input` : ""}`);
      for (const slice of milestone.executionSlices ?? []) {
        console.log(`      ${slice.status === "done" ? "✓" : slice.status === "waiting" ? "⏸" : "·"} ${slice.id} [${slice.status}] ${slice.lane ?? "unrouted"} ${slice.complexity}/${slice.risk} ~${slice.estimatedFiles} files — ${slice.title}`);
      }
      if ((milestone.guardTrips ?? 0) > 0) console.log(`    Guard trips: ${milestone.guardTrips}${milestone.lastGuardReason ? ` (${milestone.lastGuardReason})` : ""}`);
      if (milestone.blocker) console.log(`    Blocker [${milestone.blockerType ?? "unknown"}]: ${milestone.blocker.split("\n")[0]}`);
    }
    printUsage(state);
  });

program
  .command("usage")
  .argument("[directory]", "Git repository", ".")
  .option("--last <count>", "Show only the last N AI turns", (value: string) => Number.parseInt(value, 10), 20)
  .description("Show per-turn token usage to benchmark MVPX context efficiency")
  .action(async (directory: string, options: { last: number }) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state) throw new Error("No MVPX state exists for this repository.");
    const rows = state.usageHistory.slice(-Math.max(1, options.last));
    for (const row of rows) {
      const cachePct = row.inputTokens > 0 ? Math.round((row.cachedInputTokens / row.inputTokens) * 100) : 0;
      console.log(`${row.at}  ${row.phase}`);
      console.log(`  ${row.model}${row.reasoningEffort ? ` (${row.reasoningEffort})` : ""} | in ${row.inputTokens.toLocaleString()} | cached ${cachePct}% | out ${row.outputTokens.toLocaleString()} | reasoning ${row.reasoningOutputTokens.toLocaleString()}`);
      if (row.threadId) console.log(`  thread ${row.threadId}`);
    }
    console.log("");
    printUsage(state);
  });

program
  .command("cost")
  .argument("[directory]", "Git repository", ".")
  .option("--last <count>", "Show only the last N cost observations", (value: string) => Number.parseInt(value, 10), 20)
  .description("Show historical package/slice/validation-repair cost observations; repair telemetry is excluded from implementation planning")
  .action(async (directory: string, options: { last: number }) => {
    const root = await resolveProjectRoot(directory);
    const rows = await loadCostHistory(root);
    if (rows.length === 0) {
      console.log("No MVPX cost observations yet.");
      return;
    }
    const selected = rows.slice(-Math.max(1, options.last));
    for (const row of selected) {
      const cachePct = row.inputTokens > 0 ? Math.round((row.cachedInputTokens / row.inputTokens) * 100) : 0;
      const subject = row.recordType === "slice"
        ? `${row.milestoneId}/${row.sliceId ?? "slice"}`
        : row.recordType === "validation-repair"
          ? `FINAL-QA/${row.gateName ?? "gate"}#${row.repairAttempt ?? "?"}`
          : row.milestoneId;
      const kind = row.recordType === "slice"
        ? `slice ${row.lane ?? "unknown-lane"}`
        : row.recordType === "validation-repair"
          ? `validation repair ${row.success ? "passed" : "still failing"}`
          : `${row.taskCount} task(s)`;
      console.log(`${row.at}  ${subject}  ${row.complexity}/${row.risk}  ${kind}`);
      console.log(`  models ${row.models.join(" → ") || "unknown"} | in ${row.inputTokens.toLocaleString()} | cached ${cachePct}% | files ${row.changedFiles}`);
      console.log(`  ${row.title}`);
    }
    console.log("\nPlanner cost profile:\n" + summarizeCostHistory(rows));
  });

program
  .command("blockers")
  .argument("[directory]", "Git repository", ".")
  .description("Show frozen blockers without retrying them")
  .action(async (directory: string) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state) throw new Error("No MVPX state exists for this repository.");
    const blocked = state.milestones.filter((m) => m.status === "waiting" || m.status === "blocked");
    if (blocked.length === 0) {
      console.log("No waiting/blocked milestones.");
      return;
    }
    for (const milestone of blocked) {
      console.log(`${milestone.id} [${milestone.blockerType ?? "unknown"}] ${milestone.title}`);
      console.log(`  ${milestone.blocker ?? "No blocker detail."}`);
      if (milestone.blockerType === "internal_dependency") {
        const unresolved = unresolvedMilestoneDependencies(state, milestone);
        console.log(`  Internal prerequisites: ${unresolved.join(", ") || "already satisfied; next run will auto-resume"}`);
        console.log("  No manual retry required; MVPX resumes automatically when prerequisites are done.");
      } else {
        console.log(`  Retry only after external resolution: mvpx unblock ${milestone.id}`);
      }
    }
  });

program
  .command("unblock")
  .argument("<milestone>", "Waiting/blocked milestone ID")
  .argument("[directory]", "Git repository", ".")
  .description("Explicitly mark one blocker as resolved so MVPX can retry it")
  .action(async (milestoneId: string, directory: string) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state) throw new Error("No MVPX state exists for this repository.");
    const milestone = state.milestones.find((item) => item.id === milestoneId);
    if (!milestone) throw new Error(`Unknown milestone: ${milestoneId}`);
    if (milestone.status !== "waiting" && milestone.status !== "blocked") {
      throw new Error(`${milestoneId} is not waiting/blocked.`);
    }
    if (milestone.blockerType === "internal_dependency") {
      throw new Error(`${milestoneId} is waiting on internal prerequisites and will resume automatically; manual unblock is not needed.`);
    }
    resetMilestone(state, milestone);
    state.status = "idle";
    state.lastMessage = `${milestoneId} explicitly unblocked; it can be retried on the next run.`;
    const config = await loadConfig(root);
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);
    console.log(`✓ ${milestoneId} unblocked. Run 'mvpx run' to retry it.`);
  });

program
  .command("checkpoints")
  .argument("[directory]", "Git repository", ".")
  .description("List internal MVPX Git checkpoints")
  .action(async (directory: string) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state || state.checkpoints.length === 0) {
      console.log("No MVPX checkpoints exist for this repository.");
      return;
    }
    for (const checkpoint of state.checkpoints) {
      console.log(`${checkpoint.id}  ${checkpoint.commit.slice(0, 10)}  ${checkpoint.milestoneId}  ${checkpoint.createdAt}`);
    }
  });

program
  .command("rollback")
  .argument("<checkpoint>", "Checkpoint ID shown by mvpx checkpoints")
  .argument("[directory]", "Git repository", ".")
  .description("Explicitly restore the worktree to an MVPX checkpoint")
  .action(async (checkpointId: string, directory: string) => {
    const root = await resolveProjectRoot(directory);
    const state = await loadState(root);
    if (!state) throw new Error("No MVPX state exists for this repository.");
    const checkpoint = state.checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);
    await rollbackToCheckpoint(root, checkpoint);
    state.status = "idle";
    state.lastMessage = `Worktree manually restored to ${checkpoint.id}.`;
    await saveState(state);
    console.log(`✓ Restored ${checkpoint.id}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`\nMVPX error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
