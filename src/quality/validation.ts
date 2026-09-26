import { inferBlockerType } from "../blockers.js";
import type { GateResult, ValidationClassification, ValidationFailureKind } from "../types.js";

const TRANSIENT = [
  /ECONNRESET/i, /EPIPE/i, /socket hang up/i, /temporar(?:y|ily) unavailable/i,
  /worker (?:exited|crashed) unexpectedly/i, /page crashed/i, /browser has been closed/i,
  /timed? out/i, /timeout/i, /\b429\b/i, /\b503\b/i,
];

const VISUAL = [
  /toHaveScreenshot/i, /snapshot mismatch/i, /visual regression/i,
  /pixel(?:s)? (?:differ|difference)/i, /image diff/i, /golden image/i,
];

// Strong code evidence describes the root cause, not merely a command wrapper.
// Package-manager epilogues such as ELIFECYCLE/"command failed" intentionally do not appear here.
const STRONG_CODE = [
  /expect\(received\)/i,
  /Expected[\s\S]{0,500}Received/i,
  /AssertionError/i,
  /Test Suites:\s*\d+\s+failed/i,
  /Tests:\s*\d+\s+failed/i,
  /^\s*●\s+.+$/m,
  /\bat\s+[^\n]*(?:test|spec)\.[cm]?[jt]sx?:\d+/i,
  /\bTS\d{4}\b/,
  /SyntaxError/i,
  /eslint[^\n]*(?:error|problem)/i,
  /failed to compile/i,
  /TypeError:\s+/i,
  /ReferenceError:\s+/i,
];

const WEAK_CODE = [
  /tests? failed/i,
  /build failed/i,
  /lint error/i,
  /cannot find module/i,
];

// These signatures are specific enough to indicate host/tooling/infrastructure limitations.
// Plain words such as "sandbox" and generic wrappers such as ELIFECYCLE are deliberately excluded.
const STRONG_ENVIRONMENT = [
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /permission denied/i,
  /operation not permitted/i,
  /\bEADDRINUSE\b/i,
  /cannot (?:bind|listen)/i,
  /listen[^\n]*(?:localhost|127\.0\.0\.1)[^\n]*(?:failed|denied|not permitted|in use)/i,
  /command not found/i,
  /not (?:installed|available) in PATH/i,
  /browser executable[^\n]*(?:missing|not found)/i,
  /playwright[^\n]*(?:browser|chromium)[^\n]*(?:missing|not installed|not found)/i,
  /network (?:is )?(?:disabled|unavailable|blocked)/i,
  /sandbox(?:ed)? (?:restriction|denial|denied|blocked|does not permit|prohibits)/i,
  /(?:restricted|blocked|denied) by (?:the )?sandbox/i,
];

function textOf(gate: GateResult): string {
  return `${gate.command}\n${gate.stdout}\n${gate.stderr}`;
}
function matches(text: string, patterns: RegExp[]): boolean { return patterns.some((p) => p.test(text)); }

export function extractAffectedFiles(gate: GateResult): string[] {
  const text = textOf(gate);
  const found = new Set<string>();
  const patterns = [
    /(?:^|[\s('"`])((?:src|app|pages|components|lib|server|test|tests|e2e)\/[A-Za-z0-9_./@()-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json))/gm,
    /(?:^|\s)([A-Za-z0-9_./@()-]+\.(?:test|spec)\.(?:tsx?|jsx?))(?::\d+)?/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return Array.from(found).slice(0, 20);
}

export function classifyGateDeterministically(gate: GateResult): ValidationClassification | null {
  const text = textOf(gate);
  const affectedFiles = extractAffectedFiles(gate);
  const strongCode = matches(text, STRONG_CODE);
  const strongEnvironment = matches(text, STRONG_ENVIRONMENT);

  // Conflicting strong evidence is intentionally delegated to the cheap classifier.
  if (strongCode && strongEnvironment) return null;

  if (matches(text, VISUAL)) {
    return { kind: "visual", confidence: 0.98, reason: "Visual/screenshot regression evidence detected.", affectedFiles };
  }
  if (strongCode) {
    return { kind: "code", confidence: 1, reason: "Explicit compiler/assertion/test evidence identifies a reparable code or test-contract failure.", affectedFiles };
  }
  if (strongEnvironment) {
    return { kind: "environment", confidence: 1, reason: "Specific host/tooling/environment failure signature detected.", affectedFiles };
  }

  // Keep compatibility with blocker inference, but only after strong code evidence has had priority.
  // This catches narrow environment patterns maintained centrally without allowing weak wrappers to win.
  if (inferBlockerType(text) === "environment") {
    return { kind: "environment", confidence: 0.9, reason: "Known environment/tooling failure signature detected.", affectedFiles };
  }
  if (matches(text, TRANSIENT)) {
    return { kind: "transient", confidence: 0.85, reason: "Potentially transient runtime/test failure signature detected.", affectedFiles };
  }
  if (/^(?:lint|typecheck|build)$/i.test(gate.name) || matches(text, WEAK_CODE)) {
    return { kind: "code", confidence: 0.9, reason: "Compiler/lint/test failure indicates a reparable code issue.", affectedFiles };
  }
  return null;
}

export function shouldRetryWithoutAi(gate: GateResult): boolean {
  return /^(?:test|quality:ui|e2e|playwright|ui)$/i.test(gate.name);
}

export function validationKindToBlocker(kind: ValidationFailureKind): "environment" | "external_dependency" | "unknown" {
  if (kind === "environment") return "environment";
  if (kind === "transient") return "external_dependency";
  return "unknown";
}
