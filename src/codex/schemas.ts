const taskShape = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    priority: { type: "integer", minimum: 1, maximum: 100 },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    dependsOnTaskIds: { type: "array", items: { type: "string" } },
  },
  required: ["id", "title", "description", "priority", "acceptanceCriteria", "dependsOnTaskIds"],
  additionalProperties: false,
} as const;

const milestoneShape = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    priority: { type: "integer", minimum: 1, maximum: 100 },
    fileScope: { type: "array", items: { type: "string" } },
    complexity: { type: "string", enum: ["simple", "normal", "complex", "critical"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    crossModule: { type: "boolean" },
    requiresArchitectureChange: { type: "boolean" },
    estimatedFiles: { type: "integer", minimum: 1, maximum: 500 },
    tasks: { type: "array", items: taskShape },
  },
  required: ["id", "title", "description", "priority", "fileScope", "complexity", "risk", "crossModule", "requiresArchitectureChange", "estimatedFiles", "tasks"],
  additionalProperties: false,
} as const;

const blockerTypeShape = {
  type: "string",
  enum: ["environment", "credential", "product_decision", "unsafe_action", "external_dependency", "internal_dependency", "orchestration_budget", "unknown"],
} as const;

export const planSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    milestones: { type: "array", items: milestoneShape },
  },
  required: ["summary", "milestones"],
  additionalProperties: false,
} as const;

export const replanSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    supersededTaskIds: { type: "array", items: { type: "string" } },
    milestones: { type: "array", items: milestoneShape },
  },
  required: ["summary", "supersededTaskIds", "milestones"],
  additionalProperties: false,
} as const;

export const milestoneResultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    completedTaskIds: { type: "array", items: { type: "string" } },
    changedFiles: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    followUpNotes: { type: "array", items: { type: "string" } },
    blocker: { type: ["string", "null"] },
    blockerType: { anyOf: [blockerTypeShape, { type: "null" }] },
    replanRecommended: { type: "boolean" },
  },
  required: [
    "status",
    "summary",
    "completedTaskIds",
    "changedFiles",
    "decisions",
    "followUpNotes",
    "blocker",
    "blockerType",
    "replanRecommended",
  ],
  additionalProperties: false,
} as const;

export const finalRepairSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    blocker: { type: ["string", "null"] },
    blockerType: { anyOf: [blockerTypeShape, { type: "null" }] },
  },
  required: ["status", "summary", "changedFiles", "decisions", "blocker", "blockerType"],
  additionalProperties: false,
} as const;

export const validationClassificationSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["environment", "transient", "code", "visual", "unknown"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    affectedFiles: { type: "array", items: { type: "string" } },
  },
  required: ["kind", "confidence", "reason", "affectedFiles"],
  additionalProperties: false,
} as const;


const sliceShape = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    objective: { type: "string" },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    fileScope: { type: "array", items: { type: "string" } },
    complexity: { type: "string", enum: ["simple", "normal", "complex", "critical"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    crossModule: { type: "boolean" },
    requiresArchitectureChange: { type: "boolean" },
    estimatedFiles: { type: "integer", minimum: 1, maximum: 100 },
    verificationBacked: { type: "boolean" },
    verificationEvidence: { type: "array", items: { type: "string" } },
    decisionState: { type: "string", enum: ["open", "locked"] },
    decisionSummary: { type: "string" },
    criticalDomain: { type: "boolean" },
    criticalDomainReason: { type: "string" },
    atomic: { type: "boolean" },
    atomicReason: { type: "string" },
  },
  required: [
    "id", "title", "objective", "acceptanceCriteria", "fileScope", "complexity", "risk",
    "crossModule", "requiresArchitectureChange", "estimatedFiles", "verificationBacked", "verificationEvidence",
    "decisionState", "decisionSummary", "criticalDomain", "criticalDomainReason", "atomic", "atomicReason"
  ],
  additionalProperties: false,
} as const;

export const slicePlanSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    slices: { type: "array", minItems: 2, maxItems: 8, items: sliceShape },
  },
  required: ["summary", "decisions", "slices"],
  additionalProperties: false,
} as const;

export const sliceResultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    followUpNotes: { type: "array", items: { type: "string" } },
    blocker: { type: ["string", "null"] },
    blockerType: { anyOf: [blockerTypeShape, { type: "null" }] },
  },
  required: ["status", "summary", "changedFiles", "decisions", "followUpNotes", "blocker", "blockerType"],
  additionalProperties: false,
} as const;
