import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dependencyIssues,
  reconcileInternalDependencies,
  registerRuntimeInternalDependencies,
  selectNextReadyMilestone,
} from "../dist/dependencies.js";
import { loadState } from "../dist/state/store.js";

function task(id, status = "todo", deps = []) {
  return {
    id,
    title: id,
    description: id,
    priority: 50,
    acceptanceCriteria: [],
    status,
    attempts: 0,
    dependsOnTaskIds: deps,
    milestoneId: `M-${id.slice(5)}`,
  };
}

function milestone(id, taskId, priority, status = "todo", blocker, blockerType) {
  return {
    id,
    title: id,
    description: id,
    priority,
    taskIds: [taskId],
    status,
    attempts: 0,
    blocker,
    blockerType,
  };
}

function state(tasks, milestones) {
  return {
    version: 4,
    projectRoot: "/tmp/test",
    goal: "test",
    status: "idle",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tasks,
    milestones,
    checkpoints: [],
    memory: { summary: "", decisions: [], notes: [] },
    usage: { turns: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    usageHistory: [],
    runCount: 0,
    milestonesSinceReplan: 0,
  };
}

test("dependency readiness outranks milestone priority", () => {
  const s = state(
    [task("TASK-001"), task("TASK-002", "todo", ["TASK-001"]), task("TASK-003", "todo", ["TASK-001", "TASK-002"])],
    [milestone("M-003", "TASK-003", 100), milestone("M-002", "TASK-002", 90), milestone("M-001", "TASK-001", 1)],
  );
  assert.equal(selectNextReadyMilestone(s)?.id, "M-001");
  s.tasks[0].status = "done";
  s.milestones[2].status = "done";
  assert.equal(selectNextReadyMilestone(s)?.id, "M-002");
});

test("legacy external waiters are promoted and auto-resume in dependency order", () => {
  const t1 = task("TASK-001", "done");
  const t2 = task("TASK-002", "waiting");
  t2.attempts = 1;
  t2.blocker = "Missing direct prerequisite from TASK-001: package root.";
  t2.blockerType = "external_dependency";
  const t3 = task("TASK-003", "waiting");
  t3.attempts = 1;
  t3.blocker = "Required direct dependencies from TASK-001 and TASK-002 are not present.";
  t3.blockerType = "external_dependency";
  const m1 = milestone("M-001", "TASK-001", 10, "done");
  const m2 = milestone("M-002", "TASK-002", 20, "waiting", t2.blocker, "external_dependency");
  m2.attempts = 1;
  const m3 = milestone("M-003", "TASK-003", 30, "waiting", t3.blocker, "external_dependency");
  m3.attempts = 1;
  const s = state([t1, t2, t3], [m1, m2, m3]);

  const first = reconcileInternalDependencies(s);
  assert.equal(first.promoted, 2);
  assert.equal(first.unblocked, 1);
  assert.equal(m2.status, "todo");
  assert.equal(m2.attempts, 0, "legacy waiter must not resume as attempt 2");
  assert.equal(m3.status, "waiting");
  assert.equal(m3.blockerType, "internal_dependency");
  assert.deepEqual(t2.dependsOnTaskIds, ["TASK-001"]);
  assert.deepEqual(t3.dependsOnTaskIds, ["TASK-001", "TASK-002"]);
  assert.equal(selectNextReadyMilestone(s)?.id, "M-002");

  t2.status = "done";
  m2.status = "done";
  const second = reconcileInternalDependencies(s);
  assert.equal(second.unblocked, 1);
  assert.equal(m3.status, "todo");
  assert.equal(m3.attempts, 0, "legacy downstream waiter must resume without escalation");
  assert.equal(selectNextReadyMilestone(s)?.id, "M-003");
});

test("structured internal_dependency blockers register TASK ids even with terse text", () => {
  const s = state(
    [task("TASK-001"), task("TASK-002")],
    [milestone("M-001", "TASK-001", 1), milestone("M-002", "TASK-002", 2)],
  );
  const m2 = s.milestones[1];
  const result = registerRuntimeInternalDependencies(s, m2, "Waiting for TASK-001", "internal_dependency");
  assert.equal(result.type, "internal_dependency");
  assert.deepEqual(s.tasks[1].dependsOnTaskIds, ["TASK-001"]);
});

test("planned downstream milestones are parked until prerequisites complete", () => {
  const s = state(
    [task("TASK-001"), task("TASK-002", "todo", ["TASK-001"]), task("TASK-003", "todo", ["TASK-002"])],
    [milestone("M-003", "TASK-003", 100), milestone("M-002", "TASK-002", 90), milestone("M-001", "TASK-001", 1)],
  );
  const result = reconcileInternalDependencies(s);
  assert.equal(result.parked, 2);
  assert.equal(s.milestones.find((m) => m.id === "M-002").status, "waiting");
  assert.equal(s.milestones.find((m) => m.id === "M-003").blockerType, "internal_dependency");
  assert.equal(selectNextReadyMilestone(s)?.id, "M-001");
});

test("v0.4.13 waiting state migrates without manual retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mvpx-dependency-migrate-"));
  try {
    await mkdir(path.join(root, ".mvpx"), { recursive: true });
    const s = state(
      [task("TASK-001", "done"), task("TASK-002", "waiting"), task("TASK-003", "waiting")],
      [
        milestone("M-001", "TASK-001", 1, "done"),
        milestone("M-002", "TASK-002", 90, "waiting", "Missing direct prerequisite from TASK-001: mcp-server/package.json / MCP package root.", "external_dependency"),
        milestone("M-003", "TASK-003", 100, "waiting", "Required direct dependencies from TASK-001 and TASK-002 are not present in the shared worktree.", "external_dependency"),
      ],
    );
    s.projectRoot = root;
    s.status = "blocked";
    s.tasks[1].blocker = s.milestones[1].blocker;
    s.tasks[1].blockerType = "external_dependency";
    s.tasks[2].blocker = s.milestones[2].blocker;
    s.tasks[2].blockerType = "external_dependency";
    await writeFile(path.join(root, ".mvpx", "state.json"), JSON.stringify(s));

    const loaded = await loadState(root);
    assert.ok(loaded);
    assert.equal(loaded.status, "idle");
    assert.equal(loaded.milestones.find((m) => m.id === "M-002").status, "todo");
    assert.equal(loaded.milestones.find((m) => m.id === "M-003").status, "waiting");
    assert.equal(loaded.milestones.find((m) => m.id === "M-003").blockerType, "internal_dependency");
    assert.deepEqual(loaded.tasks.find((t) => t.id === "TASK-002").dependsOnTaskIds, ["TASK-001"]);
    assert.deepEqual(loaded.tasks.find((t) => t.id === "TASK-003").dependsOnTaskIds, ["TASK-001", "TASK-002"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency cycles are detected deterministically", () => {
  const issues = dependencyIssues([
    task("TASK-001", "todo", ["TASK-003"]),
    task("TASK-002", "todo", ["TASK-001"]),
    task("TASK-003", "todo", ["TASK-002"]),
  ]);
  const cycle = issues.find((issue) => issue.kind === "cycle");
  assert.ok(cycle);
  assert.match(cycle.message, /TASK-001|TASK-002|TASK-003/);
});

test("unknown dependencies are rejected deterministically", () => {
  const issues = dependencyIssues([task("TASK-001", "todo", ["TASK-999"])]);
  assert.equal(issues[0]?.kind, "unknown");
});

test("v0.4.14 waiting slice resumes on its base attempt after dependency wake", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mvpx-wait-neutral-migrate-"));
  try {
    await mkdir(path.join(root, ".mvpx"), { recursive: true });
    const t1 = task("TASK-001", "done");
    const t2 = task("TASK-002", "waiting");
    t2.dependsOnTaskIds = ["TASK-001"];
    t2.blocker = "Missing direct prerequisite from TASK-001: package root.";
    t2.blockerType = "external_dependency";
    const m1 = milestone("M-001", "TASK-001", 1, "done");
    const m2 = milestone("M-002", "TASK-002", 2, "waiting", t2.blocker, "external_dependency");
    m2.executionSlices = [{
      id: "M-002-S01",
      title: "Resume me",
      objective: "x",
      acceptanceCriteria: [],
      fileScope: ["package.json"],
      complexity: "normal",
      risk: "medium",
      crossModule: false,
      requiresArchitectureChange: false,
      estimatedFiles: 1,
      decisionState: "locked",
      criticalDomain: false,
      status: "waiting",
      attempts: 1,
      lane: "terra-medium",
      blocker: "Missing direct prerequisite from TASK-001: package root.",
      blockerType: "external_dependency",
    }];
    const s = state([t1, t2], [m1, m2]);
    s.projectRoot = root;
    s.status = "blocked";
    await writeFile(path.join(root, ".mvpx", "state.json"), JSON.stringify(s));

    const loaded = await loadState(root);
    assert.ok(loaded);
    const loadedMilestone = loaded.milestones.find((m) => m.id === "M-002");
    const loadedSlice = loadedMilestone.executionSlices[0];
    assert.equal(loadedMilestone.status, "todo");
    assert.equal(loadedSlice.status, "todo");
    assert.equal(loadedSlice.lane, "terra-medium");
    assert.equal(loadedSlice.attempts, 0, "dependency WAIT must not make resumed slice start at attempt 2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
