import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferBlockerType } from "../blockers.js";
import { assertValidDependencyGraph, reconcileInternalDependencies } from "../dependencies.js";
import type { Milestone, ProjectConfig, ProjectMemoryState, ProjectState, Task, UsageTotals } from "../types.js";

const DIR = ".mvpx";
const STATE_FILE = "state.json";
const CONFIG_FILE = "config.json";

const EMPTY_USAGE: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function mvpxDir(root: string): string {
  return path.join(root, DIR);
}

export async function ensureMvpxDir(root: string): Promise<void> {
  await mkdir(mvpxDir(root), { recursive: true });
}

export async function saveState(state: ProjectState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await ensureMvpxDir(state.projectRoot);
  await writeFile(
    path.join(mvpxDir(state.projectRoot), STATE_FILE),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

function emptyMemory(summary = ""): ProjectMemoryState {
  return { summary, decisions: [], notes: [] };
}

function normalizeLegacyTask(task: Task): Task {
  const blockerType = task.blocker ? inferBlockerType(task.blocker, task.blockerType) : task.blockerType;
  const waiting = task.status === "blocked" && blockerType !== undefined;
  return {
    ...task,
    status: waiting ? "waiting" : task.status,
    blockerType,
    dependsOnTaskIds: Array.from(new Set(task.dependsOnTaskIds ?? [])),
    threadId: undefined,
  };
}

function normalizeLegacyMilestone(milestone: Milestone): Milestone {
  const blockerType = milestone.blocker ? inferBlockerType(milestone.blocker, milestone.blockerType) : milestone.blockerType;
  const waiting = milestone.status === "blocked" && blockerType !== undefined;
  return {
    ...milestone,
    status: waiting ? "waiting" : milestone.status,
    blockerType,
    threadId: undefined,
    lastTurnInputTokens: undefined,
    decisions: milestone.decisions ?? [],
    followUpNotes: milestone.followUpNotes ?? [],
    fileScope: milestone.fileScope ?? [],
    complexity: milestone.complexity ?? "normal",
    risk: milestone.risk ?? "medium",
    crossModule: Boolean(milestone.crossModule),
    requiresArchitectureChange: Boolean(milestone.requiresArchitectureChange),
    estimatedFiles: Math.max(1, milestone.estimatedFiles ?? milestone.fileScope?.length ?? 1),
    implementationLane: milestone.implementationLane,
    guardTrips: milestone.guardTrips ?? 0,
    lastGuardReason: milestone.lastGuardReason,
    executionSlices: (milestone.executionSlices ?? []).map((slice) => ({
      ...slice,
      fileScope: slice.fileScope ?? [],
      complexity: slice.complexity ?? "normal",
      risk: slice.risk ?? "medium",
      crossModule: Boolean(slice.crossModule),
      requiresArchitectureChange: Boolean(slice.requiresArchitectureChange),
      estimatedFiles: Math.max(1, slice.estimatedFiles ?? slice.fileScope?.length ?? 1),
      verificationBacked: Boolean(slice.verificationBacked),
      verificationEvidence: slice.verificationEvidence ?? [],
      decisionState: slice.decisionState ?? "open",
      decisionSummary: slice.decisionSummary ?? "",
      criticalDomain: Boolean(slice.criticalDomain),
      criticalDomainReason: slice.criticalDomainReason ?? "",
      atomic: Boolean(slice.atomic),
      atomicReason: slice.atomicReason ?? "",
      status: slice.status ?? "todo",
      attempts: slice.attempts ?? 0,
      threadId: undefined,
      lastTurnInputTokens: undefined,
    })),
  };
}

function migrateLegacy(raw: Record<string, unknown>): ProjectState {
  const now = new Date().toISOString();
  const legacyVersion = Number(raw.version ?? 1);
  const legacyTasks = Array.isArray(raw.tasks) ? raw.tasks as Task[] : [];
  const tasks = legacyTasks.map((task) => {
    // v0.2 had no milestone model. Preserve DONE; everything else remains executable.
    if (legacyVersion < 2) {
      return normalizeLegacyTask({
        ...task,
        status: task.status === "done" ? "done" : "todo",
        milestoneId: undefined,
      });
    }
    return normalizeLegacyTask(task);
  });

  const milestones = Array.isArray(raw.milestones)
    ? (raw.milestones as Milestone[]).map(normalizeLegacyMilestone)
    : [];

  const legacyMemory = raw.memory && typeof raw.memory === "object"
    ? raw.memory as Partial<ProjectMemoryState>
    : null;

  const memory: ProjectMemoryState = {
    summary: String(legacyMemory?.summary ?? raw.lastMessage ?? ""),
    decisions: Array.isArray(legacyMemory?.decisions) ? legacyMemory!.decisions!.map(String) : [],
    notes: Array.isArray(legacyMemory?.notes) ? legacyMemory!.notes!.map(String) : [],
  };

  for (const milestone of milestones.filter((item) => item.status === "done")) {
    if (milestone.summary) memory.notes.push(`${milestone.id}: ${milestone.summary}`);
    memory.decisions.push(...(milestone.decisions ?? []));
  }

  const hasExecutable = tasks.some((task) => task.status === "todo" || task.status === "failed" || task.status === "running");
  const v04NeedsOptimizationReplan = legacyVersion === 3 && hasExecutable;

  return {
    version: 4,
    projectRoot: String(raw.projectRoot ?? process.cwd()),
    goal: String(raw.goal ?? ""),
    status: (raw.status as ProjectState["status"]) ?? "idle",
    createdAt: String(raw.createdAt ?? now),
    updatedAt: now,
    tasks,
    milestones,
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints as ProjectState["checkpoints"] : [],
    memory,
    usage: raw.usage && typeof raw.usage === "object" ? { ...EMPTY_USAGE, ...(raw.usage as UsageTotals) } : { ...EMPTY_USAGE },
    usageHistory: Array.isArray(raw.usageHistory) ? raw.usageHistory as ProjectState["usageHistory"] : [],
    runCount: Number(raw.runCount ?? 0),
    milestonesSinceReplan: 0,
    needsReplan: legacyVersion < 2 ? true : v04NeedsOptimizationReplan || Boolean(raw.needsReplan),
    lastMessage: legacyVersion === 3
      ? "Migrated to MVPX v0.4.10 decision-complete hierarchical mode. Remaining executable work will be repacked conservatively with file scopes; legacy work defaults to Terra unless replanned with safe routing metadata."
      : String(raw.lastMessage ?? "Migrated to MVPX v0.4.10."),
    projectThreadId: undefined,
  };
}

export async function loadState(root: string): Promise<ProjectState | null> {
  try {
    const rawText = await readFile(path.join(mvpxDir(root), STATE_FILE), "utf8");
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    if (parsed.version === 4) {
      const state = parsed as unknown as ProjectState;
      state.usage ??= { ...EMPTY_USAGE };
      state.usageHistory ??= [];
      state.checkpoints ??= [];
      state.milestones ??= [];
      state.tasks ??= [];
      state.runCount ??= 0;
      state.milestonesSinceReplan ??= 0;
      state.memory ??= emptyMemory(String(state.lastMessage ?? ""));
      state.memory.decisions ??= [];
      state.memory.notes ??= [];
      state.projectThreadId = undefined;
      state.tasks = state.tasks.map(normalizeLegacyTask);
      state.milestones = state.milestones.map(normalizeLegacyMilestone);
      reconcileInternalDependencies(state);
      assertValidDependencyGraph(state.tasks);
      const executableRemaining = state.tasks.some((task) => task.status === "todo" || task.status === "failed" || task.status === "running");
      if (state.status === "blocked" && !executableRemaining && /^Final validation\b/i.test(state.lastMessage ?? "")) {
        state.status = "validation_pending";
      }
      return state;
    }
    return migrateLegacy(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveConfig(root: string, config: ProjectConfig): Promise<void> {
  await ensureMvpxDir(root);
  await writeFile(
    path.join(mvpxDir(root), CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  const defaults: ProjectConfig = {
    configVersion: 13,
    maxRetries: 3,
    maxTasksPerRun: 20,
    maxMilestonesPerRun: 8,

    plannerModel: "gpt-5.6-luna",
    plannerReasoningEffort: "medium",
    plannerEscalationReasoningEffort: "high",

    adaptiveImplementerRouting: true,
    simpleImplementerModel: "gpt-5.6-luna",
    simpleImplementerReasoningEffort: "high",
    simpleImplementerMaxEstimatedFiles: 6,

    scopedImplementerModel: "gpt-5.6-terra",
    scopedImplementerReasoningEffort: "medium",
    scopedImplementerMaxEstimatedFiles: 8,
    verificationBackedRouting: true,
    verificationBackedMaxEstimatedFiles: 2,
    decisionCompleteRouting: true,
    decisionCompleteMaxEstimatedFiles: 4,
    highSliceAtomicThreshold: 4,

    hierarchicalDecomposition: true,
    leadModel: "gpt-5.6-terra",
    leadReasoningEffort: "high",
    decomposeEstimatedFilesThreshold: 10,
    decomposePredictedInputTokensThreshold: 900_000,
    maxSlicesPerMilestone: 5,
    highCostMaxSlicesPerMilestone: 7,
    highCostSliceExpansionThreshold: 1_500_000,

    runBudgetEnabled: true,
    runBudgetMaxInputTokens: 4_000_000,
    runBudgetMaxLeadTerraHighTurns: 0,
    runBudgetPredictiveEnabled: true,
    runBudgetPredictiveSafetyFactor: 1.0,
    runBudgetMaxImplementationTerraHighTurns: 0,
    runBudgetMaxSolTurns: 1,

    defaultModel: "gpt-5.6-terra",
    defaultReasoningEffort: "high",
    escalationModel: "gpt-6-sol",
    escalationReasoningEffort: "high",
    escalateAtAttempt: 3,

    replanEveryMilestones: 0,
    maxTasksPerMilestone: 2,
    costAwareEstimatedFilesThreshold: 10,
    costHistoryMaxRecords: 80,

    incrementalGates: ["typecheck"],
    fullGates: ["lint", "typecheck", "test", "build", "quality", "quality:ui"],
    rollbackOnFailure: true,
    gates: "auto",

    maxTurnInputTokens: 750_000,
    memoryMaxChars: 18_000,
    finalRepairMemoryMaxChars: 6_000,
    retryBlockedByDefault: false,
    finalValidateEnvironmentWaiters: true,

    // v0.4.2: reaching the soft threshold is NOT an abort condition. It only
    // enables progress/stagnation analysis. Hard limits are deliberately high.
    guardSoftCommandThreshold: 50,
    guardHardCommandLimit: 200,
    guardHardToolEventLimit: 350,
    guardHardFilesChangedLimit: 120,
    guardMaxCommandsWithoutProgress: 24,
    guardMaxRepeatedCommand: 6,
    guardMaxNoProgressMs: 3 * 60 * 1000,
    maxTurnDurationMs: 25 * 60 * 1000,
    maxGuardContinuations: 1,
    maxTransportRetries: 2,
  };

  try {
    const raw = await readFile(path.join(mvpxDir(root), CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectConfig> & {
      model?: string;
      reasoningEffort?: ProjectConfig["defaultReasoningEffort"];
      maxCommandsPerTurn?: number;
      maxToolEventsPerTurn?: number;
      maxFilesChangedPerTurn?: number;
    };

    const parsedVersion = Number(parsed.configVersion ?? 1);
    const legacyConfig = parsedVersion < 2;
    const preProgressGuard = parsedVersion < 3;
    const {
      model: legacyModel,
      reasoningEffort: legacyReasoningEffort,
      maxCommandsPerTurn: _legacyCommands,
      maxToolEventsPerTurn: _legacyToolEvents,
      maxFilesChangedPerTurn: _legacyFiles,
      ...current
    } = parsed;

    const migrated: ProjectConfig = {
      ...defaults,
      ...current,
      configVersion: 13,
      adaptiveImplementerRouting: current.adaptiveImplementerRouting ?? defaults.adaptiveImplementerRouting,
      simpleImplementerModel: current.simpleImplementerModel ?? defaults.simpleImplementerModel,
      simpleImplementerReasoningEffort: current.simpleImplementerReasoningEffort ?? defaults.simpleImplementerReasoningEffort,
      simpleImplementerMaxEstimatedFiles: current.simpleImplementerMaxEstimatedFiles ?? defaults.simpleImplementerMaxEstimatedFiles,
      scopedImplementerModel: current.scopedImplementerModel ?? defaults.scopedImplementerModel,
      scopedImplementerReasoningEffort: current.scopedImplementerReasoningEffort ?? defaults.scopedImplementerReasoningEffort,
      scopedImplementerMaxEstimatedFiles: current.scopedImplementerMaxEstimatedFiles ?? defaults.scopedImplementerMaxEstimatedFiles,
      verificationBackedRouting: current.verificationBackedRouting ?? defaults.verificationBackedRouting,
      verificationBackedMaxEstimatedFiles: current.verificationBackedMaxEstimatedFiles ?? defaults.verificationBackedMaxEstimatedFiles,
      decisionCompleteRouting: current.decisionCompleteRouting ?? defaults.decisionCompleteRouting,
      decisionCompleteMaxEstimatedFiles: current.decisionCompleteMaxEstimatedFiles ?? defaults.decisionCompleteMaxEstimatedFiles,
      highSliceAtomicThreshold: current.highSliceAtomicThreshold ?? defaults.highSliceAtomicThreshold,
      hierarchicalDecomposition: current.hierarchicalDecomposition ?? defaults.hierarchicalDecomposition,
      leadModel: current.leadModel ?? defaults.leadModel,
      leadReasoningEffort: current.leadReasoningEffort ?? defaults.leadReasoningEffort,
      decomposeEstimatedFilesThreshold: current.decomposeEstimatedFilesThreshold ?? defaults.decomposeEstimatedFilesThreshold,
      decomposePredictedInputTokensThreshold: current.decomposePredictedInputTokensThreshold ?? defaults.decomposePredictedInputTokensThreshold,
      maxSlicesPerMilestone: current.maxSlicesPerMilestone ?? defaults.maxSlicesPerMilestone,
      highCostMaxSlicesPerMilestone: current.highCostMaxSlicesPerMilestone ?? defaults.highCostMaxSlicesPerMilestone,
      highCostSliceExpansionThreshold: current.highCostSliceExpansionThreshold ?? defaults.highCostSliceExpansionThreshold,
      runBudgetEnabled: current.runBudgetEnabled ?? defaults.runBudgetEnabled,
      runBudgetMaxInputTokens: current.runBudgetMaxInputTokens ?? defaults.runBudgetMaxInputTokens,
      runBudgetMaxLeadTerraHighTurns: parsedVersion < 7 && current.runBudgetMaxLeadTerraHighTurns === 1
        ? defaults.runBudgetMaxLeadTerraHighTurns
        : (current.runBudgetMaxLeadTerraHighTurns ?? defaults.runBudgetMaxLeadTerraHighTurns),
      runBudgetPredictiveEnabled: current.runBudgetPredictiveEnabled ?? defaults.runBudgetPredictiveEnabled,
      runBudgetPredictiveSafetyFactor: current.runBudgetPredictiveSafetyFactor ?? defaults.runBudgetPredictiveSafetyFactor,
      // v0.4.11 removes the rigid Terra High turn-count budget. Historical values
      // (including the v0.4.10 default of 3) migrate to token-first budgeting.
      runBudgetMaxImplementationTerraHighTurns: parsedVersion < 9
        ? defaults.runBudgetMaxImplementationTerraHighTurns
        : (current.runBudgetMaxImplementationTerraHighTurns ?? defaults.runBudgetMaxImplementationTerraHighTurns),
      runBudgetMaxSolTurns: current.runBudgetMaxSolTurns ?? defaults.runBudgetMaxSolTurns,
      defaultModel: current.defaultModel ?? legacyModel ?? defaults.defaultModel,
      defaultReasoningEffort: current.defaultReasoningEffort ?? legacyReasoningEffort ?? defaults.defaultReasoningEffort,
      // v0.4 used periodic replanning. v0.4.1+ intentionally uses event-driven replanning.
      replanEveryMilestones: legacyConfig ? 0 : (current.replanEveryMilestones ?? defaults.replanEveryMilestones),
      maxMilestonesPerRun: legacyConfig && current.maxMilestonesPerRun === 4
        ? defaults.maxMilestonesPerRun
        : (current.maxMilestonesPerRun ?? defaults.maxMilestonesPerRun),
      finalRepairMemoryMaxChars: current.finalRepairMemoryMaxChars ?? defaults.finalRepairMemoryMaxChars,
      memoryMaxChars: legacyConfig && current.memoryMaxChars === 24_000
        ? defaults.memoryMaxChars
        : (current.memoryMaxChars ?? defaults.memoryMaxChars),
      costAwareEstimatedFilesThreshold: current.costAwareEstimatedFilesThreshold ?? defaults.costAwareEstimatedFilesThreshold,
      costHistoryMaxRecords: current.costHistoryMaxRecords ?? defaults.costHistoryMaxRecords,
      // v0.4.1 used hard 20/50/25 activity caps. They intentionally do not carry
      // forward because those caps caused healthy work to thrash across continuations.
      guardSoftCommandThreshold: current.guardSoftCommandThreshold ?? defaults.guardSoftCommandThreshold,
      guardHardCommandLimit: current.guardHardCommandLimit ?? defaults.guardHardCommandLimit,
      guardHardToolEventLimit: current.guardHardToolEventLimit ?? defaults.guardHardToolEventLimit,
      guardHardFilesChangedLimit: current.guardHardFilesChangedLimit ?? defaults.guardHardFilesChangedLimit,
      guardMaxCommandsWithoutProgress: current.guardMaxCommandsWithoutProgress ?? defaults.guardMaxCommandsWithoutProgress,
      guardMaxRepeatedCommand: current.guardMaxRepeatedCommand ?? defaults.guardMaxRepeatedCommand,
      guardMaxNoProgressMs: current.guardMaxNoProgressMs ?? defaults.guardMaxNoProgressMs,
      maxTurnDurationMs: preProgressGuard && current.maxTurnDurationMs === 15 * 60 * 1000
        ? defaults.maxTurnDurationMs
        : (current.maxTurnDurationMs ?? defaults.maxTurnDurationMs),
      maxGuardContinuations: preProgressGuard && current.maxGuardContinuations === 2
        ? defaults.maxGuardContinuations
        : (current.maxGuardContinuations ?? defaults.maxGuardContinuations),
      maxTransportRetries: current.maxTransportRetries ?? defaults.maxTransportRetries,
    };

    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    throw error;
  }
}
