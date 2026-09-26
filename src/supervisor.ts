import { CodexRunner, type PlanResponse, type ReplanResponse } from "./codex/runner.js";
import type { Milestone, ProjectState, Task } from "./types.js";

export function nextMilestone(state: ProjectState): Milestone | undefined {
  return state.milestones
    .filter((milestone) => milestone.status === "todo" || milestone.status === "failed")
    .filter((milestone) => milestone.taskIds.some((id) => {
      const task = state.tasks.find((item) => item.id === id);
      return task && (task.status === "todo" || task.status === "failed" || task.status === "running");
    }))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
}

function flattenPlan(plan: PlanResponse): { tasks: Task[]; milestones: Milestone[] } {
  const tasks: Task[] = [];
  const milestones: Milestone[] = [];

  for (const milestone of plan.milestones) {
    const taskIds: string[] = [];
    for (const task of milestone.tasks) {
      taskIds.push(task.id);
      tasks.push({
        ...task,
        status: "todo",
        attempts: 0,
        milestoneId: milestone.id,
      });
    }
    milestones.push({
      id: milestone.id,
      title: milestone.title,
      description: milestone.description,
      priority: milestone.priority,
      taskIds,
      status: "todo",
      attempts: 0,
      decisions: [],
      followUpNotes: [],
      fileScope: milestone.fileScope ?? [],
      complexity: milestone.complexity ?? "normal",
      risk: milestone.risk ?? "medium",
      crossModule: Boolean(milestone.crossModule),
      requiresArchitectureChange: Boolean(milestone.requiresArchitectureChange),
      estimatedFiles: Math.max(1, milestone.estimatedFiles ?? milestone.fileScope?.length ?? 1),
      implementationLane: undefined,
      guardTrips: 0,
    });
  }

  return { tasks, milestones };
}

export async function createInitialState(
  root: string,
  goal: string,
  runner: CodexRunner,
): Promise<ProjectState> {
  const analysis = await runner.analyze(goal);
  const now = new Date().toISOString();
  const flattened = flattenPlan(analysis.result);

  return {
    version: 4,
    projectRoot: root,
    goal,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    tasks: flattened.tasks,
    milestones: flattened.milestones,
    checkpoints: [],
    memory: {
      summary: analysis.result.summary,
      decisions: [],
      notes: [],
    },
    usage: analysis.usage,
    usageHistory: [{
      ...analysis.usage,
      at: now,
      phase: "planning:audit",
      model: analysis.selection.model,
      threadId: analysis.threadId,
    }],
    runCount: 0,
    milestonesSinceReplan: 0,
    lastMessage: analysis.result.summary,
    projectThreadId: undefined,
  };
}

function uniqueMilestoneId(base: string, occupied: Set<string>): string {
  if (!occupied.has(base)) {
    occupied.add(base);
    return base;
  }
  let index = 2;
  while (occupied.has(`${base}-R${index}`)) index += 1;
  const id = `${base}-R${index}`;
  occupied.add(id);
  return id;
}

export function applyReplan(state: ProjectState, replan: ReplanResponse): void {
  const existingById = new Map(state.tasks.map((task) => [task.id, task]));
  const superseded = new Set(replan.supersededTaskIds);

  for (const id of superseded) {
    const existing = existingById.get(id);
    if (existing && existing.status !== "done" && existing.status !== "waiting" && existing.status !== "blocked") {
      existing.status = "superseded";
    }
  }

  // Historical and frozen milestones survive replanning. Only executable milestones are replaced.
  const preservedMilestones = state.milestones.filter((milestone) =>
    milestone.status === "done" ||
    milestone.status === "waiting" ||
    milestone.status === "blocked" ||
    milestone.status === "superseded"
  );
  const occupiedMilestoneIds = new Set(preservedMilestones.map((milestone) => milestone.id));

  const preservedTasks = state.tasks.filter((task) =>
    task.status === "done" ||
    task.status === "waiting" ||
    task.status === "blocked" ||
    task.status === "superseded"
  );
  const preservedTaskIds = new Set(preservedTasks.map((task) => task.id));
  const represented = new Set<string>();
  const replannedTasks: Task[] = [];
  const replannedMilestones: Milestone[] = [];

  for (const plannedMilestone of replan.milestones) {
    const milestoneId = uniqueMilestoneId(plannedMilestone.id, occupiedMilestoneIds);
    const taskIds: string[] = [];

    for (const plannedTask of plannedMilestone.tasks) {
      // Frozen/completed tasks are not allowed back into executable work.
      if (preservedTaskIds.has(plannedTask.id)) continue;
      represented.add(plannedTask.id);
      taskIds.push(plannedTask.id);
      const existing = existingById.get(plannedTask.id);
      replannedTasks.push({
        ...plannedTask,
        status: "todo",
        attempts: existing?.attempts ?? 0,
        milestoneId,
        summary: existing?.summary,
        changedFiles: existing?.changedFiles,
      });
    }

    if (taskIds.length === 0) continue;
    replannedMilestones.push({
      id: milestoneId,
      title: plannedMilestone.title,
      description: plannedMilestone.description,
      priority: plannedMilestone.priority,
      taskIds,
      status: "todo",
      attempts: 0,
      decisions: [],
      followUpNotes: [],
      fileScope: plannedMilestone.fileScope ?? [],
      complexity: plannedMilestone.complexity ?? "normal",
      risk: plannedMilestone.risk ?? "medium",
      crossModule: Boolean(plannedMilestone.crossModule),
      requiresArchitectureChange: Boolean(plannedMilestone.requiresArchitectureChange),
      estimatedFiles: Math.max(1, plannedMilestone.estimatedFiles ?? plannedMilestone.fileScope?.length ?? 1),
      implementationLane: undefined,
      guardTrips: 0,
    });
  }

  const omittedExecutable = state.tasks.filter((task) =>
    (task.status === "todo" || task.status === "failed" || task.status === "running") &&
    !represented.has(task.id) &&
    !superseded.has(task.id),
  ).map((task) => ({
    ...task,
    status: "todo" as const,
    blocker: undefined,
    blockerType: undefined,
  }));

  if (omittedExecutable.length > 0) {
    const fallbackId = uniqueMilestoneId("M-UNPLANNED", occupiedMilestoneIds);
    for (const task of omittedExecutable) task.milestoneId = fallbackId;
    replannedMilestones.push({
      id: fallbackId,
      title: "Preserved unresolved work",
      description: "Safety fallback for executable tasks omitted by replanning. Execute these tasks rather than silently dropping them.",
      priority: Math.max(...omittedExecutable.map((task) => task.priority), 1),
      taskIds: omittedExecutable.map((task) => task.id),
      status: "todo",
      attempts: 0,
      decisions: [],
      followUpNotes: [],
      fileScope: [],
      complexity: "normal",
      risk: "medium",
      crossModule: false,
      requiresArchitectureChange: false,
      estimatedFiles: 1,
      implementationLane: undefined,
      guardTrips: 0,
    });
  }

  state.tasks = [...preservedTasks, ...replannedTasks, ...omittedExecutable];
  state.milestones = [...preservedMilestones, ...replannedMilestones];
  state.needsReplan = false;
  state.milestonesSinceReplan = 0;
  state.lastMessage = replan.summary;
}
