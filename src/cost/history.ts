import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureMvpxDir, mvpxDir } from "../state/store.js";
import type { CostHistoryRecord, ExecutionSlice, Milestone, ProjectState, SliceLane, UsageTotals, WorkComplexity } from "../types.js";

const FILE = "cost-history.json";

function emptyUsage(): UsageTotals {
  return { turns: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

export async function loadCostHistory(root: string): Promise<CostHistoryRecord[]> {
  try {
    const raw = await readFile(path.join(mvpxDir(root), FILE), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as CostHistoryRecord[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveCostHistory(root: string, records: CostHistoryRecord[], maxRecords: number): Promise<void> {
  await ensureMvpxDir(root);
  const bounded = records.slice(-Math.max(10, maxRecords));
  await writeFile(path.join(mvpxDir(root), FILE), `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
}

function usageForMilestone(state: ProjectState, milestoneId: string): { usage: UsageTotals; models: string[] } {
  const usage = emptyUsage();
  const models = new Set<string>();
  for (const row of state.usageHistory) {
    if (!row.phase.startsWith(`${milestoneId}:`)) continue;
    usage.turns += row.turns;
    usage.inputTokens += row.inputTokens;
    usage.cachedInputTokens += row.cachedInputTokens;
    usage.cacheWriteInputTokens += row.cacheWriteInputTokens;
    usage.outputTokens += row.outputTokens;
    usage.reasoningOutputTokens += row.reasoningOutputTokens;
    models.add(row.model);
  }
  return { usage, models: Array.from(models) };
}


export async function recordValidationRepairCost(
  state: ProjectState,
  gateName: string,
  attempt: number,
  model: string,
  usage: UsageTotals,
  changedFiles: number,
  success: boolean,
  maxRecords: number,
): Promise<void> {
  if (usage.turns === 0 || usage.inputTokens <= 0) return;
  const records = await loadCostHistory(state.projectRoot);
  records.push({
    at: new Date().toISOString(),
    milestoneId: "FINAL-QA",
    title: `Validation repair: ${gateName} #${attempt}`,
    complexity: "normal",
    risk: "medium",
    taskCount: 0,
    estimatedFiles: Math.max(1, changedFiles),
    models: [model],
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    changedFiles,
    success,
    recordType: "validation-repair",
    gateName,
    repairAttempt: attempt,
  });
  await saveCostHistory(state.projectRoot, records, maxRecords);
}

export async function recordMilestoneCost(state: ProjectState, milestone: Milestone, maxRecords: number): Promise<void> {
  const { usage, models } = usageForMilestone(state, milestone.id);
  if (usage.turns === 0) return;
  const records = await loadCostHistory(state.projectRoot);
  records.push({
    at: new Date().toISOString(),
    milestoneId: milestone.id,
    title: milestone.title,
    complexity: milestone.complexity ?? "normal",
    risk: milestone.risk ?? "medium",
    taskCount: milestone.taskIds.length,
    estimatedFiles: milestone.estimatedFiles ?? (milestone.fileScope?.length ?? 0),
    models,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    changedFiles: milestone.changedFiles?.length ?? 0,
    success: milestone.status === "done",
    recordType: "milestone",
  });
  await saveCostHistory(state.projectRoot, records, maxRecords);
}


function usageForSlice(state: ProjectState, milestoneId: string, sliceId: string): { usage: UsageTotals; models: string[] } {
  const usage = emptyUsage();
  const models = new Set<string>();
  const prefix = `${milestoneId}:${sliceId}:`;
  for (const row of state.usageHistory) {
    if (!row.phase.startsWith(prefix)) continue;
    usage.turns += row.turns;
    usage.inputTokens += row.inputTokens;
    usage.cachedInputTokens += row.cachedInputTokens;
    usage.cacheWriteInputTokens += row.cacheWriteInputTokens;
    usage.outputTokens += row.outputTokens;
    usage.reasoningOutputTokens += row.reasoningOutputTokens;
    models.add(row.model);
  }
  return { usage, models: Array.from(models) };
}

function sliceRecordKey(record: CostHistoryRecord): string | undefined {
  if (record.recordType !== "slice" || !record.sliceId) return undefined;
  return `${record.milestoneId}:${record.sliceId}`;
}

export async function recordSliceCost(
  state: ProjectState,
  milestone: Milestone,
  slice: ExecutionSlice,
  maxRecords: number,
): Promise<CostHistoryRecord | undefined> {
  const { usage, models } = usageForSlice(state, milestone.id, slice.id);
  if (usage.turns === 0 || usage.inputTokens <= 0) return undefined;
  const records = await loadCostHistory(state.projectRoot);
  const key = `${milestone.id}:${slice.id}`;
  if (records.some((record) => sliceRecordKey(record) === key)) {
    return records.find((record) => sliceRecordKey(record) === key);
  }
  const record: CostHistoryRecord = {
    at: new Date().toISOString(),
    milestoneId: milestone.id,
    sliceId: slice.id,
    title: slice.title,
    complexity: slice.complexity,
    risk: slice.risk,
    taskCount: 1,
    estimatedFiles: slice.estimatedFiles,
    models,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    changedFiles: slice.changedFiles?.length ?? 0,
    success: slice.status === "done",
    recordType: "slice",
    lane: slice.lane,
    decisionState: slice.decisionState,
    criticalDomain: Boolean(slice.criticalDomain),
    crossModule: Boolean(slice.crossModule),
    requiresArchitectureChange: Boolean(slice.requiresArchitectureChange),
  };
  records.push(record);
  await saveCostHistory(state.projectRoot, records, maxRecords);
  return record;
}

/**
 * v0.4.11 migration/backfill: learn immediately from completed slices already present
 * in state.json so the next predictive decision does not start from a cold history.
 */
export async function backfillSliceCostHistory(state: ProjectState, maxRecords: number): Promise<number> {
  const records = await loadCostHistory(state.projectRoot);
  const seen = new Set(records.map(sliceRecordKey).filter((key): key is string => Boolean(key)));
  let added = 0;
  for (const milestone of state.milestones) {
    for (const slice of milestone.executionSlices ?? []) {
      if (slice.status !== "done") continue;
      const key = `${milestone.id}:${slice.id}`;
      if (seen.has(key)) continue;
      const { usage, models } = usageForSlice(state, milestone.id, slice.id);
      if (usage.turns === 0 || usage.inputTokens <= 0) continue;
      records.push({
        at: new Date().toISOString(),
        milestoneId: milestone.id,
        sliceId: slice.id,
        title: slice.title,
        complexity: slice.complexity,
        risk: slice.risk,
        taskCount: 1,
        estimatedFiles: slice.estimatedFiles,
        models,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        changedFiles: slice.changedFiles?.length ?? 0,
        success: true,
        recordType: "slice",
        lane: slice.lane,
        decisionState: slice.decisionState,
        criticalDomain: Boolean(slice.criticalDomain),
        crossModule: Boolean(slice.crossModule),
        requiresArchitectureChange: Boolean(slice.requiresArchitectureChange),
      });
      seen.add(key);
      added += 1;
    }
  }
  if (added > 0) await saveCostHistory(state.projectRoot, records, maxRecords);
  return added;
}

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

export function summarizeCostHistory(records: CostHistoryRecord[]): string {
  if (records.length === 0) {
    return "No historical MVPX cost observations yet. Use conservative packaging: simple/normal may contain up to 2 tasks; complex/critical should contain 1 task.";
  }

  const packageRecords = records.filter((row) => row.recordType !== "slice" && row.recordType !== "validation-repair");
  if (packageRecords.length === 0) {
    return "No historical MVPX implementation cost observations yet. Use conservative packaging: simple/normal may contain up to 2 tasks; complex/critical should contain 1 task.";
  }
  const levels: WorkComplexity[] = ["simple", "normal", "complex", "critical"];
  const lines: string[] = ["Historical MVPX implementation cost observations (use only as a packaging hint, never as a correctness shortcut):"];
  for (const level of levels) {
    const rows = packageRecords.filter((row) => row.complexity === level && row.success);
    if (!rows.length) continue;
    const perTask = rows.map((row) => Math.round(row.inputTokens / Math.max(1, row.taskCount)));
    lines.push(`- ${level}: ${rows.length} completed package(s), avg ${average(perTask).toLocaleString()} input tokens/task, avg ${average(rows.map((row) => row.changedFiles))} changed files/package.`);
  }

  const expensive = packageRecords
    .filter((row) => row.success)
    .slice()
    .sort((a, b) => (b.inputTokens / Math.max(1, b.taskCount)) - (a.inputTokens / Math.max(1, a.taskCount)))
    .slice(0, 5);
  if (expensive.length) {
    lines.push("Recent/high-cost examples:");
    for (const row of expensive) {
      lines.push(`- ${row.title}: ${row.taskCount} task(s), ${(row.inputTokens / 1_000_000).toFixed(2)}M input, complexity=${row.complexity}, risk=${row.risk}, models=${row.models.join("+") || "unknown"}.`);
    }
  }
  lines.push("Prefer one-task packages for historically expensive or cross-module work. Do not split tightly coupled work merely to reduce token estimates.");
  return lines.join("\n");
}

export async function costProfileForPlanner(root: string): Promise<string> {
  return summarizeCostHistory(await loadCostHistory(root));
}


export function estimateMilestoneInputTokens(
  records: CostHistoryRecord[],
  complexity: WorkComplexity,
  estimatedFiles: number,
  taskCount = 1,
): number {
  const packageRecords = records.filter((row) => row.recordType !== "slice" && row.recordType !== "validation-repair");
  const successful = packageRecords.filter((row) => row.success);
  const same = successful.filter((row) => row.complexity === complexity);
  const pool = same.length >= 2 ? same : successful;
  if (pool.length > 0) {
    const normalized = pool.map((row) => {
      const fileFactor = Math.max(1, row.estimatedFiles || row.changedFiles || 1);
      return row.inputTokens / fileFactor;
    });
    const perFile = normalized.reduce((a, b) => a + b, 0) / normalized.length;
    return Math.max(100_000, Math.round(perFile * Math.max(1, estimatedFiles)));
  }

  const baseByComplexity: Record<WorkComplexity, number> = {
    simple: 180_000,
    normal: 450_000,
    complex: 900_000,
    critical: 1_200_000,
  };
  const fileMultiplier = Math.max(1, estimatedFiles / 6);
  return Math.round(baseByComplexity[complexity] * fileMultiplier * Math.max(1, Math.min(taskCount, 2)));
}


/** Cost-weighted per-slice estimate used to decide whether another slice fits in this run. */
export function estimateSliceInputTokens(
  records: CostHistoryRecord[],
  slice: ExecutionSlice,
  lane: SliceLane,
): number {
  const sliceRows = records.filter((row) =>
    row.success && row.recordType === "slice" && row.lane === lane && row.inputTokens > 0
  );

  if (sliceRows.length > 0) {
    const scored = sliceRows.map((row) => {
      let score = 0;
      if (row.complexity !== slice.complexity) score += 3;
      if (row.risk !== slice.risk) score += 2;
      if ((row.decisionState ?? "open") !== (slice.decisionState ?? "open")) score += 2;
      if (Boolean(row.criticalDomain) !== Boolean(slice.criticalDomain)) score += 4;
      if (Boolean(row.requiresArchitectureChange) !== Boolean(slice.requiresArchitectureChange)) score += 4;
      if (Boolean(row.crossModule) !== Boolean(slice.crossModule)) score += 1;
      score += Math.min(4, Math.abs((row.estimatedFiles || 1) - Math.max(1, slice.estimatedFiles)) * 0.5);
      return { row, score };
    }).sort((a, b) => a.score - b.score);

    const nearest = scored.slice(0, Math.min(6, scored.length));
    let weightTotal = 0;
    let weighted = 0;
    for (const { row, score } of nearest) {
      const weight = 1 / (1 + score);
      // File count matters, but sublinearly: bounded reasoning cost is mostly context/semantics,
      // not a direct files*cost relationship. Cap the adjustment to avoid wild projections.
      const fileRatio = Math.max(0.65, Math.min(1.55, Math.pow(Math.max(1, slice.estimatedFiles) / Math.max(1, row.estimatedFiles), 0.35)));
      weighted += row.inputTokens * fileRatio * weight;
      weightTotal += weight;
    }
    const historical = Math.round(weighted / Math.max(0.0001, weightTotal));
    const floors: Record<SliceLane, number> = {
      "luna-high": 100_000,
      "terra-medium": 180_000,
      "terra-high": 250_000,
    };
    return Math.max(floors[lane], historical);
  }

  // Cold-start fallback. Once slice observations exist, the lane-aware nearest-neighbour
  // estimate above replaces these broad milestone-derived factors.
  const highEquivalent = estimateMilestoneInputTokens(records, slice.complexity, slice.estimatedFiles, 1);
  const laneFactor: Record<SliceLane, number> = {
    "luna-high": 0.42,
    "terra-medium": 0.65,
    "terra-high": 1.0,
  };
  const boundedFloor: Record<SliceLane, number> = {
    "luna-high": 120_000,
    "terra-medium": 220_000,
    "terra-high": 350_000,
  };
  return Math.max(boundedFloor[lane], Math.round(highEquivalent * laneFactor[lane]));
}

