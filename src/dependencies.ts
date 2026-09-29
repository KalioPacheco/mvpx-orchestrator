import type { BlockerType, Milestone, ProjectState, Task } from "./types.js";
import { prepareMilestoneAfterWait, prepareSliceAfterWait } from "./attempts.js";

export interface DependencyIssue {
  kind: "unknown" | "self" | "cycle";
  message: string;
  taskIds: string[];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function taskDependencies(task: Task): string[] {
  return unique(task.dependsOnTaskIds ?? []).filter((id) => id !== task.id);
}

export function taskDependencySatisfied(state: ProjectState, taskId: string): boolean {
  const task = state.tasks.find((item) => item.id === taskId);
  return Boolean(task && (task.status === "done" || task.status === "superseded"));
}

export function milestoneDependencyIds(state: ProjectState, milestone: Milestone): string[] {
  const own = new Set(milestone.taskIds);
  return unique(
    milestone.taskIds.flatMap((id) => {
      const task = state.tasks.find((item) => item.id === id);
      return task ? taskDependencies(task) : [];
    }),
  ).filter((id) => !own.has(id));
}

export function milestoneDependenciesSatisfied(state: ProjectState, milestone: Milestone): boolean {
  return milestoneDependencyIds(state, milestone).every((id) => taskDependencySatisfied(state, id));
}

export function unresolvedMilestoneDependencies(state: ProjectState, milestone: Milestone): string[] {
  return milestoneDependencyIds(state, milestone).filter((id) => !taskDependencySatisfied(state, id));
}

export function selectNextReadyMilestone(state: ProjectState): Milestone | undefined {
  return state.milestones
    .filter((milestone) => milestone.status === "todo" || milestone.status === "failed")
    .filter((milestone) => milestone.taskIds.some((id) => {
      const task = state.tasks.find((item) => item.id === id);
      return task && (task.status === "todo" || task.status === "failed" || task.status === "running");
    }))
    .filter((milestone) => milestoneDependenciesSatisfied(state, milestone))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
}

export function dependencyIssues(tasks: Task[]): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    for (const dependencyId of task.dependsOnTaskIds ?? []) {
      if (dependencyId === task.id) {
        issues.push({ kind: "self", taskIds: [task.id], message: `${task.id} cannot depend on itself.` });
      } else if (!byId.has(dependencyId)) {
        issues.push({ kind: "unknown", taskIds: [task.id, dependencyId], message: `${task.id} depends on unknown task ${dependencyId}.` });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycleFound: string[] | undefined;

  const visit = (id: string): void => {
    if (cycleFound || visited.has(id)) return;
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      cycleFound = [...stack.slice(index), id];
      return;
    }
    visiting.add(id);
    stack.push(id);
    const task = byId.get(id);
    for (const dep of task?.dependsOnTaskIds ?? []) {
      if (byId.has(dep)) visit(dep);
      if (cycleFound) break;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) {
    visit(task.id);
    if (cycleFound) break;
  }

  if (cycleFound) {
    issues.push({
      kind: "cycle",
      taskIds: cycleFound,
      message: `Dependency cycle detected: ${cycleFound.join(" → ")}`,
    });
  }
  return issues;
}

export function assertValidDependencyGraph(tasks: Task[]): void {
  const issues = dependencyIssues(tasks);
  if (issues.length === 0) return;
  throw new Error(`Invalid task dependency graph:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}`);
}

export function extractInternalDependencyIds(state: ProjectState, milestone: Milestone, text: string | undefined | null): string[] {
  if (!text || !/(?:prerequis|dependenc|required direct|requires?|missing direct)/i.test(text)) return [];
  const taskRefs = unique(text.match(/\bTASK-[A-Za-z0-9._-]+\b/g) ?? []);
  const known = new Set(state.tasks.map((task) => task.id));
  const own = new Set(milestone.taskIds);
  return taskRefs.filter((id) => known.has(id) && !own.has(id));
}

export function registerRuntimeInternalDependencies(
  state: ProjectState,
  milestone: Milestone,
  blocker: string | undefined | null,
  suggestedType?: BlockerType | null,
): { type: BlockerType; dependencyIds: string[]; cycle?: string } {
  const dependencyIds = suggestedType === "internal_dependency"
    ? (() => {
        const known = new Set(state.tasks.map((task) => task.id));
        const own = new Set(milestone.taskIds);
        return unique((blocker ?? "").match(/\bTASK-[A-Za-z0-9._-]+\b/g) ?? []).filter((id) => known.has(id) && !own.has(id));
      })()
    : extractInternalDependencyIds(state, milestone, blocker);
  if (dependencyIds.length === 0) return { type: suggestedType ?? "unknown", dependencyIds: [] };

  for (const taskId of milestone.taskIds) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || task.status === "done" || task.status === "superseded") continue;
    task.dependsOnTaskIds = unique([...(task.dependsOnTaskIds ?? []), ...dependencyIds]);
  }

  const cycle = dependencyIssues(state.tasks).find((issue) => issue.kind === "cycle");
  if (cycle) return { type: "unknown", dependencyIds, cycle: cycle.message };
  return { type: "internal_dependency", dependencyIds };
}

function resetInternalSlice(milestone: Milestone): void {
  for (const slice of milestone.executionSlices ?? []) {
    if (slice.status !== "waiting" && slice.status !== "blocked") continue;
    if (slice.blockerType !== "internal_dependency") continue;
    prepareSliceAfterWait(slice);
    slice.status = "todo";
    slice.blocker = undefined;
    slice.blockerType = undefined;
    slice.threadId = undefined;
    slice.lastTurnInputTokens = undefined;
  }
}

/**
 * Reconcile runtime-discovered dependencies and automatically wake milestones whose
 * prerequisites are now satisfied. This is deterministic and spends no AI quota.
 */
export function reconcileInternalDependencies(state: ProjectState): { promoted: number; parked: number; unblocked: number } {
  let promoted = 0;
  let parked = 0;
  let unblocked = 0;

  // Convert dependency-blocked TODO work into an internal wait state before scheduling.
  // This keeps downstream work out of the executable count/queue while prerequisites run.
  for (const milestone of state.milestones) {
    if (milestone.status !== "todo" && milestone.status !== "failed") continue;
    const unresolved = unresolvedMilestoneDependencies(state, milestone);
    if (unresolved.length === 0) continue;
    milestone.status = "waiting";
    milestone.blockerType = "internal_dependency";
    milestone.blocker = `Waiting for internal prerequisites: ${unresolved.join(", ")}`;
    for (const taskId of milestone.taskIds) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.status === "done" || task.status === "superseded") continue;
      task.status = "waiting";
      task.blockerType = "internal_dependency";
      task.blocker = milestone.blocker;
    }
    parked += 1;
  }

  for (const milestone of state.milestones) {
    if (milestone.status !== "waiting" && milestone.status !== "blocked") continue;

    if (milestone.blockerType !== "internal_dependency") {
      const discovered = extractInternalDependencyIds(state, milestone, milestone.blocker);
      if (discovered.length > 0) {
        for (const taskId of milestone.taskIds) {
          const task = state.tasks.find((item) => item.id === taskId);
          if (!task || task.status === "done" || task.status === "superseded") continue;
          task.dependsOnTaskIds = unique([...(task.dependsOnTaskIds ?? []), ...discovered]);
          task.blockerType = "internal_dependency";
        }
        milestone.blockerType = "internal_dependency";
        for (const slice of milestone.executionSlices ?? []) {
          if (slice.status === "waiting" || slice.status === "blocked") slice.blockerType = "internal_dependency";
        }
        promoted += 1;
      }
    }

    if (milestone.blockerType !== "internal_dependency") continue;
    if (!milestoneDependenciesSatisfied(state, milestone)) continue;

    prepareMilestoneAfterWait(milestone);
    milestone.status = "todo";
    milestone.blocker = undefined;
    milestone.blockerType = undefined;
    milestone.threadId = undefined;
    milestone.lastTurnInputTokens = undefined;
    for (const taskId of milestone.taskIds) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.status === "done" || task.status === "superseded") continue;
      if (task.status === "waiting" || task.status === "blocked") task.status = "todo";
      task.blocker = undefined;
      task.blockerType = undefined;
    }
    resetInternalSlice(milestone);
    unblocked += 1;
  }

  if (state.status === "blocked") {
    const hasActionableExternalBlocker = state.milestones.some((milestone) =>
      (milestone.status === "waiting" || milestone.status === "blocked") &&
      milestone.blockerType !== "internal_dependency"
    );
    if (!hasActionableExternalBlocker) state.status = "idle";
  }

  return { promoted, parked, unblocked };
}
