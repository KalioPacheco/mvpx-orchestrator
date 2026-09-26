import { Codex, type Thread } from "@openai/codex-sdk";
import type {
  ActivityGuardStats,
  BlockerType,
  Milestone,
  ModelSelection,
  ProjectConfig,
  ProjectState,
  Task,
  UsageTotals,
  GateResult,
  ValidationClassification,
  WorkComplexity,
  WorkRisk,
  ExecutionSlice,
  SliceLane,
} from "../types.js";
import { finalRepairSchema, milestoneResultSchema, planSchema, replanSchema, validationClassificationSchema, slicePlanSchema, sliceResultSchema } from "./schemas.js";

interface PlanTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  acceptanceCriteria: string[];
}

export interface PlanMilestone {
  id: string;
  title: string;
  description: string;
  priority: number;
  fileScope: string[];
  complexity: WorkComplexity;
  risk: WorkRisk;
  crossModule: boolean;
  requiresArchitectureChange: boolean;
  estimatedFiles: number;
  tasks: PlanTask[];
}

export interface PlanResponse {
  summary: string;
  milestones: PlanMilestone[];
}

export interface ReplanResponse extends PlanResponse {
  supersededTaskIds: string[];
}

export interface MilestoneResponse {
  status: "completed" | "blocked";
  summary: string;
  completedTaskIds: string[];
  changedFiles: string[];
  decisions: string[];
  followUpNotes: string[];
  blocker: string | null;
  blockerType: BlockerType | null;
  replanRecommended: boolean;
}

export interface FinalRepairResponse {
  status: "completed" | "blocked";
  summary: string;
  changedFiles: string[];
  decisions: string[];
  blocker: string | null;
  blockerType: BlockerType | null;
}

export interface ValidationRepairAttemptContext {
  summary: string;
  changedFiles: string[];
  decisions: string[];
}


export interface SlicePlanResponse {
  summary: string;
  decisions: string[];
  slices: Array<Omit<ExecutionSlice, "status" | "attempts" | "lane" | "summary" | "changedFiles" | "decisions" | "blocker" | "blockerType" | "checkpointId" | "threadId" | "lastTurnInputTokens">>;
}

export interface SliceResponse {
  status: "completed" | "blocked";
  summary: string;
  changedFiles: string[];
  decisions: string[];
  followUpNotes: string[];
  blocker: string | null;
  blockerType: BlockerType | null;
}

export interface RunnerResult<T> {
  result: T;
  threadId: string;
  usage: UsageTotals;
  selection: ModelSelection;
}

export class TurnGuardExceededError extends Error {
  constructor(
    public readonly threadId: string | undefined,
    public readonly stats: ActivityGuardStats,
  ) {
    super(`Codex activity guard stopped the turn: ${stats.reason}`);
    this.name = "TurnGuardExceededError";
  }
}

export class CodexTransportStartupError extends Error {
  constructor(public readonly originalMessage: string) {
    super(`Codex transport failed before the agent thread started: ${originalMessage}`);
    this.name = "CodexTransportStartupError";
  }
}

function isRetryableTransportStartupFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Reading prompt from stdin/i.test(message) ||
    /No prompt provided via stdin/i.test(message) ||
    /broken pipe|EPIPE|ECONNRESET|connection reset/i.test(message);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Codex returned invalid structured output: ${text}`, { cause: error });
  }
}

function toUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
} | null): UsageTotals {
  if (!usage) {
    return { turns: 1, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  }
  return {
    turns: 1,
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function compactTasks(tasks: Task[]): string {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    status: task.status,
    summary: task.summary,
    blocker: task.blocker,
    blockerType: task.blockerType,
    acceptanceCriteria: task.acceptanceCriteria,
  })).map((task) => JSON.stringify(task)).join("\n");
}

function alphaSuffix(index: number): string {
  let value = index;
  let output = "";
  do {
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return output;
}

function taskLimitForMilestone(milestone: PlanMilestone, config: ProjectConfig): number {
  if (milestone.complexity === "complex" || milestone.complexity === "critical") return 1;
  if (milestone.crossModule || milestone.requiresArchitectureChange) return 1;
  if ((milestone.estimatedFiles ?? 0) >= config.costAwareEstimatedFilesThreshold) return 1;
  return Math.max(1, config.maxTasksPerMilestone);
}

function normalizeMilestones(milestones: PlanMilestone[], config: ProjectConfig): PlanMilestone[] {
  const output: PlanMilestone[] = [];
  const occupied = new Set<string>();

  for (const raw of milestones) {
    const milestone: PlanMilestone = {
      ...raw,
      fileScope: raw.fileScope ?? [],
      complexity: raw.complexity ?? "normal",
      risk: raw.risk ?? "medium",
      crossModule: Boolean(raw.crossModule),
      requiresArchitectureChange: Boolean(raw.requiresArchitectureChange),
      estimatedFiles: Math.max(1, raw.estimatedFiles ?? raw.fileScope?.length ?? 1),
    };
    const limit = taskLimitForMilestone(milestone, config);
    const tasks = milestone.tasks ?? [];
    if (tasks.length <= limit) {
      let id = milestone.id;
      let n = 2;
      while (occupied.has(id)) id = `${milestone.id}-R${n++}`;
      occupied.add(id);
      output.push({ ...milestone, id });
      continue;
    }

    for (let i = 0; i < tasks.length; i += limit) {
      const chunk = tasks.slice(i, i + limit);
      let id = `${milestone.id}-${alphaSuffix(Math.floor(i / limit))}`;
      let n = 2;
      while (occupied.has(id)) id = `${milestone.id}-${alphaSuffix(Math.floor(i / limit))}-R${n++}`;
      occupied.add(id);
      output.push({
        ...milestone,
        id,
        title: `${milestone.title} (${Math.floor(i / limit) + 1}/${Math.ceil(tasks.length / limit)})`,
        description: `${milestone.description}\n\nThis is a cost-aware bounded work package split from ${milestone.id}; complete only the tasks listed here.`,
        estimatedFiles: Math.max(1, Math.ceil(milestone.estimatedFiles * (chunk.length / Math.max(1, tasks.length)))),
        tasks: chunk,
      });
    }
  }

  return output;
}


function normalizeCommandForGuard(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 500);
}

function shortCommand(command: string): string {
  const compact = command.trim().replace(/\s+/g, " ");
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function isValidationCommand(command: string): boolean {
  return /(?:^|\s)(?:typecheck|tsc|test|vitest|jest|lint|eslint|build|playwright|quality(?::ui)?)(?:\s|$)/i.test(command);
}

function isLikelyMutatingCommand(command: string): boolean {
  return /(?:apply_patch|sed\s+-i|perl\s+-pi|\btee\b|\btouch\b|\bmkdir\b|\bcp\b|\bmv\b|\brm\b|prettier[^\n]*--write|eslint[^\n]*--fix|(?:^|[^>])>>?\s*[^&])/i.test(command);
}

export class CodexRunner {
  private readonly codex = new Codex();

  constructor(
    private readonly root: string,
    private readonly config: ProjectConfig,
    private readonly costProfile = "",
  ) {}

  modelForAttempt(attempt: number): ModelSelection {
    const escalated = attempt >= this.config.escalateAtAttempt;
    return escalated
      ? {
          model: this.config.escalationModel,
          reasoningEffort: this.config.escalationReasoningEffort,
          escalated: true,
        }
      : {
          model: this.config.defaultModel,
          reasoningEffort: this.config.defaultReasoningEffort,
          escalated: false,
        };
  }

  planningModel(high = false): ModelSelection {
    return {
      model: this.config.plannerModel,
      reasoningEffort: high ? this.config.plannerEscalationReasoningEffort : this.config.plannerReasoningEffort,
      escalated: high,
    };
  }

  qualifiesForSimpleLane(milestone: Milestone): boolean {
    return Boolean(
      this.config.adaptiveImplementerRouting &&
      milestone.complexity === "simple" &&
      milestone.risk === "low" &&
      !milestone.crossModule &&
      !milestone.requiresArchitectureChange &&
      (milestone.estimatedFiles ?? 1) <= this.config.simpleImplementerMaxEstimatedFiles
    );
  }

  implementationModel(milestone: Milestone): ModelSelection {
    if (this.qualifiesForSimpleLane(milestone)) {
      return {
        model: this.config.simpleImplementerModel,
        reasoningEffort: this.config.simpleImplementerReasoningEffort,
        escalated: false,
      };
    }
    return {
      model: this.config.defaultModel,
      reasoningEffort: this.config.defaultReasoningEffort,
      escalated: false,
    };
  }

  milestoneRepairModel(milestone: Milestone): ModelSelection {
    const simpleProbe = milestone.implementationLane === "luna" || this.qualifiesForSimpleLane(milestone);
    const effectiveAttempt = simpleProbe ? Math.max(1, milestone.attempts - 1) : milestone.attempts;
    const escalated = effectiveAttempt >= this.config.escalateAtAttempt;
    return escalated
      ? {
          model: this.config.escalationModel,
          reasoningEffort: this.config.escalationReasoningEffort,
          escalated: true,
        }
      : {
          model: this.config.defaultModel,
          reasoningEffort: this.config.defaultReasoningEffort,
          escalated: false,
        };
  }

  shouldDecomposeMilestone(milestone: Milestone): boolean {
    if (!this.config.hierarchicalDecomposition) return false;
    if ((milestone.executionSlices ?? []).length > 0) return true;
    const files = milestone.estimatedFiles ?? 1;
    return milestone.complexity === "critical" ||
      milestone.requiresArchitectureChange === true ||
      milestone.crossModule === true ||
      files >= this.config.decomposeEstimatedFilesThreshold ||
      (milestone.predictedInputTokens ?? 0) >= this.config.decomposePredictedInputTokensThreshold;
  }

  leadModel(): ModelSelection {
    return {
      model: this.config.leadModel,
      reasoningEffort: this.config.leadReasoningEffort,
      escalated: false,
    };
  }

  sliceLane(slice: ExecutionSlice): SliceLane {
    // Luna remains intentionally strict: simple, low-risk, local, non-architectural.
    if (
      slice.complexity === "simple" &&
      slice.risk === "low" &&
      !slice.crossModule &&
      !slice.requiresArchitectureChange &&
      !slice.criticalDomain &&
      slice.estimatedFiles <= this.config.simpleImplementerMaxEstimatedFiles
    ) return "luna-high";

    // Core invariants and still-open design decisions stay on Terra High. The lead is
    // responsible for distinguishing nearby domain work from actually changing the invariant.
    if (
      slice.criticalDomain === true ||
      slice.complexity === "critical" ||
      slice.requiresArchitectureChange === true ||
      slice.decisionState !== "locked"
    ) return "terra-high";

    // v0.4.10: once the lead has LOCKED the substantive decision, a high-risk/complex
    // implementation can run on Terra Medium if it is bounded and strongly verifiable.
    if (
      this.config.decisionCompleteRouting &&
      slice.decisionState === "locked" &&
      (slice.complexity === "complex" || slice.risk === "high") &&
      slice.estimatedFiles <= this.config.decisionCompleteMaxEstimatedFiles &&
      slice.verificationBacked === true &&
      (slice.verificationEvidence?.length ?? 0) > 0
    ) return "terra-medium";

    // v0.4.9 compatibility: an ultra-bounded verification-backed complex/high slice
    // also qualifies, provided the lead explicitly locked the decision in v0.4.10 plans.
    if (
      this.config.verificationBackedRouting &&
      slice.complexity === "complex" &&
      slice.risk === "high" &&
      slice.estimatedFiles <= this.config.verificationBackedMaxEstimatedFiles &&
      slice.verificationBacked === true &&
      (slice.verificationEvidence?.length ?? 0) > 0
    ) return "terra-medium";

    // A bounded NORMAL slice may cross controller/service/route/test boundaries
    // without automatically becoming Terra High when the lead has closed the decision.
    if (
      (slice.complexity === "simple" || slice.complexity === "normal") &&
      slice.risk !== "high" &&
      slice.estimatedFiles <= this.config.scopedImplementerMaxEstimatedFiles
    ) return "terra-medium";

    return "terra-high";
  }

  sliceRoutingReason(slice: ExecutionSlice): string {
    const lane = slice.lane ?? this.sliceLane(slice);
    if (lane === "luna-high") return "simple + low-risk + local + non-architectural bounded slice";
    if (lane === "terra-medium") {
      if (slice.decisionState === "locked" && (slice.complexity === "complex" || slice.risk === "high")) {
        return `decision-complete execution: lead locked the substantive decision (${slice.decisionSummary || "contract specified"}); <=${this.config.decisionCompleteMaxEstimatedFiles} files, deterministic evidence=${(slice.verificationEvidence ?? []).join(" | ") || "declared"}; failure escalates immediately to Terra High`;
      }
      return slice.crossModule
        ? "normal bounded decision-complete slice; limited cross-module scope is allowed because architecture is unchanged"
        : "normal bounded implementation with medium-or-lower risk and no open design decision";
    }
    if (slice.criticalDomain) return `critical invariant stays on primary reasoning${slice.criticalDomainReason ? `: ${slice.criticalDomainReason}` : ""}`;
    if (slice.decisionState !== "locked") return "substantive design/semantic decision is still open";
    if (slice.requiresArchitectureChange) return "architecture change requires primary reasoning";
    if (slice.risk === "high") return "high-risk slice is not sufficiently bounded/verified for decision-complete routing";
    if (slice.complexity === "critical") return "critical slice requires primary reasoning";
    if (slice.complexity === "complex") return "complex slice requires primary reasoning";
    return "conservative fallback to primary implementer";
  }

  sliceCapForMilestone(milestone: Milestone): number {
    return (milestone.predictedInputTokens ?? 0) >= this.config.highCostSliceExpansionThreshold
      ? this.config.highCostMaxSlicesPerMilestone
      : this.config.maxSlicesPerMilestone;
  }

  sliceModel(slice: ExecutionSlice, attempt = 1): ModelSelection {
    const lane = slice.lane ?? this.sliceLane(slice);
    if (lane === "luna-high") {
      if (attempt === 1) return { model: this.config.simpleImplementerModel, reasoningEffort: this.config.simpleImplementerReasoningEffort, escalated: false };
      if (attempt === 2) return { model: this.config.scopedImplementerModel, reasoningEffort: this.config.scopedImplementerReasoningEffort, escalated: false };
      if (attempt === 3) return { model: this.config.defaultModel, reasoningEffort: this.config.defaultReasoningEffort, escalated: false };
      return { model: this.config.escalationModel, reasoningEffort: this.config.escalationReasoningEffort, escalated: true };
    }
    if (lane === "terra-medium") {
      if (attempt === 1) return { model: this.config.scopedImplementerModel, reasoningEffort: this.config.scopedImplementerReasoningEffort, escalated: false };
      if (attempt === 2) return { model: this.config.defaultModel, reasoningEffort: this.config.defaultReasoningEffort, escalated: false };
      return { model: this.config.escalationModel, reasoningEffort: this.config.escalationReasoningEffort, escalated: true };
    }
    if (attempt <= 2) return { model: this.config.defaultModel, reasoningEffort: this.config.defaultReasoningEffort, escalated: false };
    return { model: this.config.escalationModel, reasoningEffort: this.config.escalationReasoningEffort, escalated: true };
  }

  private thread(
    threadId: string | undefined,
    selection: ModelSelection,
    sandboxMode: "read-only" | "workspace-write",
    source: string,
  ): Thread {
    const options = {
      workingDirectory: this.root,
      sandboxMode,
      approvalPolicy: "never" as const,
      model: selection.model,
      modelReasoningEffort: selection.reasoningEffort,
      networkAccessEnabled: false,
      webSearchMode: "disabled" as const,
      threadSource: source,
    };
    return threadId ? this.codex.resumeThread(threadId, options) : this.codex.startThread(options);
  }

  private finish<T>(thread: Thread, finalResponse: string, usage: Parameters<typeof toUsage>[0], selection: ModelSelection): RunnerResult<T> {
    if (!thread.id) throw new Error("Codex did not return a thread ID.");
    return {
      result: parseJson<T>(finalResponse),
      threadId: thread.id,
      usage: toUsage(usage),
      selection,
    };
  }

  /**
   * Execute an implementation turn with a progress-aware activity guard.
   *
   * Command count is not an abort condition at the soft threshold. The guard only stops work when
   * observable activity suggests stagnation/repetition, or when a deliberately high circuit-breaker
   * limit/duration is reached. This avoids v0.4.1's 21-command thrashing while still protecting quota.
   */
  private async runGuarded<T>(
    thread: Thread,
    prompt: string,
    outputSchema: object,
    selection: ModelSelection,
  ): Promise<RunnerResult<T>> {
    const controller = new AbortController();
    const startedAt = Date.now();
    let commands = 0;
    let toolEvents = 0;
    const filesChanged = new Set<string>();
    let finalResponse = "";
    let usage: Parameters<typeof toUsage>[0] = null;
    let failure: string | null = null;
    let guardReason: string | null = null;
    let sawAnyEvent = false;

    let commandsSinceProgress = 0;
    let lastProgressAt = startedAt;
    let lastProgress = "turn started";
    let lastTodoCompleted = 0;
    const repeatedCommands = new Map<string, number>();
    let mostRepeatedCommand: string | undefined;
    let mostRepeatedCommandCount = 0;

    const markProgress = (reason: string): void => {
      commandsSinceProgress = 0;
      lastProgressAt = Date.now();
      lastProgress = reason;
      repeatedCommands.clear();
      mostRepeatedCommand = undefined;
      mostRepeatedCommandCount = 0;
    };

    const triggerGuard = (reason: string): void => {
      if (guardReason) return;
      guardReason = reason;
      controller.abort();
    };

    const evaluateGuard = (): void => {
      if (guardReason) return;
      const noProgressMs = Date.now() - lastProgressAt;

      // High circuit breakers are safety valves, not normal work budgets.
      if (this.config.guardHardCommandLimit > 0 && commands > this.config.guardHardCommandLimit) {
        triggerGuard(`hard command circuit breaker exceeded (${commands} > ${this.config.guardHardCommandLimit})`);
        return;
      }
      if (this.config.guardHardToolEventLimit > 0 && toolEvents > this.config.guardHardToolEventLimit) {
        triggerGuard(`hard tool-event circuit breaker exceeded (${toolEvents} > ${this.config.guardHardToolEventLimit})`);
        return;
      }
      if (this.config.guardHardFilesChangedLimit > 0 && filesChanged.size > this.config.guardHardFilesChangedLimit) {
        triggerGuard(`hard file-change circuit breaker exceeded (${filesChanged.size} > ${this.config.guardHardFilesChangedLimit})`);
        return;
      }

      // Before the soft threshold, allow broad setup/exploration. After it, stop only when there is
      // concrete evidence of a loop or sustained lack of progress.
      if (commands < this.config.guardSoftCommandThreshold) return;

      if (
        mostRepeatedCommand &&
        mostRepeatedCommandCount >= this.config.guardMaxRepeatedCommand &&
        commandsSinceProgress >= this.config.guardMaxRepeatedCommand
      ) {
        triggerGuard(
          `repeated command without progress (${mostRepeatedCommandCount}x): ${shortCommand(mostRepeatedCommand)}`,
        );
        return;
      }

      if (
        commandsSinceProgress >= this.config.guardMaxCommandsWithoutProgress &&
        noProgressMs >= this.config.guardMaxNoProgressMs
      ) {
        triggerGuard(
          `stalled after ${commandsSinceProgress} commands and ${Math.round(noProgressMs / 1000)}s without progress; last progress: ${lastProgress}`,
        );
      }
    };

    const timeout = setTimeout(() => {
      triggerGuard(`hard duration circuit breaker exceeded ${Math.round(this.config.maxTurnDurationMs / 60_000)} minutes`);
    }, this.config.maxTurnDurationMs);

    try {
      const { events } = await thread.runStreamed(prompt, {
        outputSchema,
        signal: controller.signal,
      });

      try {
        for await (const event of events) {
          sawAnyEvent = true;
          if (event.type === "item.started") {
            if (event.item.type === "command_execution") {
              commands += 1;
              toolEvents += 1;
              commandsSinceProgress += 1;

              const normalized = normalizeCommandForGuard(event.item.command);
              const count = (repeatedCommands.get(normalized) ?? 0) + 1;
              repeatedCommands.set(normalized, count);
              if (count > mostRepeatedCommandCount) {
                mostRepeatedCommand = normalized;
                mostRepeatedCommandCount = count;
              }
            } else if (event.item.type === "mcp_tool_call" || event.item.type === "web_search") {
              toolEvents += 1;
            }
          } else if (event.type === "item.updated") {
            if (event.item.type === "todo_list") {
              const completed = event.item.items.filter((item: { completed: boolean }) => item.completed).length;
              if (completed > lastTodoCompleted) {
                lastTodoCompleted = completed;
                markProgress(`todo progress (${completed}/${event.item.items.length})`);
              }
            }
          } else if (event.type === "item.completed") {
            if (event.item.type === "agent_message") {
              finalResponse = event.item.text;
            } else if (event.item.type === "file_change") {
              toolEvents += 1;
              for (const change of event.item.changes) filesChanged.add(change.path);
              markProgress(`file change (${event.item.changes.length} patch item(s))`);
            } else if (event.item.type === "command_execution") {
              if (event.item.exit_code === 0 && isValidationCommand(event.item.command)) {
                markProgress(`successful validation: ${shortCommand(event.item.command)}`);
              } else if (event.item.exit_code === 0 && isLikelyMutatingCommand(event.item.command)) {
                markProgress(`successful write command: ${shortCommand(event.item.command)}`);
              }
            } else if (event.item.type === "todo_list") {
              const completed = event.item.items.filter((item: { completed: boolean }) => item.completed).length;
              if (completed > lastTodoCompleted) {
                lastTodoCompleted = completed;
                markProgress(`todo progress (${completed}/${event.item.items.length})`);
              }
            }
          } else if (event.type === "turn.completed") {
            usage = event.usage;
          } else if (event.type === "turn.failed") {
            failure = event.error.message;
          } else if (event.type === "error") {
            failure = event.message;
          }

          evaluateGuard();
        }
      } catch (error) {
        if (guardReason) {
          // handled below as TurnGuardExceededError
        } else if (!sawAnyEvent && isRetryableTransportStartupFailure(error)) {
          throw new CodexTransportStartupError(error instanceof Error ? error.message : String(error));
        } else {
          throw error;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (guardReason) {
      throw new TurnGuardExceededError(thread.id ?? undefined, {
        commands,
        toolEvents,
        filesChanged: Array.from(filesChanged),
        elapsedMs: Date.now() - startedAt,
        commandsSinceProgress,
        lastProgress,
        lastProgressAgeMs: Date.now() - lastProgressAt,
        repeatedCommand: mostRepeatedCommand,
        repeatedCommandCount: mostRepeatedCommandCount || undefined,
        reason: guardReason,
      });
    }
    if (failure) throw new Error(failure);
    if (!finalResponse) throw new Error("Codex turn completed without a final structured response.");
    return this.finish<T>(thread, finalResponse, usage, selection);
  }

  /** One-time broad audit. Planner is Luna Medium by default; its thread is never reused by implementation. */
  async analyze(goal: string): Promise<RunnerResult<PlanResponse>> {
    const selection = this.planningModel();
    const thread = this.thread(undefined, selection, "read-only", "mvpx-audit");
    const turn = await thread.run(
      `You are the planning supervisor for a long-running autonomous software engineering goal.\n\n` +
      `PROJECT GOAL:\n${goal}\n\n` +
      `Audit the repository ONCE and create a compact execution plan. Simple/normal milestones may contain at most ${this.config.maxTasksPerMilestone} closely related task(s); complex/critical, cross-module, architectural, or broad milestones should contain exactly 1 task. ` +
      `For every milestone provide fileScope plus complexity (simple|normal|complex|critical), risk (low|medium|high), crossModule, requiresArchitectureChange, and estimatedFiles. ` +
      `Mark SIMPLE only when the acceptance criteria are explicit, the change is local/low-risk, it does not alter architecture/contracts/permissions/security, and it should touch few files. ` +
      `NORMAL is the safe default. COMPLEX/CRITICAL are for cross-cutting architecture, auth/RBAC, data contracts, high-frequency transactional flows, migrations, or other high-risk changes. ` +
      `The metadata controls model routing, so under-classifying complexity to save tokens is incorrect. ` +
      `For every milestone provide fileScope: a short list of repository directories/files/globs the implementer should inspect first. Make it narrow but sufficient. ` +
      (this.costProfile ? `\n\nCOST-AWARE PACKAGING HISTORY:\n${this.costProfile}\n\n` : "") +
      `Preserve any explicitly requested skill or workflow (for example ui-craft) as a requirement in the relevant milestone descriptions. ` +
      `Order correctness, blockers and architecture before polish, while respecting the project goal. ` +
      `Do not modify files in this planning turn. Use IDs M-001 and TASK-001 style. Avoid redundant tasks and unnecessary micro-tasks. ` +
      `The summary must be a compact durable handoff describing architecture, constraints and the overall plan; later implementation threads will be fresh and bounded.`,
      { outputSchema: planSchema },
    );
    const result = this.finish<PlanResponse>(thread, turn.finalResponse, turn.usage, selection);
    result.result.milestones = normalizeMilestones(result.result.milestones, this.config);
    return result;
  }

  /** Replanning is stateless, event-driven and cheap: Luna Medium + bounded memory + current backlog only. */
  async replan(state: ProjectState, projectMemory: string): Promise<RunnerResult<ReplanResponse>> {
    const selection = this.planningModel();
    const thread = this.thread(undefined, selection, "read-only", "mvpx-replan");
    const unresolved = state.tasks.filter((task) => task.status === "todo" || task.status === "failed" || task.status === "running");
    const frozen = state.tasks.filter((task) => task.status === "waiting" || task.status === "blocked");
    const turn = await thread.run(
      `You are a fresh planning thread. Reconcile ONLY the remaining executable backlog; do not perform a full audit.\n\n` +
      `BOUNDED PROJECT MEMORY:\n${projectMemory}\n\n` +
      `EXECUTABLE UNRESOLVED TASKS (${unresolved.length}):\n${compactTasks(unresolved)}\n\n` +
      `FROZEN BLOCKERS — DO NOT RESCHEDULE OR RETRY (${frozen.length}):\n${compactTasks(frozen)}\n\n` +
      `Inspect only repository areas necessary to reconcile executable work with the current code. ` +
      `Create cost-aware work packages. Simple/normal may contain at most ${this.config.maxTasksPerMilestone} closely related task(s); complex/critical, cross-module, architectural, or broad work should contain exactly 1 task. ` +
      `Every milestone must include fileScope, complexity, risk, crossModule, requiresArchitectureChange, and estimatedFiles. Use NORMAL when uncertain; SIMPLE is reserved for clearly local, low-risk, non-architectural work. ` +
      (this.costProfile ? `\n\nCOST-AWARE PACKAGING HISTORY:\n${this.costProfile}\n\n` : "") +
      `Every milestone must include a narrow fileScope of likely files/directories/globs so the implementer does not rediscover the whole repository. ` +
      `Preserve existing task IDs whenever a task still exists. If an executable task became unnecessary because earlier work already solved it, list its ID in supersededTaskIds. ` +
      `Do not include frozen blocker tasks in milestones. Add a new task only for a concrete issue discovered while reconciling current work.`,
      { outputSchema: replanSchema },
    );
    const result = this.finish<ReplanResponse>(thread, turn.finalResponse, turn.usage, selection);
    result.result.milestones = normalizeMilestones(result.result.milestones, this.config);
    return result;
  }

  /** Technical-lead decomposition for broad/expensive work. Read-only and bounded. */
  async decomposeMilestone(
    state: ProjectState,
    milestone: Milestone,
    projectMemory: string,
    planFeedback?: string,
  ): Promise<RunnerResult<SlicePlanResponse>> {
    const selection = this.leadModel();
    const thread = this.thread(undefined, selection, "read-only", `mvpx-${milestone.id.toLowerCase()}-lead`);
    const tasks = milestone.taskIds
      .map((id) => state.tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task) && task!.status !== "done" && task!.status !== "superseded");
    const scope = (milestone.fileScope ?? []).length > 0 ? milestone.fileScope!.map((entry) => `- ${entry}`).join("\n") : "- Discover only the direct files needed for this milestone.";
    const completedSlices = (milestone.executionSlices ?? []).filter((slice) => slice.status === "done");
    const completedSliceContext = completedSlices.length
      ? completedSlices.map((slice) => `- ${slice.id}: ${slice.title} — ${slice.summary ?? "completed"}; files=${(slice.changedFiles ?? slice.fileScope).join(", ")}`).join("\n")
      : "- none";
    const sliceCap = this.sliceCapForMilestone(milestone);
    const prompt =
      `You are the TECHNICAL LEAD for one broad/high-cost milestone. Do not modify files. Decompose the implementation into 2-${sliceCap} execution slices that can be completed independently or sequentially with minimal context.\n\n` +
      `BOUNDED PROJECT MEMORY:\n${projectMemory}\n\n` +
      `MILESTONE ${milestone.id}: ${milestone.title}\n${milestone.description}\n\n` +
      `PARENT ROUTING: complexity=${milestone.complexity ?? "normal"}, risk=${milestone.risk ?? "medium"}, crossModule=${Boolean(milestone.crossModule)}, architectureChange=${Boolean(milestone.requiresArchitectureChange)}, estimatedFiles=${milestone.estimatedFiles ?? "unknown"}.\n\n` +
      `PRIMARY SCOPE:\n${scope}\n\n` +
      `ALREADY COMPLETED SLICES (preserve these changes; NEVER redo them):\n${completedSliceContext}\n\n` +
      (planFeedback ? `PREVIOUS PLAN FEEDBACK — fix these issues in the new decomposition:\n${planFeedback}\n\n` : "") +
      `TASKS:\n${tasks.map((task) => `${task.id} - ${task.title}\n${task.description}\nAcceptance:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`).join("\n\n")}\n\n` +
      `Rules: preserve behavior unless fixing a demonstrated bug; identify invariants and ordering constraints; keep each slice narrow (ideally <= ${this.config.scopedImplementerMaxEstimatedFiles} files); isolate tests/DTO/error handling/mechanical follow-up when safe; do NOT invent architecture churn merely to create slices. ` +
      `Optimize the decomposition for the CHEAPEST SAFE EXECUTION MODEL: separate mechanical tests, DTO/validation, migrations, adapters, and localized follow-up from the genuinely high-judgment core when they can remain independently buildable. This is not permission to under-classify risk. ` +
      `Do not copy the parent milestone's criticality/crossModule flags into every child. Classify EACH slice independently from its own objective and file scope. A parent may be critical while a child is NORMAL/MEDIUM if the lead has already resolved the architectural decision and the child is a bounded implementation. ` +
      `Every slice must leave the repository able to pass the configured incremental gate (normally typecheck). If a contract change and its consumers cannot be separated safely, keep them in the same slice even if that slice is larger. ` +
      `Each slice must include narrow fileScope, complexity/risk, crossModule, architecture-change flag, estimatedFiles, concrete acceptance criteria, verificationBacked, verificationEvidence, decisionState, decisionSummary, criticalDomain, criticalDomainReason, atomic, and atomicReason. SIMPLE must be truly mechanical/local/low-risk. NORMAL is the default for bounded implementation after the lead has made the hard decision. ` +
      `decisionState=OPEN means the implementer still has to make a substantive architectural/semantic decision. decisionState=LOCKED means YOU, the lead, have already specified the contract/algorithm/invariant well enough that implementation should follow it rather than redesign it; put that specification in decisionSummary. ` +
      `criticalDomain=true ONLY when this slice directly changes a core authentication, authorization, tenant-isolation, payment-integrity, or data-integrity invariant. Do not mark a slice criticalDomain merely because it lives near payments/auth; explain the exact invariant in criticalDomainReason. ` +
      `Set verificationBacked=true ONLY when deterministic host-side checks (for example a targeted unit/integration test, typecheck contract, migration assertion, lint/build check) strongly detect an incorrect implementation; list those exact checks/files in verificationEvidence. Do not use verificationBacked merely because tests exist somewhere in the repo. ` +
      `The execution router maps SIMPLE/local/low-risk to Luna High; NORMAL bounded execution to Terra Medium; and COMPLEX/HIGH decision-complete slices to Terra Medium only when LOCKED, non-critical, non-architectural, <=${this.config.decisionCompleteMaxEstimatedFiles} files and verification-backed. CRITICAL domains, architecture changes, broad slices, or OPEN decisions stay Terra High. ` +
      `Any slice that you expect to require Terra High and touches more than ${this.config.highSliceAtomicThreshold} files must set atomic=true and provide atomicReason explaining why further decomposition would break buildability/invariants. If you cannot justify atomicity, split it further before returning the plan. Under-classifying merely to save tokens is incorrect. ` +
      `If completed slices are listed above, decompose ONLY the remaining work and preserve their contracts/decisions. Do not generate slices for work they already completed. ` +
      `For predicted high-cost milestones you may use up to ${sliceCap} slices when finer decomposition safely moves real work from Terra High to Terra Medium/Luna High. Return durable lead decisions that later slices must preserve.`;
    return this.runGuarded<SlicePlanResponse>(thread, prompt, slicePlanSchema, selection);
  }

  async executeSlice(
    state: ProjectState,
    milestone: Milestone,
    slice: ExecutionSlice,
    projectMemory: string,
    attempt = 1,
    previousFailure?: string,
  ): Promise<RunnerResult<SliceResponse>> {
    const selection = this.sliceModel(slice, attempt);
    const thread = this.thread(undefined, selection, "workspace-write", `mvpx-${milestone.id.toLowerCase()}-${slice.id.toLowerCase()}`);
    const scope = slice.fileScope.length ? slice.fileScope.map((entry) => `- ${entry}`).join("\n") : "- Use the narrowest files directly implied by the slice.";
    const previous = previousFailure ? `PREVIOUS HOST-GATE FAILURE (fix this, do not restart broad exploration):\n${previousFailure}\n\n` : "";
    const prompt =
      `You are executing ONE bounded implementation slice from a lead-approved plan. Do not re-audit the parent milestone.\n\n` +
      `BOUNDED PROJECT MEMORY:\n${projectMemory}\n\n` +
      `PARENT MILESTONE: ${milestone.id} ${milestone.title}\nLead summary: ${milestone.leadSummary ?? milestone.description}\nLead decisions: ${(milestone.leadDecisions ?? []).join(" | ") || "none recorded"}\n\n` +
      `SLICE ${slice.id}: ${slice.title}\nOBJECTIVE: ${slice.objective}\n\nFILE SCOPE:\n${scope}\n\n` +
      `ACCEPTANCE:\n${slice.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n` + previous +
      `ROUTING: complexity=${slice.complexity}, risk=${slice.risk}, crossModule=${slice.crossModule}, architectureChange=${slice.requiresArchitectureChange}, estimatedFiles=${slice.estimatedFiles}, decisionState=${slice.decisionState ?? "open"}, decisionSummary=${slice.decisionSummary ?? ""}, criticalDomain=${Boolean(slice.criticalDomain)}, criticalDomainReason=${slice.criticalDomainReason ?? ""}, atomic=${Boolean(slice.atomic)}, atomicReason=${slice.atomicReason ?? ""}, verificationBacked=${Boolean(slice.verificationBacked)}, verificationEvidence=${(slice.verificationEvidence ?? []).join(" | ") || "none"}. ` +
      `Implement only this slice. Prefer direct edits. Leave scope only for a concrete direct dependency. Do not run the full suite; MVPX runs host-side gates. ` +
      `Do not commit, push, alter secrets, install global/system packages, deploy, or perform destructive Git operations.`;
    return this.runGuarded<SliceResponse>(thread, prompt, sliceResultSchema, selection);
  }

  /** First implementation slice for a milestone. Uses adaptive Luna/ Terra routing with the same proactive stream guard. */
  async executeMilestone(
    state: ProjectState,
    milestone: Milestone,
    projectMemory: string,
    continuationNote?: string,
  ): Promise<RunnerResult<MilestoneResponse>> {
    const selection = this.implementationModel(milestone);
    const thread = this.thread(undefined, selection, "workspace-write", `mvpx-${milestone.id.toLowerCase()}`);
    const tasks = milestone.taskIds
      .map((id) => state.tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task) && task!.status !== "done" && task!.status !== "superseded");
    const scope = (milestone.fileScope ?? []).length > 0
      ? milestone.fileScope!.map((entry) => `- ${entry}`).join("\n")
      : "- No planner scope available. Discover the narrowest relevant scope from the tasks; do not audit the repository broadly.";

    const prompt =
      `You are starting a FRESH bounded implementation thread for one small work package. ` +
      `The project memory is a durable handoff; it is not permission to re-audit the repository.\n\n` +
      `BOUNDED PROJECT MEMORY:\n${projectMemory}\n\n` +
      `MILESTONE ${milestone.id}: ${milestone.title}\n${milestone.description}\n\n` +
      `PRIMARY FILE SCOPE (inspect these first; leave this scope only for a concrete direct dependency):\n${scope}\n\n` +
      (continuationNote ? `CONTINUATION FROM A PREVIOUS BOUNDED SLICE:\n${continuationNote}\n\n` : "") +
      `TASKS:\n${tasks.map((task) => `${task.id} - ${task.title}\n${task.description}\nAcceptance:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`).join("\n\n")}\n\n` +
      `ROUTING METADATA: complexity=${milestone.complexity ?? "normal"}, risk=${milestone.risk ?? "medium"}, crossModule=${Boolean(milestone.crossModule)}, architectureChange=${Boolean(milestone.requiresArchitectureChange)}, estimatedFiles=${milestone.estimatedFiles ?? "unknown"}. ` +
      `Implement only this work package. Prefer direct edits over exploratory browsing. Reuse existing project conventions and requested skills. ` +
      `Do not run the full project validation suite; MVPX executes deterministic host-side gates after you finish. Run only a targeted cheap command if it is needed to make a coding decision. ` +
      `If browser/server validation cannot bind localhost inside the sandbox, do not retry it repeatedly. ` +
      `Do not commit, push, alter secrets, install global/system packages, deploy, or perform destructive Git operations. ` +
      `Return blocked only for a real external dependency, credential, unsafe action, environment limitation, or product decision that cannot be safely inferred. ` +
      `Record only durable architectural/product decisions in decisions and concise information useful to later work in followUpNotes. ` +
      `Set replanRecommended=true only if this work materially invalidates assumptions of remaining tasks.`;

    return this.runGuarded<MilestoneResponse>(thread, prompt, milestoneResultSchema, selection);
  }

  /** Repair stays in the milestone thread while it remains under the post-turn token threshold. */
  async fixAfterGateFailure(
    state: ProjectState,
    milestone: Milestone,
    failures: string,
    projectMemory: string,
    threadId?: string,
  ): Promise<RunnerResult<MilestoneResponse>> {
    const selection = this.milestoneRepairModel(milestone);
    const thread = this.thread(threadId, selection, "workspace-write", `mvpx-${milestone.id.toLowerCase()}-repair`);
    const scope = (milestone.fileScope ?? []).length > 0 ? milestone.fileScope!.join(", ") : "milestone-relevant files only";
    const freshHandoff = threadId
      ? ""
      : `This is a fresh repair thread because the previous milestone thread was rotated.\n\nBOUNDED PROJECT MEMORY:\n${projectMemory}\n\n` +
        `MILESTONE: ${milestone.id} ${milestone.title}\n${milestone.description}\n\n` +
        `FILE SCOPE: ${scope}\n\nPREVIOUS MILESTONE SUMMARY:\n${milestone.summary ?? "No summary available."}\n\n`;
    const turn = await thread.run(
      `${freshHandoff}` +
      `The milestone ${milestone.id} did not pass MVPX host-side incremental validation.\n\n` +
      `FAILURES (already trimmed to relevant tail output):\n${failures}\n\n` +
      `Fix only these failures while preserving milestone intent. Start with the files implicated by the errors and planned file scope. Do not re-audit. ` +
      `Do not weaken tests, lint/type rules, or safeguards merely to make the gate pass. ` +
      `Do not commit, push, modify secrets, install global/system packages, deploy, or perform destructive Git operations.`,
      { outputSchema: milestoneResultSchema },
    );
    return this.finish<MilestoneResponse>(thread, turn.finalResponse, turn.usage, selection);
  }

  /** Cheap Luna fallback when deterministic validation classification is inconclusive. */
  async classifyValidationFailure(gate: GateResult): Promise<RunnerResult<ValidationClassification>> {
    const selection = this.planningModel();
    const thread = this.thread(undefined, selection, "read-only", "mvpx-validation-classifier");
    const trimmed = [
      `Gate: ${gate.name}`,
      `Command: ${gate.command}`,
      `Exit code: ${gate.exitCode}`,
      gate.stdout ? `stdout tail:\n${gate.stdout.slice(-3500)}` : "",
      gate.stderr ? `stderr tail:\n${gate.stderr.slice(-3500)}` : "",
    ].filter(Boolean).join("\n");
    const turn = await thread.run(
      `Classify this failed software quality gate. Do NOT inspect the repository and do NOT propose a fix.\n\n${trimmed}\n\n` +
      `Kinds: environment = sandbox/OS/browser/port/dependency limitation; transient = likely flaky/runtime issue worth retrying without code changes; ` +
      `code = source/test/build issue that an implementer should repair; visual = genuine screenshot/visual assertion mismatch; unknown = insufficient evidence. ` +
      `Return only the structured classification and any file paths explicitly visible in the failure output.`,
      { outputSchema: validationClassificationSchema },
    );
    return this.finish<ValidationClassification>(thread, turn.finalResponse, turn.usage, selection);
  }

  /**
   * Targeted final-gate repair. Every attempt intentionally starts in a fresh bounded thread.
   * Cross-attempt continuity is carried by a compact repair contract, never by thread history.
   */
  async repairValidationGate(
    state: ProjectState,
    attempt: number,
    gate: GateResult,
    classification: ValidationClassification,
    projectMemory: string,
    previousAttempt?: ValidationRepairAttemptContext,
  ): Promise<RunnerResult<FinalRepairResponse>> {
    const selection = this.modelForAttempt(attempt);
    const slug = gate.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const thread = this.thread(undefined, selection, "workspace-write", `mvpx-final-${slug}-repair-${attempt}`);
    const files = classification.affectedFiles.length > 0
      ? classification.affectedFiles.map((f) => `- ${f}`).join("\n")
      : "- No explicit file path in failure output; inspect only the narrowest files directly implicated by this gate.";
    const failure = [
      `Gate: ${gate.name}`,
      `Command: ${gate.command}`,
      `Exit code: ${gate.exitCode}`,
      gate.stdout ? `stdout tail:\n${gate.stdout.slice(-3000)}` : "",
      gate.stderr ? `stderr tail:\n${gate.stderr.slice(-3000)}` : "",
    ].filter(Boolean).join("\n");
    const previous = previousAttempt
      ? `PREVIOUS REPAIR ATTEMPT (do not repeat blindly):\nSummary: ${previousAttempt.summary}\nChanged files:\n${previousAttempt.changedFiles.map((f) => `- ${f}`).join("\n") || "- none reported"}\nDecisions:\n${previousAttempt.decisions.map((d) => `- ${d}`).join("\n") || "- none reported"}\n\n`
      : "PREVIOUS REPAIR ATTEMPT: none. This is the first repair attempt.\n\n";
    const turn = await thread.run(
      `FRESH TARGETED REPAIR THREAD. Do not reconstruct prior conversations or audit the repository broadly.\n\n` +
      `COMPACT PROJECT MEMORY (reference only):\n${projectMemory}\n\n` +
      `${previous}` +
      `CURRENT REPAIR CONTRACT\n` +
      `Failed gate: ${gate.name}\nClassification: ${classification.kind} (${Math.round(classification.confidence * 100)}%) - ${classification.reason}\n\n` +
      `RELEVANT FILE HINTS:\n${files}\n\nCURRENT FAILURE:\n${failure}\n\n` +
      `Repair only the current gate failure. Begin with the exact failure and file hints above; inspect a direct dependency only when necessary. ` +
      `If a previous attempt exists, use its summary to avoid repeating the same unsuccessful hypothesis. ` +
      `Do not audit unrelated modules. Do not run the full validation suite; MVPX will rerun only ${gate.name} on the host. ` +
      `Do not weaken checks, update snapshots blindly, commit, push, modify secrets, install global/system packages, deploy, or perform destructive Git operations.`,
      { outputSchema: finalRepairSchema },
    );
    return this.finish<FinalRepairResponse>(thread, turn.finalResponse, turn.usage, selection);
  }

  /** Final repair has its own bounded thread, separate from every milestone and planner. */
  async repairFinalValidation(
    state: ProjectState,
    attempt: number,
    failures: string,
    projectMemory: string,
    threadId?: string,
  ): Promise<RunnerResult<FinalRepairResponse>> {
    const selection = this.modelForAttempt(attempt);
    const thread = this.thread(threadId, selection, "workspace-write", "mvpx-final-repair");
    const handoff = threadId ? "" : `BOUNDED PROJECT MEMORY:\n${projectMemory}\n\n`;
    const turn = await thread.run(
      `${handoff}` +
      `The planned implementation is complete, but FINAL host-side project validation failed.\n\n` +
      `FAILURES (trimmed):\n${failures}\n\n` +
      `Repair only what is necessary to satisfy the existing goal and final quality gates. ` +
      `Do not perform another broad audit or introduce unrelated improvements. ` +
      `Do not disable checks, commit, push, modify secrets, install global/system packages, deploy, or perform destructive Git operations.`,
      { outputSchema: finalRepairSchema },
    );
    return this.finish<FinalRepairResponse>(thread, turn.finalResponse, turn.usage, selection);
  }
}
