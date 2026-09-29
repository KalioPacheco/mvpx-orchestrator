import { inferBlockerType, gateFailureLooksEnvironmental } from "./blockers.js";
import { isWaitNeutralBlocker, neutralizeMilestoneWaitAttempt, neutralizeSliceWaitAttempt, prepareMilestoneAfterWait, prepareSliceAfterWait } from "./attempts.js";
import { assertValidDependencyGraph, reconcileInternalDependencies, registerRuntimeInternalDependencies, unresolvedMilestoneDependencies } from "./dependencies.js";
import { CodexRunner, CodexTransportStartupError, TurnGuardExceededError, type FinalRepairResponse, type MilestoneResponse, type RunnerResult, type SlicePlanResponse, type SliceResponse } from "./codex/runner.js";
import { createCheckpoint, listChangesSinceCheckpoint, rollbackToCheckpoint } from "./git/checkpoints.js";
import { backfillSliceCostHistory, costProfileForPlanner, estimateMilestoneInputTokens, estimateSliceInputTokens, loadCostHistory, recordMilestoneCost, recordSliceCost, recordValidationRepairCost } from "./cost/history.js";
import { refreshMemoryFiles, renderProjectMemory } from "./memory/store.js";
import { formatGateFailure, formatGateFailures, runQualityGate, runQualityGates } from "./quality/gates.js";
import { classifyGateDeterministically, shouldRetryWithoutAi, validationKindToBlocker } from "./quality/validation.js";
import { loadConfig, saveState } from "./state/store.js";
import { applyReplan, nextMilestone } from "./supervisor.js";
import type { BlockerType, CostHistoryRecord, ExecutionSlice, GateResult, Milestone, ProjectConfig, ProjectState, UsageTotals, ValidationClassification } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function addUsage(target: UsageTotals, delta: UsageTotals): void {
  target.turns += delta.turns;
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.cacheWriteInputTokens += delta.cacheWriteInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
}

function recordUsage<T>(state: ProjectState, turn: RunnerResult<T>, phase: string, config: ProjectConfig): void {
  addUsage(state.usage, turn.usage);
  state.usageHistory.push({
    ...turn.usage,
    at: new Date().toISOString(),
    phase,
    model: turn.selection.model,
    reasoningEffort: turn.selection.reasoningEffort,
    threadId: turn.threadId,
  });

  const cachePct = turn.usage.inputTokens > 0
    ? Math.round((turn.usage.cachedInputTokens / turn.usage.inputTokens) * 100)
    : 0;
  console.log(
    `  Usage: in ${turn.usage.inputTokens.toLocaleString()} | cached ${turn.usage.cachedInputTokens.toLocaleString()} (${cachePct}%) | ` +
    `out ${turn.usage.outputTokens.toLocaleString()} | reasoning ${turn.usage.reasoningOutputTokens.toLocaleString()}`,
  );
  if (turn.usage.inputTokens > config.maxTurnInputTokens) {
    console.log(
      `  ℹ High-context turn detected (${turn.usage.inputTokens.toLocaleString()} > ${config.maxTurnInputTokens.toLocaleString()} reference threshold); ` +
      `future repair work will rotate to a fresh bounded thread.`,
    );
  }
}

function logModel(runner: CodexRunner, milestone: Milestone, phase: "execute" | "repair" = "execute"): void {
  const selection = phase === "execute" ? runner.implementationModel(milestone) : runner.milestoneRepairModel(milestone);
  const lane = phase === "execute" && runner.qualifiesForSimpleLane(milestone) ? " [SIMPLE→LUNA]" : "";
  console.log(`  AI: ${selection.model} (${selection.reasoningEffort})${lane}${selection.escalated ? " [ESCALATED]" : ""}`);
}


function unresolvedTasksInMilestone(state: ProjectState, milestone: Milestone): string[] {
  return milestone.taskIds.filter((id) => {
    const task = state.tasks.find((item) => item.id === id);
    return task && (task.status === "todo" || task.status === "failed" || task.status === "running");
  });
}

function executableTaskCount(state: ProjectState): number {
  return state.tasks.filter((task) => task.status === "todo" || task.status === "failed" || task.status === "running").length;
}

function recoverInterruptedWork(state: ProjectState): number {
  let recovered = 0;

  for (const milestone of state.milestones) {
    if (milestone.status === "running") {
      milestone.status = "todo";
      milestone.threadId = undefined;
      milestone.lastTurnInputTokens = undefined;
      milestone.attempts = Math.max(0, milestone.attempts - 1);
      recovered += 1;
    }
    for (const slice of milestone.executionSlices ?? []) {
      if (slice.status !== "running") continue;
      slice.status = "todo";
      slice.threadId = undefined;
      slice.lastTurnInputTokens = undefined;
      slice.attempts = Math.max(0, slice.attempts - 1);
      recovered += 1;
    }
  }

  for (const task of state.tasks) {
    if (task.status !== "running") continue;
    task.status = "todo";
    recovered += 1;
  }

  if (recovered > 0 && state.status === "done") state.status = "idle";
  return recovered;
}

function inconsistentExecutableTasks(state: ProjectState): string[] {
  return state.tasks
    .filter((task) => task.status === "todo" || task.status === "failed" || task.status === "running")
    .filter((task) => {
      const milestone = state.milestones.find((item) => item.id === task.milestoneId);
      return !milestone || milestone.status === "done" || milestone.status === "superseded" || milestone.status === "running";
    })
    .map((task) => task.id);
}

function frozenMilestones(state: ProjectState): Milestone[] {
  return state.milestones.filter((milestone) => milestone.status === "waiting" || milestone.status === "blocked");
}

function mergeDurableMemory(state: ProjectState, milestone: Milestone, result: MilestoneResponse): void {
  milestone.decisions = Array.from(new Set([...(milestone.decisions ?? []), ...result.decisions]));
  milestone.followUpNotes = Array.from(new Set([...(milestone.followUpNotes ?? []), ...result.followUpNotes]));
  state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...result.decisions]));
  state.memory.notes = Array.from(new Set([...state.memory.notes, ...result.followUpNotes]));
}

function markMilestoneDone(state: ProjectState, milestone: Milestone, summary: string, changedFiles: string[]): number {
  let newlyDone = 0;
  for (const id of milestone.taskIds) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task || task.status === "superseded") continue;
    if (task.status !== "done") newlyDone += 1;
    task.status = "done";
    task.blocker = undefined;
    task.blockerType = undefined;
    task.summary ??= summary;
    task.changedFiles = Array.from(new Set([...(task.changedFiles ?? []), ...changedFiles]));
  }
  milestone.status = "done";
  milestone.blocker = undefined;
  milestone.blockerType = undefined;
  milestone.summary = summary;
  milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...changedFiles]));
  return newlyDone;
}

function freezeMilestone(
  state: ProjectState,
  milestone: Milestone,
  blocker: string,
  suggestedType?: BlockerType | null,
): void {
  const dependencyRegistration = registerRuntimeInternalDependencies(state, milestone, blocker, suggestedType);
  if (dependencyRegistration.cycle) {
    milestone.status = "blocked";
    milestone.blocker = dependencyRegistration.cycle;
    milestone.blockerType = "unknown";
    for (const id of milestone.taskIds) {
      const task = state.tasks.find((item) => item.id === id);
      if (task && task.status !== "done" && task.status !== "superseded") {
        task.status = "blocked";
        task.blocker = dependencyRegistration.cycle;
        task.blockerType = "unknown";
      }
    }
    return;
  }
  const blockerType = dependencyRegistration.dependencyIds.length > 0
    ? "internal_dependency"
    : inferBlockerType(blocker, suggestedType);
  milestone.status = "waiting";
  milestone.blocker = blocker;
  milestone.blockerType = blockerType;
  for (const id of milestone.taskIds) {
    const task = state.tasks.find((item) => item.id === id);
    if (task && task.status !== "done" && task.status !== "superseded") {
      task.status = "waiting";
      task.blocker = blocker;
      task.blockerType = blockerType;
    }
  }
}

function hardBlockMilestone(state: ProjectState, milestone: Milestone, blocker: string): void {
  milestone.status = "blocked";
  milestone.blocker = blocker;
  milestone.blockerType = "unknown";
  for (const id of milestone.taskIds) {
    const task = state.tasks.find((item) => item.id === id);
    if (task && task.status !== "done" && task.status !== "superseded") {
      task.status = "blocked";
      task.blocker = blocker;
      task.blockerType = "unknown";
    }
  }
}

function retryBlockedWork(state: ProjectState): number {
  let count = 0;
  for (const milestone of state.milestones) {
    if ((milestone.status === "waiting" || milestone.status === "blocked") && milestone.blockerType !== "internal_dependency") {
      milestone.status = "todo";
      milestone.blocker = undefined;
      milestone.blockerType = undefined;
      milestone.threadId = undefined;
      milestone.lastTurnInputTokens = undefined;
      if (isWaitNeutralBlocker(milestone.blockerType)) prepareMilestoneAfterWait(milestone);
      else milestone.attempts = 0;
      milestone.waitAttemptNeutralized = undefined;
      count += 1;
    }
    for (const slice of milestone.executionSlices ?? []) {
      if ((slice.status === "waiting" || slice.status === "blocked") && slice.blockerType !== "internal_dependency") {
        slice.status = "todo";
        slice.blocker = undefined;
        slice.blockerType = undefined;
        slice.threadId = undefined;
        slice.lastTurnInputTokens = undefined;
        if (isWaitNeutralBlocker(slice.blockerType)) prepareSliceAfterWait(slice);
        else slice.attempts = 0;
        slice.waitAttemptNeutralized = undefined;
      }
    }
  }
  for (const task of state.tasks) {
    if ((task.status === "waiting" || task.status === "blocked") && task.blockerType !== "internal_dependency") {
      task.status = "todo";
      task.blocker = undefined;
      task.blockerType = undefined;
      task.attempts = 0;
    }
  }
  return count;
}

async function replanRemaining(state: ProjectState, runner: CodexRunner, config: ProjectConfig, phase = "replan"): Promise<void> {
  if (executableTaskCount(state) === 0) return;
  console.log("\n↻ Reconciling executable backlog with a fresh bounded planner...");
  const memory = await refreshMemoryFiles(state, config.memoryMaxChars);
  const turn = await runner.replan(state, memory);
  recordUsage(state, turn, phase, config);
  applyReplan(state, turn.result);
  state.memory.notes = Array.from(new Set([...state.memory.notes, turn.result.summary]));
  await refreshMemoryFiles(state, config.memoryMaxChars);
  await saveState(state);
  const executableMilestones = state.milestones.filter((m) => m.status === "todo" || m.status === "failed").length;
  console.log(`  ✓ Replanned into ${executableMilestones} executable milestone(s)`);
}

function environmentWaiterHasMatchingGate(milestone: Milestone, passedGateNames: Set<string>): boolean {
  const blocker = `${milestone.blocker ?? ""} ${milestone.title}`.toLowerCase();
  const uiEvidence = /playwright|chromium|screenshot|capture|127\.0\.0\.1|localhost|vite|ui quality/.test(blocker);
  if (uiEvidence) {
    return ["quality:ui", "quality", "e2e", "playwright", "ui"].some((name) => passedGateNames.has(name));
  }

  if (/typecheck|typescript|tsc/.test(blocker)) return passedGateNames.has("typecheck") || passedGateNames.has("quality");
  if (/lint|eslint/.test(blocker)) return passedGateNames.has("lint") || passedGateNames.has("quality");
  if (/test|vitest|jest/.test(blocker)) return passedGateNames.has("test") || passedGateNames.has("quality");
  if (/build|compile/.test(blocker)) return passedGateNames.has("build") || passedGateNames.has("quality");

  // Unknown environment blockers are never declared solved merely because unrelated gates passed.
  return false;
}

function resolveEnvironmentWaiters(state: ProjectState, passedGateNames: Set<string>): number {
  let resolved = 0;
  for (const milestone of state.milestones) {
    if (
      (milestone.status === "waiting" || milestone.status === "blocked") &&
      milestone.blockerType === "environment" &&
      environmentWaiterHasMatchingGate(milestone, passedGateNames)
    ) {
      milestone.status = "done";
      milestone.summary = [milestone.summary, "Satisfied by a matching host-side final validation outside the Codex sandbox."].filter(Boolean).join(" ");
      milestone.blocker = undefined;
      milestone.blockerType = undefined;
      for (const id of milestone.taskIds) {
        const task = state.tasks.find((item) => item.id === id);
        if (task && task.status !== "done" && task.status !== "superseded") {
          task.status = "done";
          task.summary = task.summary ?? "Satisfied by a matching host-side final validation outside the Codex sandbox.";
          task.blocker = undefined;
          task.blockerType = undefined;
          resolved += 1;
        }
      }
    }
  }
  return resolved;
}

async function classifyValidationFailure(
  state: ProjectState,
  runner: CodexRunner,
  config: ProjectConfig,
  gate: GateResult,
): Promise<ValidationClassification> {
  const deterministic = classifyGateDeterministically(gate);
  if (deterministic) {
    console.log(`  ↳ ${gate.name}: ${deterministic.kind} (${Math.round(deterministic.confidence * 100)}%) [deterministic]`);
    return deterministic;
  }

  console.log(`  ↳ ${gate.name}: cause ambiguous; classifying with ${config.plannerModel} (${config.plannerReasoningEffort})...`);
  const turn = await runner.classifyValidationFailure(gate);
  recordUsage(state, turn, `validation-classify:${gate.name}`, config);
  console.log(`  ↳ ${gate.name}: ${turn.result.kind} (${Math.round(turn.result.confidence * 100)}%) [Luna]`);
  return turn.result;
}

function finalValidationBlock(
  state: ProjectState,
  gate: GateResult,
  classification: ValidationClassification,
): ProjectState {
  const blockerType = validationKindToBlocker(classification.kind);
  state.status = "validation_pending";
  state.lastMessage =
    `Final validation pending [${blockerType}] on ${gate.name}: ${classification.reason}\n` +
    formatGateFailure(gate);
  return state;
}

async function finalValidation(state: ProjectState, runner: CodexRunner, config: ProjectConfig): Promise<ProjectState> {
  const executableRemaining = executableTaskCount(state);
  if (executableRemaining > 0) {
    const inconsistent = inconsistentExecutableTasks(state);
    state.status = "idle";
    state.needsReplan = inconsistent.length > 0 || state.needsReplan;
    state.lastMessage =
      `Final validation skipped because ${executableRemaining} executable task(s) remain.` +
      (inconsistent.length > 0
        ? ` Inconsistent task/milestone state detected for: ${inconsistent.join(", ")}. MVPX will recover/replan on the next run.`
        : " Run MVPX again to continue.");
    console.log(`\n⚠ Final validation skipped: ${executableRemaining} executable task(s) remain.`);
    if (inconsistent.length > 0) {
      console.log(`  ↻ State invariant repair queued for: ${inconsistent.join(", ")}`);
    }
    await saveState(state);
    return state;
  }

  console.log("\n◆ Final validation router (host process, outside Codex sandbox)");
  let gates = await runQualityGates(state.projectRoot, config.fullGates);
  if (gates.length === 0) {
    console.log("  No configured full quality gates were detected.");
    const remainingFrozen = frozenMilestones(state);
    state.status = remainingFrozen.length > 0 ? "blocked" : "done";
    state.lastMessage = remainingFrozen.length > 0
      ? "Environment-blocked work remains and no matching final quality gate exists to verify it automatically."
      : "All executable milestones are complete; no final quality gates were configured.";
    await saveState(state);
    return state;
  }

  const initialPassed = gates.filter((gate) => gate.ok).map((gate) => gate.name);
  if (initialPassed.length > 0) console.log(`  ✓ Initial pass: ${initialPassed.join(", ")}`);
  let failed = gates.filter((gate) => !gate.ok);

  if (failed.length === 0) {
    const passedGateNames = new Set(gates.map((gate) => gate.name));
    const resolved = resolveEnvironmentWaiters(state, passedGateNames);
    if (resolved > 0) console.log(`  ✓ Resolved ${resolved} environment-blocked task(s) via matching host-side validation`);
    const remainingFrozen = frozenMilestones(state);
    state.status = remainingFrozen.length > 0 ? "blocked" : "done";
    state.lastMessage = remainingFrozen.length > 0
      ? `${remainingFrozen.length} blocked/waiting milestone(s) remain after final validation.`
      : "All executable milestones and final quality gates are complete.";
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);
    return state;
  }

  const checkpoint = await createCheckpoint(state.projectRoot, "FINAL-QA");
  state.checkpoints.push(checkpoint);
  await saveState(state);
  let anyAiRepair = false;

  for (const originalFailure of failed) {
    let gate = originalFailure;
    console.log(`\n  ✗ ${gate.name} failed; routing before any AI repair...`);

    // One host-only retry for test/browser/UI-style gates. This catches flakiness without spending AI quota.
    if (shouldRetryWithoutAi(gate)) {
      console.log(`  ↻ Retrying ${gate.name} once on host without AI...`);
      const retry = await runQualityGate(state.projectRoot, gate.name);
      if (retry) gate = retry;
      if (gate.ok) {
        console.log(`  ✓ ${gate.name} passed on deterministic retry; no AI used.`);
        continue;
      }
    }

    let classification = await classifyValidationFailure(state, runner, config, gate);
    if (classification.kind === "environment" || classification.kind === "transient") {
      finalValidationBlock(state, gate, classification);
      console.log(`  ⏸ ${gate.name} is ${classification.kind}; no Terra repair attempted.`);
      await saveState(state);
      return state;
    }

    let previousRepair: FinalRepairResponse | undefined;
    let gatePassed = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      const selection = runner.modelForAttempt(attempt);
      console.log(
        `  🔧 ${gate.name}: targeted repair ${attempt}/${config.maxRetries} with ${selection.model} [fresh thread]...`,
      );
      // Fresh validation repairs intentionally receive a smaller durable-memory handoff than implementation turns.
      // Continuity between attempts is carried by the structured previous-attempt summary below, not by thread history.
      const memory = renderProjectMemory(state, Math.min(config.memoryMaxChars, config.finalRepairMemoryMaxChars));
      const repair = await runner.repairValidationGate(
        state,
        attempt,
        gate,
        classification,
        memory,
        previousRepair ? {
          summary: previousRepair.summary,
          changedFiles: previousRepair.changedFiles,
          decisions: previousRepair.decisions,
        } : undefined,
      );
      anyAiRepair = true;
      recordUsage(state, repair, `validation-repair:${gate.name}:${attempt}`, config);
      state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...repair.result.decisions]));
      await saveState(state);

      if (repair.result.status === "blocked") {
        await recordValidationRepairCost(
          state, gate.name, attempt, repair.selection.model, repair.usage, repair.result.changedFiles.length, false, config.costHistoryMaxRecords,
        );
        const type = inferBlockerType(repair.result.blocker ?? repair.result.summary, repair.result.blockerType);
        state.status = "blocked";
        state.lastMessage = `Final validation blocked [${type}] while repairing ${gate.name}: ${repair.result.blocker ?? repair.result.summary}`;
        await saveState(state);
        return state;
      }

      // Crucially, rerun ONLY the gate just repaired.
      const rerun = await runQualityGate(state.projectRoot, gate.name);
      if (!rerun) {
        await recordValidationRepairCost(
          state, gate.name, attempt, repair.selection.model, repair.usage, repair.result.changedFiles.length, false, config.costHistoryMaxRecords,
        );
        state.status = "validation_pending";
        state.lastMessage = `Final validation pending: gate ${gate.name} disappeared after repair; manual verification is required.`;
        await saveState(state);
        return state;
      }
      gate = rerun;
      await recordValidationRepairCost(
        state, gate.name, attempt, repair.selection.model, repair.usage, repair.result.changedFiles.length, gate.ok, config.costHistoryMaxRecords,
      );
      if (gate.ok) {
        console.log(`  ✓ ${gate.name} passed after targeted repair ${attempt}.`);
        gatePassed = true;
        break;
      }

      previousRepair = repair.result;

      // Reclassify the NEW failure. If repair exposed an environment/transient issue, stop immediately.
      classification = await classifyValidationFailure(state, runner, config, gate);
      if (classification.kind === "environment" || classification.kind === "transient") {
        finalValidationBlock(state, gate, classification);
        console.log(`  ⏸ ${gate.name} became ${classification.kind}; stopping AI repair loop.`);
        await saveState(state);
        return state;
      }
    }

    if (!gatePassed) {
      if (config.rollbackOnFailure) {
        console.log(`  ↩ ${gate.name} exhausted targeted repairs; rolling back final-repair changes.`);
        await rollbackToCheckpoint(state.projectRoot, checkpoint);
      }
      state.status = "validation_pending";
      state.lastMessage = `Final validation still fails at ${gate.name}:\n${formatGateFailure(gate)}`;
      await saveState(state);
      return state;
    }
  }

  // Repairs can affect previously-passing gates. Do exactly one deterministic confirmation pass at the end,
  // never a full suite after each individual repair.
  if (anyAiRepair) {
    console.log("\n  ↻ One final host-only confirmation pass after targeted repairs...");
    gates = await runQualityGates(state.projectRoot, config.fullGates);
    failed = gates.filter((gate) => !gate.ok);
    if (failed.length > 0) {
      // Do not immediately start another broad repair loop here. Route the first new failure on the next run.
      const first = failed[0];
      const classification = await classifyValidationFailure(state, runner, config, first);
      if (classification.kind === "environment" || classification.kind === "transient") {
        finalValidationBlock(state, first, classification);
      } else {
        state.status = "validation_pending";
        state.lastMessage = `Final confirmation exposed a new reparable failure in ${first.name}. Run MVPX again to route it as a fresh targeted validation issue.\n${formatGateFailure(first)}`;
      }
      await saveState(state);
      return state;
    }
  }

  console.log("  ✓ Final validation passed");
  const passedGateNames = new Set(gates.filter((gate) => gate.ok).map((gate) => gate.name));
  const resolved = resolveEnvironmentWaiters(state, passedGateNames);
  if (resolved > 0) console.log(`  ✓ Resolved ${resolved} environment-blocked task(s) via matching host-side validation`);
  const remainingFrozen = frozenMilestones(state);
  state.status = remainingFrozen.length > 0 ? "blocked" : "done";
  state.lastMessage = remainingFrozen.length > 0
    ? `${remainingFrozen.length} blocked/waiting milestone(s) remain after final validation.`
    : "All executable milestones and final quality gates are complete.";
  await refreshMemoryFiles(state, config.memoryMaxChars);
  await saveState(state);
  return state;
}


function runUsageDelta(after: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    turns: Math.max(0, after.turns - before.turns),
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    cachedInputTokens: Math.max(0, after.cachedInputTokens - before.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, after.cacheWriteInputTokens - before.cacheWriteInputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    reasoningOutputTokens: Math.max(0, after.reasoningOutputTokens - before.reasoningOutputTokens),
  };
}

function runBudgetReason(
  state: ProjectState,
  usageAtStart: UsageTotals,
  historyAtStart: number,
  config: ProjectConfig,
  nextAction: "lead" | "implementation" | "general" = "general",
): string | undefined {
  if (!config.runBudgetEnabled) return undefined;
  const delta = runUsageDelta(state.usage, usageAtStart);
  const rows = state.usageHistory.slice(historyAtStart);
  const solTurns = rows.filter((row) => row.model === config.escalationModel).length;

  if (config.runBudgetMaxInputTokens > 0 && delta.inputTokens >= config.runBudgetMaxInputTokens) {
    return `run input budget reached (${delta.inputTokens.toLocaleString()} >= ${config.runBudgetMaxInputTokens.toLocaleString()} tokens)`;
  }
  if (config.runBudgetMaxSolTurns > 0 && solTurns >= config.runBudgetMaxSolTurns) {
    return `Sol run budget reached (${solTurns} >= ${config.runBudgetMaxSolTurns} completed turn(s))`;
  }
  return undefined;
}

function predictiveRunBudgetReason(
  state: ProjectState,
  usageAtStart: UsageTotals,
  config: ProjectConfig,
  predictedInputTokens: number,
): string | undefined {
  if (!config.runBudgetEnabled || !config.runBudgetPredictiveEnabled) return undefined;
  if (config.runBudgetMaxInputTokens <= 0 || predictedInputTokens <= 0) return undefined;
  const delta = runUsageDelta(state.usage, usageAtStart);
  // Never deadlock the first work package of a fresh run. If one milestone alone is
  // predicted above budget, hierarchical slicing + between-slice checks control it.
  if (delta.inputTokens <= 0) return undefined;
  const predicted = Math.round(predictedInputTokens * Math.max(0.1, config.runBudgetPredictiveSafetyFactor));
  const projected = delta.inputTokens + predicted;
  if (projected > config.runBudgetMaxInputTokens) {
    return `projected run input budget would be exceeded (${delta.inputTokens.toLocaleString()} used + ~${predicted.toLocaleString()} predicted = ~${projected.toLocaleString()} > ${config.runBudgetMaxInputTokens.toLocaleString()} tokens)`;
  }
  return undefined;
}

function initializeExecutionSlices(
  milestone: Milestone,
  plan: SlicePlanResponse,
  runner: CodexRunner,
  config: ProjectConfig,
  startOrdinal = 0,
): ExecutionSlice[] {
  return plan.slices.slice(0, Math.max(2, runner.sliceCapForMilestone(milestone))).map((raw, index) => {
    const slice: ExecutionSlice = {
      ...raw,
      id: `${milestone.id}-S${String(startOrdinal + index + 1).padStart(2, "0")}`,
      fileScope: raw.fileScope ?? [],
      complexity: raw.complexity ?? "normal",
      risk: raw.risk ?? "medium",
      crossModule: Boolean(raw.crossModule),
      requiresArchitectureChange: Boolean(raw.requiresArchitectureChange),
      estimatedFiles: Math.max(1, raw.estimatedFiles ?? raw.fileScope?.length ?? 1),
      verificationBacked: Boolean(raw.verificationBacked),
      verificationEvidence: raw.verificationEvidence ?? [],
      decisionState: raw.decisionState ?? "open",
      decisionSummary: raw.decisionSummary ?? "",
      criticalDomain: Boolean(raw.criticalDomain),
      criticalDomainReason: raw.criticalDomainReason ?? "",
      atomic: Boolean(raw.atomic),
      atomicReason: raw.atomicReason ?? "",
      status: "todo",
      attempts: 0,
    };
    slice.lane = runner.sliceLane(slice);
    return slice;
  });
}

function slicePlanIssues(
  milestone: Milestone,
  plan: SlicePlanResponse,
  runner: CodexRunner,
  config: ProjectConfig,
  startOrdinal = 0,
): string[] {
  const slices = initializeExecutionSlices(milestone, plan, runner, config, startOrdinal);
  const issues: string[] = [];
  for (const slice of slices) {
    if (slice.decisionState === "locked" && !(slice.decisionSummary ?? "").trim()) {
      issues.push(`${slice.title}: decisionState=locked requires a concrete decisionSummary.`);
    }
    if (slice.criticalDomain && !(slice.criticalDomainReason ?? "").trim()) {
      issues.push(`${slice.title}: criticalDomain=true requires criticalDomainReason naming the invariant.`);
    }
    const lane = runner.sliceLane(slice);
    if (
      lane === "terra-high" &&
      slice.estimatedFiles > config.highSliceAtomicThreshold &&
      (!slice.atomic || !(slice.atomicReason ?? "").trim())
    ) {
      issues.push(
        `${slice.title}: Terra High slice touches ~${slice.estimatedFiles} files (> ${config.highSliceAtomicThreshold}) but is not justified as atomic. Split it further or provide atomic=true with a concrete atomicReason.`,
      );
    }
  }
  return issues;
}

function sliceMaxAttempts(slice: ExecutionSlice): number {
  if (slice.lane === "luna-high") return 4; // Luna High -> Terra Medium -> Terra High -> Sol High.
  return 3; // Terra Medium -> Terra High -> Sol OR Terra High -> Terra High -> Sol.
}

function freezeSliceAndMilestone(
  state: ProjectState,
  milestone: Milestone,
  slice: ExecutionSlice,
  blocker: string,
  suggestedType?: BlockerType | null,
): void {
  const blockerType = inferBlockerType(blocker, suggestedType);
  slice.status = "waiting";
  slice.blocker = blocker;
  slice.blockerType = blockerType;
  freezeMilestone(state, milestone, blocker, blockerType);
  // freezeMilestone may promote an agent-reported external dependency to an internal DAG edge.
  slice.blockerType = milestone.blockerType;
}

interface HierarchicalResult {
  completed: boolean;
  newlyDone: number;
  budgetStop: boolean;
}

async function executeHierarchicalMilestone(
  state: ProjectState,
  milestone: Milestone,
  runner: CodexRunner,
  config: ProjectConfig,
  usageAtRunStart: UsageTotals,
  historyAtRunStart: number,
  costHistory: CostHistoryRecord[],
): Promise<HierarchicalResult> {
  let memory = await refreshMemoryFiles(state, config.memoryMaxChars);

  const existingSlices = milestone.executionSlices ?? [];
  const completedExistingSlices = existingSlices.filter((slice) => slice.status === "done");
  const needsFreshLead = existingSlices.length === 0;
  const needsSliceRefinement = existingSlices.length > 0 && completedExistingSlices.length < existingSlices.length && (milestone.slicePlanVersion ?? 1) < 4;

  if (needsFreshLead || needsSliceRefinement) {
    if (needsSliceRefinement) {
      console.log(`  ↻ Refining ${existingSlices.length - completedExistingSlices.length} pending pre-v0.4.10 slice(s); ${completedExistingSlices.length} completed slice(s) will be preserved.`);
    }
    const leadBudgetBefore = runBudgetReason(state, usageAtRunStart, historyAtRunStart, config, "lead");
    if (leadBudgetBefore) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused before technical-lead decomposition: ${leadBudgetBefore}. Continue with 'mvpx run'.`;
      await saveState(state);
      console.log(`  ⏸ ${state.lastMessage}`);
      return { completed: false, newlyDone: 0, budgetStop: true };
    }
    const leadSelection = runner.leadModel();
    console.log(`  Lead: ${leadSelection.model} (${leadSelection.reasoningEffort}) → hierarchical decomposition`);
    let leadTurn: RunnerResult<SlicePlanResponse> | undefined;
    let transportRetries = 0;
    let planFeedback: string | undefined;
    let leadPlanAttempt = 0;
    try {
      while (!leadTurn) {
        try {
          leadPlanAttempt += 1;
          const candidate = await runner.decomposeMilestone(state, milestone, memory, planFeedback);
          recordUsage(state, candidate, `${milestone.id}:lead${leadPlanAttempt > 1 ? `-refine-${leadPlanAttempt}` : ""}`, config);
          const issues = slicePlanIssues(milestone, candidate.result, runner, config, completedExistingSlices.length);
          if (issues.length > 0 && leadPlanAttempt < 2) {
            console.log(`  ↻ Lead plan rejected deterministically; requesting one bounded refinement:`);
            for (const issue of issues) console.log(`    - ${issue}`);
            planFeedback = issues.map((issue) => `- ${issue}`).join("\n");
            transportRetries = 0;
            const retryBudget = runBudgetReason(state, usageAtRunStart, historyAtRunStart, config, "lead");
            if (retryBudget) {
              milestone.status = "todo";
              state.status = "idle";
              state.lastMessage = `Run budget paused after rejected lead plan: ${retryBudget}. Continue with 'mvpx run'.`;
              await saveState(state);
              console.log(`  ⏸ ${state.lastMessage}`);
              return { completed: false, newlyDone: 0, budgetStop: true };
            }
            continue;
          }
          if (issues.length > 0) {
            console.log(`  ⚠ Lead refinement still has ${issues.length} planning issue(s); routing remains conservative for safety.`);
          }
          leadTurn = candidate;
        } catch (error) {
          if (error instanceof CodexTransportStartupError) {
            transportRetries += 1;
            leadPlanAttempt = Math.max(0, leadPlanAttempt - 1);
            if (transportRetries <= config.maxTransportRetries) {
              await sleep(500 * transportRetries);
              console.log(`  ↻ Lead transport retry ${transportRetries}/${config.maxTransportRetries}...`);
              continue;
            }
          }
          if (error instanceof TurnGuardExceededError) {
            freezeMilestone(
              state,
              milestone,
              `Technical-lead decomposition exceeded the activity guard: ${error.stats.reason}`,
              "orchestration_budget",
            );
            await saveState(state);
            return { completed: false, newlyDone: 0, budgetStop: false };
          }
          throw error;
        }
      }
    } catch (error) {
      milestone.status = "todo";
      await saveState(state);
      throw error;
    }

    milestone.leadSummary = leadTurn.result.summary;
    milestone.leadDecisions = Array.from(new Set([...(milestone.leadDecisions ?? []), ...leadTurn.result.decisions]));
    state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...leadTurn.result.decisions]));
    const refinedSlices = initializeExecutionSlices(
      milestone, leadTurn.result, runner, config, completedExistingSlices.length,
    );
    milestone.executionSlices = needsSliceRefinement
      ? [...completedExistingSlices, ...refinedSlices]
      : refinedSlices;
    milestone.slicePlanVersion = 4;
    console.log(`  ✓ Lead produced ${refinedSlices.length} bounded execution slice(s)${needsSliceRefinement ? ` for remaining work; preserved ${completedExistingSlices.length} completed slice(s)` : ""}`);
    for (const slice of milestone.executionSlices) {
      const selection = runner.sliceModel(slice, 1);
      console.log(
        `    ${slice.id} ${slice.complexity}/${slice.risk} ~${slice.estimatedFiles} files → ` +
        `${selection.model} (${selection.reasoningEffort}) [${slice.lane}]`,
      );
      console.log(`      Why: ${runner.sliceRoutingReason(slice)}`);
    }
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);

    const budget = runBudgetReason(state, usageAtRunStart, historyAtRunStart, config, "implementation");
    if (budget) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused after technical-lead decomposition: ${budget}. Continue with 'mvpx run'.`;
      await saveState(state);
      console.log(`  ⏸ ${state.lastMessage}`);
      return { completed: false, newlyDone: 0, budgetStop: true };
    }
  }

  for (const slice of milestone.executionSlices ?? []) {
    if (slice.status === "done") continue;

    slice.lane ??= runner.sliceLane(slice);
    const previewAttempt = Math.max(1, slice.attempts + 1);
    const previewSelection = runner.sliceModel(slice, previewAttempt);
    const predictedSliceInput = estimateSliceInputTokens(costHistory, slice, slice.lane);
    const predictiveSliceBudget = predictiveRunBudgetReason(state, usageAtRunStart, config, predictedSliceInput);
    if (predictiveSliceBudget) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused before ${slice.id}: ${predictiveSliceBudget}. Predicted slice cost ~${predictedSliceInput.toLocaleString()} input tokens. Continue with 'mvpx run'.`;
      await saveState(state);
      console.log(`  ⏸ ${state.lastMessage}`);
      return { completed: false, newlyDone: 0, budgetStop: true };
    }
    const startsTerraHigh = previewSelection.model === config.defaultModel && previewSelection.reasoningEffort === config.defaultReasoningEffort;
    const budgetBefore = runBudgetReason(
      state, usageAtRunStart, historyAtRunStart, config, startsTerraHigh ? "implementation" : "general",
    );
    if (budgetBefore) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused before ${slice.id}: ${budgetBefore}. Continue with 'mvpx run'.`;
      await saveState(state);
      console.log(`  ⏸ ${state.lastMessage}`);
      return { completed: false, newlyDone: 0, budgetStop: true };
    }

    if (!slice.checkpointId) {
      const checkpoint = await createCheckpoint(state.projectRoot, slice.id);
      state.checkpoints.push(checkpoint);
      slice.checkpointId = checkpoint.id;
    }

    slice.status = "running";
    slice.waitAttemptNeutralized = undefined;
    slice.attempts = Math.max(1, slice.attempts + 1);
    let selection = runner.sliceModel(slice, slice.attempts);
    const baseSelection = runner.sliceModel(slice, 1);
    console.log(`\n  ▸ ${slice.id}  ${slice.title}`);
    console.log(`    Scope: ${slice.fileScope.join(", ") || "narrow direct dependencies"}`);
    console.log(`    Route: ${slice.complexity}/${slice.risk} | ${slice.crossModule ? "cross-module" : "local"} | ${slice.requiresArchitectureChange ? "architecture-change" : "no-architecture-change"} | decision=${slice.decisionState ?? "open"} | ${slice.criticalDomain ? "critical-domain" : "non-critical-domain"} | ~${slice.estimatedFiles} files | ${slice.verificationBacked ? "verification-backed" : "standard-verification"} | ${slice.lane}`);
    console.log(`    Why: ${runner.sliceRoutingReason(slice)}`);
    console.log(`    AI: ${selection.model} (${selection.reasoningEffort})${selection.escalated ? " [ESCALATED]" : ""}`);
    if (slice.attempts > 1) {
      const changedLane = selection.model !== baseSelection.model || selection.reasoningEffort !== baseSelection.reasoningEffort;
      console.log(
        changedLane
          ? `    ↗ Escalated from ${baseSelection.model} (${baseSelection.reasoningEffort}) → ${selection.model} (${selection.reasoningEffort}); reason: ${slice.attempts - 1} previous implementation/gate failure attempt(s).`
          : `    ↻ Retry ${slice.attempts} keeps ${selection.model} (${selection.reasoningEffort}); reason: previous implementation/gate failure.`,
      );
    }
    await saveState(state);

    let turn: RunnerResult<SliceResponse> | undefined;
    let transportRetries = 0;
    let guardContinuations = 0;
    let continuationFailure: string | undefined;

    while (!turn) {
      try {
        memory = await refreshMemoryFiles(state, config.memoryMaxChars);
        turn = await runner.executeSlice(state, milestone, slice, memory, slice.attempts, continuationFailure);
      } catch (error) {
        if (error instanceof CodexTransportStartupError) {
          transportRetries += 1;
          if (transportRetries <= config.maxTransportRetries) {
            console.log(`    ↻ Transport retry ${transportRetries}/${config.maxTransportRetries}...`);
            await sleep(500 * transportRetries);
            continue;
          }
          slice.status = "todo";
          slice.attempts = Math.max(0, slice.attempts - 1);
          milestone.status = "todo";
          await saveState(state);
          throw error;
        }
        if (error instanceof TurnGuardExceededError) {
          guardContinuations += 1;
          milestone.guardTrips = (milestone.guardTrips ?? 0) + 1;
          milestone.lastGuardReason = error.stats.reason;
          if (guardContinuations > config.maxGuardContinuations) {
            freezeSliceAndMilestone(
              state,
              milestone,
              slice,
              `Progress-aware guard stopped ${guardContinuations} slice execution(s). Last reason: ${error.stats.reason}`,
              "orchestration_budget",
            );
            await saveState(state);
            return { completed: false, newlyDone: 0, budgetStop: false };
          }
          continuationFailure = `Previous bounded slice was stopped by the progress guard (${error.stats.reason}). Continue from the preserved worktree; do not repeat broad exploration.`;
          console.log(`    ↻ Guard continuation ${guardContinuations}/${config.maxGuardContinuations}: ${error.stats.reason}`);
          continue;
        }
        throw error;
      }
    }

    recordUsage(state, turn, `${milestone.id}:${slice.id}:execute-${slice.attempts}`, config);
    slice.threadId = turn.threadId;
    slice.lastTurnInputTokens = turn.usage.inputTokens;
    slice.summary = turn.result.summary;
    slice.changedFiles = Array.from(new Set([...(slice.changedFiles ?? []), ...turn.result.changedFiles]));
    slice.decisions = Array.from(new Set([...(slice.decisions ?? []), ...turn.result.decisions]));
    milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...turn.result.changedFiles]));
    milestone.decisions = Array.from(new Set([...(milestone.decisions ?? []), ...turn.result.decisions]));
    state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...turn.result.decisions]));
    state.memory.notes = Array.from(new Set([...state.memory.notes, ...turn.result.followUpNotes]));
    await saveState(state);

    if (turn.result.status === "blocked") {
      freezeSliceAndMilestone(state, milestone, slice, turn.result.blocker ?? turn.result.summary, turn.result.blockerType);
      if (neutralizeSliceWaitAttempt(slice)) {
        console.log(`    ↩ WAIT is attempt-neutral; ${slice.lane} will resume without model escalation.`);
      }
      await saveState(state);
      console.log(`    ⛔ WAITING [${slice.blockerType}]: ${slice.blocker}`);
      return { completed: false, newlyDone: 0, budgetStop: false };
    }

    let gates = await runQualityGates(state.projectRoot, config.incrementalGates);
    let failed = gates.filter((gate) => !gate.ok);
    const maxAttempts = sliceMaxAttempts(slice);

    while (failed.length > 0 && slice.attempts < maxAttempts) {
      if (gateFailureLooksEnvironmental(gates)) {
        freezeSliceAndMilestone(state, milestone, slice, formatGateFailures(gates), "environment");
        neutralizeSliceWaitAttempt(slice);
        await saveState(state);
        return { completed: false, newlyDone: 0, budgetStop: false };
      }
      slice.attempts += 1;
      selection = runner.sliceModel(slice, slice.attempts);
      console.log(`    ↗ Repair ${slice.attempts}/${maxAttempts}: ${selection.model} (${selection.reasoningEffort})${selection.escalated ? " [ESCALATED]" : ""}`);
      memory = await refreshMemoryFiles(state, config.memoryMaxChars);
      const repair = await runner.executeSlice(
        state,
        milestone,
        slice,
        memory,
        slice.attempts,
        formatGateFailures(gates),
      );
      recordUsage(state, repair, `${milestone.id}:${slice.id}:repair-${slice.attempts}`, config);
      slice.threadId = repair.threadId;
      slice.lastTurnInputTokens = repair.usage.inputTokens;
      slice.summary = repair.result.summary;
      slice.changedFiles = Array.from(new Set([...(slice.changedFiles ?? []), ...repair.result.changedFiles]));
      slice.decisions = Array.from(new Set([...(slice.decisions ?? []), ...repair.result.decisions]));
      milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...repair.result.changedFiles]));
      state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...repair.result.decisions]));
      state.memory.notes = Array.from(new Set([...state.memory.notes, ...repair.result.followUpNotes]));
      if (repair.result.status === "blocked") {
        freezeSliceAndMilestone(state, milestone, slice, repair.result.blocker ?? repair.result.summary, repair.result.blockerType);
        neutralizeSliceWaitAttempt(slice);
        await saveState(state);
        return { completed: false, newlyDone: 0, budgetStop: false };
      }
      gates = await runQualityGates(state.projectRoot, config.incrementalGates);
      failed = gates.filter((gate) => !gate.ok);
    }

    if (failed.length > 0) {
      const checkpoint = state.checkpoints.find((item) => item.id === slice.checkpointId);
      if (config.rollbackOnFailure && checkpoint) await rollbackToCheckpoint(state.projectRoot, checkpoint);
      slice.status = "blocked";
      slice.blocker = `Slice gates still fail after ${slice.attempts} attempt(s):\n${formatGateFailures(gates)}`;
      slice.blockerType = "unknown";
      hardBlockMilestone(state, milestone, slice.blocker);
      await saveState(state);
      return { completed: false, newlyDone: 0, budgetStop: false };
    }

    slice.status = "done";
    const checkpoint = state.checkpoints.find((item) => item.id === slice.checkpointId);
    if (checkpoint) {
      const changed = await listChangesSinceCheckpoint(state.projectRoot, checkpoint);
      slice.changedFiles = Array.from(new Set([...(slice.changedFiles ?? []), ...changed]));
      milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...changed]));
    }
    await saveState(state);
    const sliceCostRecord = await recordSliceCost(state, milestone, slice, config.costHistoryMaxRecords);
    if (sliceCostRecord && !costHistory.some((row) => row.recordType === "slice" && row.milestoneId === sliceCostRecord.milestoneId && row.sliceId === sliceCostRecord.sliceId)) {
      costHistory.push(sliceCostRecord);
    }
    console.log(`    ✓ ${slice.id} completed`);

    const budgetAfter = runBudgetReason(state, usageAtRunStart, historyAtRunStart, config, "general");
    if (budgetAfter) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused after ${slice.id}: ${budgetAfter}. Remaining slices are preserved. Continue with 'mvpx run'.`;
      await saveState(state);
      console.log(`  ⏸ ${state.lastMessage}`);
      return { completed: false, newlyDone: 0, budgetStop: true };
    }
  }

  const slices = milestone.executionSlices ?? [];
  const summary = slices.map((slice) => `${slice.id}: ${slice.summary ?? slice.title}`).join(" | ");
  const changed = Array.from(new Set(slices.flatMap((slice) => slice.changedFiles ?? [])));
  milestone.summary = summary;
  milestone.decisions = Array.from(new Set([...(milestone.leadDecisions ?? []), ...(milestone.decisions ?? []), ...slices.flatMap((slice) => slice.decisions ?? [])]));
  state.memory.decisions = Array.from(new Set([...state.memory.decisions, ...(milestone.decisions ?? [])]));
  const newlyDone = markMilestoneDone(state, milestone, summary, changed);
  await refreshMemoryFiles(state, config.memoryMaxChars);
  await saveState(state);
  return { completed: true, newlyDone, budgetStop: false };
}

export interface RunOptions {
  maxTasks?: number;
  maxMilestones?: number;
  retryBlocked?: boolean;
}

export async function runOrchestrator(state: ProjectState, options: RunOptions = {}): Promise<ProjectState> {
  const config = await loadConfig(state.projectRoot);
  const maxTasks = options.maxTasks ?? config.maxTasksPerRun;
  const maxMilestones = options.maxMilestones ?? config.maxMilestonesPerRun;
  const backfilledSliceCosts = await backfillSliceCostHistory(state, config.costHistoryMaxRecords);
  if (backfilledSliceCosts > 0) {
    console.log(`↻ Learned ${backfilledSliceCosts} historical completed slice cost observation(s) from existing state.`);
  }
  const costProfile = await costProfileForPlanner(state.projectRoot);
  const costHistory = await loadCostHistory(state.projectRoot);
  const runner = new CodexRunner(state.projectRoot, config, costProfile);
  const usageAtRunStart: UsageTotals = { ...state.usage };
  const historyAtRunStart = state.usageHistory.length;
  let completedTasksThisRun = 0;
  let completedMilestonesThisRun = 0;

  const shouldRetryBlocked = options.retryBlocked ?? config.retryBlockedByDefault;
  if (shouldRetryBlocked) {
    const reset = retryBlockedWork(state);
    if (reset > 0) console.log(`↻ Explicitly retrying ${reset} previously blocked/waiting milestone(s).`);
  }

  const recoveredInterrupted = recoverInterruptedWork(state);
  if (recoveredInterrupted > 0) {
    console.log(
      `↻ Recovered ${recoveredInterrupted} interrupted running state entr${recoveredInterrupted === 1 ? "y" : "ies"}; ` +
      `unfinished work is executable again.`,
    );
  }

  const dependencyRecovery = reconcileInternalDependencies(state);
  assertValidDependencyGraph(state.tasks);
  if (dependencyRecovery.promoted > 0 || dependencyRecovery.parked > 0 || dependencyRecovery.unblocked > 0) {
    console.log(
      `↻ Dependency scheduler reconciled ${dependencyRecovery.promoted} runtime waiter(s), parked ${dependencyRecovery.parked} downstream milestone(s), and auto-unblocked ${dependencyRecovery.unblocked} ready milestone(s).`,
    );
  }

  state.status = "running";
  state.runCount += 1;
  state.projectThreadId = undefined; // v0.4+ never resumes the v0.3 global thread.
  await refreshMemoryFiles(state, config.memoryMaxChars);
  await saveState(state);

  if (state.needsReplan || (state.milestones.length === 0 && executableTaskCount(state) > 0)) {
    await replanRemaining(state, runner, config, "migration-replan");
  }

  while (completedTasksThisRun < maxTasks && completedMilestonesThisRun < maxMilestones) {
    const dependencyWake = reconcileInternalDependencies(state);
    assertValidDependencyGraph(state.tasks);
    if (dependencyWake.unblocked > 0) {
      console.log(`↻ Dependency scheduler auto-unblocked ${dependencyWake.unblocked} milestone(s) whose prerequisites completed.`);
      await saveState(state);
    }

    const budgetBeforeMilestone = runBudgetReason(state, usageAtRunStart, historyAtRunStart, config);
    if (budgetBeforeMilestone) {
      state.status = "idle";
      state.lastMessage = `Run budget reached before starting another work package: ${budgetBeforeMilestone}. Continue with 'mvpx run' when you want another bounded batch.`;
      console.log(`\n⏸ ${state.lastMessage}`);
      await saveState(state);
      return state;
    }

    const milestone = nextMilestone(state);
    if (!milestone) break;

    const pendingIds = unresolvedTasksInMilestone(state, milestone);
    if (pendingIds.length === 0) {
      milestone.status = "done";
      await saveState(state);
      continue;
    }

    console.log(`\n▶ ${milestone.id}  ${milestone.title}`);
    console.log(`  Tasks: ${pendingIds.join(", ")}`);

    if (!milestone.checkpointId) {
      const checkpoint = await createCheckpoint(state.projectRoot, milestone.id);
      state.checkpoints.push(checkpoint);
      milestone.checkpointId = checkpoint.id;
      console.log(`  Checkpoint: ${checkpoint.id}`);
    }

    milestone.predictedInputTokens = estimateMilestoneInputTokens(
      costHistory,
      milestone.complexity ?? "normal",
      milestone.estimatedFiles ?? 1,
      pendingIds.length,
    );
    console.log(
      `  Route: ${milestone.complexity ?? "normal"}/${milestone.risk ?? "medium"} | ` +
      `${milestone.crossModule ? "cross-module" : "local"} | ${milestone.requiresArchitectureChange ? "architecture-change" : "no-architecture-change"} | ` +
      `~${milestone.estimatedFiles ?? "?"} files | predicted ~${Math.round((milestone.predictedInputTokens ?? 0) / 1000).toLocaleString()}k input`,
    );

    const predictiveBudget = predictiveRunBudgetReason(
      state, usageAtRunStart, config, milestone.predictedInputTokens ?? 0,
    );
    if (predictiveBudget) {
      milestone.status = "todo";
      state.status = "idle";
      state.lastMessage = `Run budget paused before ${milestone.id}: ${predictiveBudget}. Continue with 'mvpx run' for another bounded batch.`;
      console.log(`  ⏸ ${state.lastMessage}`);
      await saveState(state);
      return state;
    }

    if (runner.shouldDecomposeMilestone(milestone)) {
      milestone.status = "running";
      await saveState(state);
      console.log("  Mode: hierarchical lead + execution slices");
      const hierarchical = await executeHierarchicalMilestone(
        state, milestone, runner, config, usageAtRunStart, historyAtRunStart, costHistory,
      );
      if (hierarchical.budgetStop) return state;
      if (!hierarchical.completed) continue;

      completedTasksThisRun += hierarchical.newlyDone;
      completedMilestonesThisRun += 1;
      state.milestonesSinceReplan += 1;
      state.lastMessage = `${milestone.id} completed via ${milestone.executionSlices?.length ?? 0} execution slice(s).`;
      await saveState(state);
      await recordMilestoneCost(state, milestone, config.costHistoryMaxRecords);
      console.log(`  ✓ ${milestone.id} completed (${hierarchical.newlyDone} task${hierarchical.newlyDone === 1 ? "" : "s"}) via ${milestone.executionSlices?.length ?? 0} slice(s)`);
      const dependencyWakeAfterHierarchicalCompletion = reconcileInternalDependencies(state);
      if (dependencyWakeAfterHierarchicalCompletion.unblocked > 0) {
        console.log(`  ↻ Dependency scheduler released ${dependencyWakeAfterHierarchicalCompletion.unblocked} downstream milestone(s).`);
        await saveState(state);
      }
      continue;
    }

    milestone.status = "running";
    milestone.waitAttemptNeutralized = undefined;
    milestone.attempts += 1;
    milestone.threadId = undefined; // Fresh bounded thread for every milestone execution.
    milestone.lastTurnInputTokens = undefined;
    const initialSelection = runner.implementationModel(milestone);
    milestone.implementationLane = initialSelection.model === config.simpleImplementerModel ? "luna" : "terra";
    logModel(runner, milestone, "execute");
    await saveState(state);

    const memory = await refreshMemoryFiles(state, config.memoryMaxChars);
    let turn: RunnerResult<MilestoneResponse> | undefined;
    let continuationNote: string | undefined;
    let guardContinuations = 0;
    let transportRetries = 0;

    while (!turn) {
      try {
        turn = await runner.executeMilestone(state, milestone, memory, continuationNote);
      } catch (error) {
        if (error instanceof CodexTransportStartupError) {
          transportRetries += 1;
          if (transportRetries <= config.maxTransportRetries) {
            const delayMs = 500 * transportRetries;
            console.log(
              `  ↻ Codex transport failed before thread start; retrying infrastructure (${transportRetries}/${config.maxTransportRetries}) in ${delayMs}ms...`,
            );
            await sleep(delayMs);
            continue;
          }

          // No agent thread ever started, so this must not consume an AI attempt or cause model escalation.
          milestone.attempts = Math.max(0, milestone.attempts - 1);
          milestone.status = "todo";
          await saveState(state);
          throw new Error(
            `Codex transport failed ${transportRetries} times before the agent started. ` +
            `Milestone ${milestone.id} remains pending and no AI attempt was charged by MVPX. Last error: ${error.originalMessage}`,
          );
        }

        if (!(error instanceof TurnGuardExceededError)) throw error;

        guardContinuations += 1;
        milestone.guardTrips = (milestone.guardTrips ?? 0) + 1;
        milestone.lastGuardReason = error.stats.reason;
        const checkpoint = state.checkpoints.find((item) => item.id === milestone.checkpointId);
        const changedFiles = checkpoint
          ? await listChangesSinceCheckpoint(state.projectRoot, checkpoint)
          : error.stats.filesChanged;
        milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...changedFiles]));

        const noProgressSeconds = Math.round(error.stats.lastProgressAgeMs / 1000);
        console.log(
          `  ↻ Progress-aware guard stopped a slice: ${error.stats.reason} | ` +
          `${error.stats.commands} commands (${error.stats.commandsSinceProgress} since progress) | ` +
          `${error.stats.toolEvents} tool events | ${error.stats.filesChanged.length} slice file(s) | ` +
          `${changedFiles.length} total file(s) since checkpoint | last progress ${noProgressSeconds}s ago`,
        );

        if (guardContinuations > config.maxGuardContinuations) {
          freezeMilestone(
            state,
            milestone,
            `MVPX activity guard stopped ${guardContinuations} implementation slices for this milestone. ` +
            `Last reason: ${error.stats.reason}. Partial work is preserved and can be inspected or retried explicitly.`,
            "orchestration_budget",
          );
          await refreshMemoryFiles(state, config.memoryMaxChars);
          await saveState(state);
          console.log(`  ⏸ ${milestone.id} paused after exceeding the orchestration activity budget.`);
          break;
        }

        continuationNote = [
          `A previous implementation slice was stopped by MVPX because the progress-aware guard detected a likely runaway/stall (${error.stats.reason}).`,
          `The worktree changes were preserved; do not restart the milestone or repeat broad exploration.`,
          changedFiles.length ? `Files changed since the milestone checkpoint: ${changedFiles.slice(0, 40).join(", ")}.` : `No changed files were detected yet.`,
          `Continue directly from the current worktree. Do not repeat the commands/exploration that caused the guard trip; finish the same tasks using the current partial progress.`,
        ].join("\n");
        await saveState(state);
        console.log(`  ↻ Starting a fresh bounded continuation (${guardContinuations}/${config.maxGuardContinuations})...`);
      }
    }

    if (!turn) continue;

    recordUsage(state, turn, `${milestone.id}:execute`, config);
    milestone.threadId = turn.threadId;
    milestone.lastTurnInputTokens = turn.usage.inputTokens;
    milestone.summary = turn.result.summary;
    milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...turn.result.changedFiles]));
    mergeDurableMemory(state, milestone, turn.result);
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);

    if (turn.result.status === "blocked") {
      freezeMilestone(state, milestone, turn.result.blocker ?? turn.result.summary, turn.result.blockerType);
      if (neutralizeMilestoneWaitAttempt(milestone)) {
        console.log(`  ↩ WAIT is attempt-neutral; milestone will resume without model escalation.`);
      }
      console.log(`  ⛔ WAITING [${milestone.blockerType}]: ${milestone.blocker}`);
      await refreshMemoryFiles(state, config.memoryMaxChars);
      await saveState(state);
      continue;
    }

    let gates = await runQualityGates(state.projectRoot, config.incrementalGates);
    let failed = gates.filter((gate) => !gate.ok);
    if (gates.length > 0 && failed.length === 0) console.log(`  ✓ Incremental gates: ${gates.map((gate) => gate.name).join(", ")}`);

    let repairBlocked = false;
    // A simple Luna implementation is a cheap probe and does not consume Terra's retry budget.
    // This allows Luna -> Terra -> Terra -> Sol while normal work remains Terra -> Terra -> Sol.
    const maxAiAttempts = config.maxRetries + (milestone.implementationLane === "luna" ? 1 : 0);
    while (failed.length > 0 && milestone.attempts < maxAiAttempts) {
      if (gateFailureLooksEnvironmental(gates)) {
        freezeMilestone(state, milestone, formatGateFailures(gates), "environment");
        neutralizeMilestoneWaitAttempt(milestone);
        repairBlocked = true;
        console.log("  ⛔ Incremental gate failure is environmental; skipping AI retry without consuming an implementation attempt.");
        break;
      }

      console.log(`  ✗ Incremental gates failed (${failed.map((gate) => gate.name).join(", ")})`);
      if (milestone.implementationLane === "luna" && milestone.attempts === 1) {
        console.log(`  ↗ Simple Luna implementation did not satisfy host gates; promoting repair to ${config.defaultModel} (${config.defaultReasoningEffort}).`);
      }
      milestone.attempts += 1;
      logModel(runner, milestone, "repair");
      const rotate = (milestone.lastTurnInputTokens ?? 0) > config.maxTurnInputTokens;
      if (rotate) {
        console.log("  ↻ Rotating milestone repair to a fresh bounded thread.");
        milestone.threadId = undefined;
      }
      const repairMemory = await refreshMemoryFiles(state, config.memoryMaxChars);
      turn = await runner.fixAfterGateFailure(
        state,
        milestone,
        formatGateFailures(gates),
        repairMemory,
        milestone.threadId,
      );
      recordUsage(state, turn, `${milestone.id}:repair-${milestone.attempts}`, config);
      milestone.threadId = turn.threadId;
      milestone.lastTurnInputTokens = turn.usage.inputTokens;
      milestone.summary = turn.result.summary;
      milestone.changedFiles = Array.from(new Set([...(milestone.changedFiles ?? []), ...turn.result.changedFiles]));
      mergeDurableMemory(state, milestone, turn.result);
      await saveState(state);

      if (turn.result.status === "blocked") {
        freezeMilestone(state, milestone, turn.result.blocker ?? turn.result.summary, turn.result.blockerType);
        neutralizeMilestoneWaitAttempt(milestone);
        repairBlocked = true;
        break;
      }

      gates = await runQualityGates(state.projectRoot, config.incrementalGates);
      failed = gates.filter((gate) => !gate.ok);
    }

    if (repairBlocked) {
      console.log(`  ⛔ WAITING [${milestone.blockerType}]: ${milestone.blocker?.split("\n")[0]}`);
      await refreshMemoryFiles(state, config.memoryMaxChars);
      await saveState(state);
      continue;
    }

    if (failed.length > 0) {
      const checkpoint = state.checkpoints.find((item) => item.id === milestone.checkpointId);
      if (config.rollbackOnFailure && checkpoint) {
        console.log(`  ↩ ${milestone.id} exhausted retries; restoring ${checkpoint.id}`);
        await rollbackToCheckpoint(state.projectRoot, checkpoint);
      }
      hardBlockMilestone(state, milestone, `Incremental gates still fail after ${milestone.attempts} attempts:\n${formatGateFailures(gates)}`);
      await refreshMemoryFiles(state, config.memoryMaxChars);
      await saveState(state);
      continue;
    }

    const newlyDone = markMilestoneDone(
      state,
      milestone,
      turn.result.summary,
      milestone.changedFiles ?? turn.result.changedFiles,
    );
    completedTasksThisRun += newlyDone;
    completedMilestonesThisRun += 1;
    state.milestonesSinceReplan += 1;
    state.lastMessage = `${milestone.id} completed.`;
    await refreshMemoryFiles(state, config.memoryMaxChars);
    await saveState(state);
    await recordMilestoneCost(state, milestone, config.costHistoryMaxRecords);
    console.log(`  ✓ ${milestone.id} completed (${newlyDone} task${newlyDone === 1 ? "" : "s"})`);
    const dependencyWakeAfterCompletion = reconcileInternalDependencies(state);
    if (dependencyWakeAfterCompletion.unblocked > 0) {
      console.log(`  ↻ Dependency scheduler released ${dependencyWakeAfterCompletion.unblocked} downstream milestone(s).`);
      await saveState(state);
    }

    const hitRunLimit = completedTasksThisRun >= maxTasks || completedMilestonesThisRun >= maxMilestones;
    const hasExecutableWork = executableTaskCount(state) > 0;
    const periodicReplan = config.replanEveryMilestones > 0 &&
      state.milestonesSinceReplan >= config.replanEveryMilestones;
    const shouldReplan = !hitRunLimit && hasExecutableWork && (
      turn.result.replanRecommended || periodicReplan
    );
    if (shouldReplan) await replanRemaining(state, runner, config);
  }

  const remaining = nextMilestone(state);
  if (remaining) {
    state.status = "idle";
    state.lastMessage = `Run limit reached after ${completedMilestonesThisRun} milestone(s) / ${completedTasksThisRun} task(s). Run mvpx run again to continue.`;
    await saveState(state);
    return state;
  }

  const unresolvedExecutable = executableTaskCount(state);
  if (unresolvedExecutable > 0) {
    const inconsistent = inconsistentExecutableTasks(state);
    state.status = "idle";
    state.needsReplan = inconsistent.length > 0 || state.needsReplan;
    state.lastMessage =
      `${unresolvedExecutable} executable task(s) remain but no executable milestone can run them.` +
      (inconsistent.length > 0
        ? ` State recovery/replan queued for: ${inconsistent.join(", ")}.`
        : " Run MVPX again to continue.");
    console.log(
      `\n⚠ Completion invariant prevented false done: ${unresolvedExecutable} executable task(s) remain.` +
      (inconsistent.length > 0 ? ` Affected: ${inconsistent.join(", ")}` : ""),
    );
    await saveState(state);
    return state;
  }

  const frozen = frozenMilestones(state);
  if (frozen.length > 0) {
    const internal = frozen.filter((milestone) => milestone.blockerType === "internal_dependency");
    const actionable = frozen.filter((milestone) => milestone.blockerType !== "internal_dependency");

    const allEnvironment = internal.length === 0 && actionable.length > 0 && actionable.every((milestone) => milestone.blockerType === "environment");
    if (allEnvironment && config.finalValidateEnvironmentWaiters) {
      console.log("\nℹ Only environment-blocked work remains. Trying host-side final validation before asking for intervention.");
      return finalValidation(state, runner, config);
    }

    if (actionable.length > 0) {
      state.status = "blocked";
      state.lastMessage = `No executable milestones remain; ${actionable.length} milestone(s) require external intervention` +
        (internal.length > 0 ? ` and ${internal.length} downstream milestone(s) are waiting on those/internal prerequisites` : "") +
        `. Use 'mvpx blockers' for details and retry only after the external condition is resolved.`;
      await saveState(state);
      return state;
    }

    const detail = internal.map((milestone) => `${milestone.id}→[${unresolvedMilestoneDependencies(state, milestone).join(", ")}]`).join("; ");
    state.status = "idle";
    state.lastMessage = `Internal dependency waiters remain but no prerequisite is executable: ${detail}. Check the dependency graph; no user retry was requested.`;
    await saveState(state);
    return state;
  }

  return finalValidation(state, runner, config);
}
