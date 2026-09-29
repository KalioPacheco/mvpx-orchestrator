import type { BlockerType, ExecutionSlice, Milestone } from "./types.js";

/**
 * A WAIT caused by prerequisites, environment, credentials, safety or a product
 * decision is not an implementation failure. It must never advance the model
 * escalation ladder. Orchestration-budget waits are deliberately excluded: they
 * indicate execution behavior that may warrant a different retry strategy.
 */
const WAIT_NEUTRAL_BLOCKERS = new Set<BlockerType>([
  "internal_dependency",
  "external_dependency",
  "environment",
  "credential",
  "product_decision",
  "unsafe_action",
]);

export function isWaitNeutralBlocker(type?: BlockerType): boolean {
  return type !== undefined && WAIT_NEUTRAL_BLOCKERS.has(type);
}

export function neutralizeSliceWaitAttempt(slice: ExecutionSlice): boolean {
  if (!isWaitNeutralBlocker(slice.blockerType) || slice.waitAttemptNeutralized) return false;
  slice.attempts = Math.max(0, slice.attempts - 1);
  slice.waitAttemptNeutralized = true;
  return true;
}

export function neutralizeMilestoneWaitAttempt(milestone: Milestone): boolean {
  if (!isWaitNeutralBlocker(milestone.blockerType) || milestone.waitAttemptNeutralized) return false;
  milestone.attempts = Math.max(0, milestone.attempts - 1);
  milestone.waitAttemptNeutralized = true;
  return true;
}

/**
 * v0.4.14 could persist a dependency WAIT after already incrementing attempts.
 * On wake-up, repair that legacy state once. New v0.4.15 waits carry the marker
 * and therefore are not decremented twice.
 */
export function prepareSliceAfterWait(slice: ExecutionSlice): boolean {
  const migratedLegacyWait = isWaitNeutralBlocker(slice.blockerType) && !slice.waitAttemptNeutralized && slice.attempts > 0;
  if (migratedLegacyWait) slice.attempts = Math.max(0, slice.attempts - 1);
  slice.waitAttemptNeutralized = undefined;
  return migratedLegacyWait;
}

export function prepareMilestoneAfterWait(milestone: Milestone): boolean {
  const migratedLegacyWait = isWaitNeutralBlocker(milestone.blockerType) && !milestone.waitAttemptNeutralized && milestone.attempts > 0;
  if (migratedLegacyWait) milestone.attempts = Math.max(0, milestone.attempts - 1);
  milestone.waitAttemptNeutralized = undefined;
  return migratedLegacyWait;
}
