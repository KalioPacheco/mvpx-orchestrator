import test from "node:test";
import assert from "node:assert/strict";
import {
  isWaitNeutralBlocker,
  neutralizeMilestoneWaitAttempt,
  neutralizeSliceWaitAttempt,
  prepareMilestoneAfterWait,
  prepareSliceAfterWait,
} from "../dist/attempts.js";

function slice(attempts = 1, blockerType = "internal_dependency") {
  return {
    id: "M-002-S01", title: "slice", objective: "x", acceptanceCriteria: [], fileScope: [],
    complexity: "normal", risk: "medium", crossModule: false, requiresArchitectureChange: false,
    estimatedFiles: 1, status: "waiting", attempts, lane: "terra-medium", blockerType,
  };
}

function milestone(attempts = 1, blockerType = "internal_dependency") {
  return { id: "M-002", title: "m", description: "x", priority: 1, taskIds: ["TASK-002"], status: "waiting", attempts, blockerType };
}

test("dependency/environment/user-action waits are attempt-neutral", () => {
  for (const type of ["internal_dependency", "external_dependency", "environment", "credential", "product_decision", "unsafe_action"]) {
    assert.equal(isWaitNeutralBlocker(type), true, type);
  }
  assert.equal(isWaitNeutralBlocker("orchestration_budget"), false);
  assert.equal(isWaitNeutralBlocker("unknown"), false);
});

test("a current slice WAIT refunds exactly one attempt", () => {
  const s = slice(2, "internal_dependency");
  assert.equal(neutralizeSliceWaitAttempt(s), true);
  assert.equal(s.attempts, 1);
  assert.equal(s.waitAttemptNeutralized, true);
  assert.equal(neutralizeSliceWaitAttempt(s), false);
  assert.equal(s.attempts, 1);
});

test("legacy v0.4.14 internal waiter is repaired once on wake", () => {
  const s = slice(1, "internal_dependency");
  assert.equal(s.waitAttemptNeutralized, undefined);
  assert.equal(prepareSliceAfterWait(s), true);
  assert.equal(s.attempts, 0);
  assert.equal(s.waitAttemptNeutralized, undefined);
});

test("v0.4.15 waiter is not decremented twice on wake", () => {
  const s = slice(2, "internal_dependency");
  neutralizeSliceWaitAttempt(s);
  assert.equal(s.attempts, 1);
  assert.equal(prepareSliceAfterWait(s), false);
  assert.equal(s.attempts, 1);
});

test("milestone waits follow the same neutral-attempt semantics", () => {
  const m = milestone(2, "environment");
  assert.equal(neutralizeMilestoneWaitAttempt(m), true);
  assert.equal(m.attempts, 1);
  assert.equal(prepareMilestoneAfterWait(m), false);
  assert.equal(m.attempts, 1);

  const legacy = milestone(1, "internal_dependency");
  assert.equal(prepareMilestoneAfterWait(legacy), true);
  assert.equal(legacy.attempts, 0);
});
