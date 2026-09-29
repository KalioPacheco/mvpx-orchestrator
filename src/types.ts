export type BlockerType =
  | "environment"
  | "credential"
  | "product_decision"
  | "unsafe_action"
  | "external_dependency"
  | "internal_dependency"
  | "orchestration_budget"
  | "unknown";


export type ValidationFailureKind = "environment" | "transient" | "code" | "visual" | "unknown";
export type WorkComplexity = "simple" | "normal" | "complex" | "critical";
export type WorkRisk = "low" | "medium" | "high";
export type ImplementerLane = "luna" | "terra";
export type SliceLane = "luna-high" | "terra-medium" | "terra-high";
export type SliceStatus = "todo" | "running" | "done" | "waiting" | "blocked" | "failed";
export type DecisionState = "open" | "locked";

export interface ValidationClassification {
  kind: ValidationFailureKind;
  confidence: number;
  reason: string;
  affectedFiles: string[];
}

export type TaskStatus = "todo" | "running" | "done" | "waiting" | "blocked" | "failed" | "superseded";
export type MilestoneStatus = "todo" | "running" | "done" | "waiting" | "blocked" | "failed" | "superseded";

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: number;
  acceptanceCriteria: string[];
  status: TaskStatus;
  attempts: number;
  milestoneId?: string;
  summary?: string;
  blocker?: string;
  blockerType?: BlockerType;
  changedFiles?: string[];
  // Explicit DAG prerequisites. A task is ready only after these task IDs are done/superseded.
  dependsOnTaskIds?: string[];
  // Legacy compatibility only. v0.4+ never resumes v0.2/v0.3 task threads.
  threadId?: string;
}


export interface ExecutionSlice {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  complexity: WorkComplexity;
  risk: WorkRisk;
  crossModule: boolean;
  requiresArchitectureChange: boolean;
  estimatedFiles: number;
  // True only when deterministic host-side checks strongly verify this slice's acceptance criteria.
  verificationBacked?: boolean;
  verificationEvidence?: string[];
  // v0.4.10: whether substantive design/semantic decisions are still open for the implementer.
  decisionState?: DecisionState;
  decisionSummary?: string;
  // True only when this slice directly modifies a core auth/authorization/tenant/payment/data-integrity invariant.
  criticalDomain?: boolean;
  criticalDomainReason?: string;
  // Large high-judgment slices must be explicitly atomic or be decomposed further by the lead.
  atomic?: boolean;
  atomicReason?: string;
  status: SliceStatus;
  attempts: number;
  lane?: SliceLane;
  summary?: string;
  changedFiles?: string[];
  decisions?: string[];
  blocker?: string;
  blockerType?: BlockerType;
  checkpointId?: string;
  threadId?: string;
  lastTurnInputTokens?: number;
  // v0.4.15: true when a WAIT already refunded the current model attempt.
  waitAttemptNeutralized?: boolean;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  priority: number;
  taskIds: string[];
  status: MilestoneStatus;
  attempts: number;
  summary?: string;
  blocker?: string;
  blockerType?: BlockerType;
  changedFiles?: string[];
  checkpointId?: string;
  // A thread belongs to this milestone only. It is never shared with other milestones.
  threadId?: string;
  lastTurnInputTokens?: number;
  decisions?: string[];
  followUpNotes?: string[];
  // Planner-provided narrow repository scope. Globs/directories are allowed.
  fileScope?: string[];
  // Planner-provided routing metadata. Conservative defaults keep legacy work on Terra.
  complexity?: WorkComplexity;
  risk?: WorkRisk;
  crossModule?: boolean;
  requiresArchitectureChange?: boolean;
  estimatedFiles?: number;
  implementationLane?: ImplementerLane;
  // Number of implementation turns proactively stopped by the activity guard.
  guardTrips?: number;
  lastGuardReason?: string;
  // Hierarchical decomposition. Broad work is decomposed by a technical lead; v0.4.10 can refine pending legacy slices once with decision-state metadata.
  executionSlices?: ExecutionSlice[];
  leadSummary?: string;
  leadDecisions?: string[];
  predictedInputTokens?: number;
  // v0.4.10 slice-plan semantics. Missing/<4 indicates a pre decision-complete plan.
  slicePlanVersion?: number;
  // v0.4.15: true when a WAIT already refunded the current model attempt.
  waitAttemptNeutralized?: boolean;
}

export interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TurnUsageRecord extends UsageTotals {
  at: string;
  phase: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  threadId?: string;
}

export interface GitCheckpoint {
  id: string;
  milestoneId: string;
  commit: string;
  ref: string;
  createdAt: string;
}

export interface ProjectMemoryState {
  summary: string;
  decisions: string[];
  notes: string[];
}

export interface ProjectState {
  version: 4;
  projectRoot: string;
  goal: string;
  status: "idle" | "running" | "done" | "blocked" | "failed" | "validation_pending";
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  milestones: Milestone[];
  checkpoints: GitCheckpoint[];
  memory: ProjectMemoryState;
  usage: UsageTotals;
  usageHistory: TurnUsageRecord[];
  runCount: number;
  milestonesSinceReplan: number;
  needsReplan?: boolean;
  lastMessage?: string;
  // Legacy v0.3 field is intentionally not used by v0.4+.
  projectThreadId?: string;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent";

export interface ProjectConfig {
  configVersion: 13;
  maxRetries: number;
  maxTasksPerRun: number;
  maxMilestonesPerRun: number;

  // Cheap coordination / planning lane.
  plannerModel: string;
  plannerReasoningEffort: ReasoningEffort;
  plannerEscalationReasoningEffort: ReasoningEffort;

  // Adaptive implementation lane. Simple + low-risk/local work may use Luna High.
  adaptiveImplementerRouting: boolean;
  simpleImplementerModel: string;
  simpleImplementerReasoningEffort: ReasoningEffort;
  simpleImplementerMaxEstimatedFiles: number;

  // Scoped normal execution lane used after a broad task has been decomposed.
  scopedImplementerModel: string;
  scopedImplementerReasoningEffort: ReasoningEffort;
  scopedImplementerMaxEstimatedFiles: number;
  // v0.4.9 compatibility: tightly scoped complex/high-risk slices may start on Terra Medium when deterministic verification is strong.
  verificationBackedRouting: boolean;
  verificationBackedMaxEstimatedFiles: number;
  // v0.4.10: a lead-locked, verification-backed non-critical slice can use Terra Medium.
  decisionCompleteRouting: boolean;
  decisionCompleteMaxEstimatedFiles: number;
  highSliceAtomicThreshold: number;

  // Technical-lead decomposition for expensive/broad milestones.
  hierarchicalDecomposition: boolean;
  leadModel: string;
  leadReasoningEffort: ReasoningEffort;
  decomposeEstimatedFilesThreshold: number;
  decomposePredictedInputTokensThreshold: number;
  maxSlicesPerMilestone: number;
  highCostMaxSlicesPerMilestone: number;
  highCostSliceExpansionThreshold: number;

  // Run budget: token-first safety stop. Model-turn counters are legacy compatibility only;
  // v0.4.11 budgets normal work by actual + predicted input cost.
  runBudgetEnabled: boolean;
  runBudgetMaxInputTokens: number;
  // Deprecated compatibility field. v0.4.10+ has no independent lead-turn cap; leads are governed by global input budget.
  runBudgetMaxLeadTerraHighTurns: number;
  runBudgetPredictiveEnabled: boolean;
  runBudgetPredictiveSafetyFactor: number;
  // Deprecated compatibility field. v0.4.11 does not cap normal Terra High by turn count.
  runBudgetMaxImplementationTerraHighTurns: number;
  runBudgetMaxSolTurns: number;

  // Primary code implementation lane.
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  escalationModel: string;
  escalationReasoningEffort: ReasoningEffort;
  escalateAtAttempt: number;

  // 0 = event-driven replanning only.
  replanEveryMilestones: number;
  maxTasksPerMilestone: number;
  costAwareEstimatedFilesThreshold: number;
  costHistoryMaxRecords: number;

  incrementalGates: string[];
  fullGates: string[];
  rollbackOnFailure: boolean;
  gates: "auto";

  // Bounded-context policy.
  maxTurnInputTokens: number;
  memoryMaxChars: number;
  // v0.4.13: validation repairs always start fresh and receive only a compact durable-memory handoff.
  finalRepairMemoryMaxChars: number;
  retryBlockedByDefault: boolean;
  finalValidateEnvironmentWaiters: boolean;

  // Progress-aware streaming activity guard. Soft command thresholds only activate
  // stagnation analysis; they do not abort healthy work by themselves.
  guardSoftCommandThreshold: number;
  guardHardCommandLimit: number;
  guardHardToolEventLimit: number;
  guardHardFilesChangedLimit: number;
  guardMaxCommandsWithoutProgress: number;
  guardMaxRepeatedCommand: number;
  guardMaxNoProgressMs: number;
  maxTurnDurationMs: number;
  maxGuardContinuations: number;

  // Infrastructure/CLI startup retries. These do not count as AI/model attempts.
  maxTransportRetries: number;
}

export interface ModelSelection {
  model: string;
  reasoningEffort: ReasoningEffort;
  escalated: boolean;
}

export interface ActivityGuardStats {
  commands: number;
  toolEvents: number;
  filesChanged: string[];
  elapsedMs: number;
  commandsSinceProgress: number;
  lastProgress: string;
  lastProgressAgeMs: number;
  repeatedCommand?: string;
  repeatedCommandCount?: number;
  reason: string;
}

export interface PreflightIssue {
  code: string;
  severity: "blocking" | "warning";
  message: string;
  remediation?: string;
}

export interface PreflightReport {
  ok: boolean;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  issues: PreflightIssue[];
  prepared: string[];
}

export interface CostHistoryRecord {
  at: string;
  milestoneId: string;
  title: string;
  complexity: WorkComplexity;
  risk: WorkRisk;
  taskCount: number;
  estimatedFiles: number;
  models: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  changedFiles: number;
  success: boolean;
  // Lane-aware observations let predictive budgeting learn from bounded slices; validation repairs are tracked separately.
  recordType?: "milestone" | "slice" | "validation-repair";
  sliceId?: string;
  lane?: SliceLane;
  decisionState?: DecisionState;
  criticalDomain?: boolean;
  crossModule?: boolean;
  requiresArchitectureChange?: boolean;
  gateName?: string;
  repairAttempt?: number;
}
