import type { BlockerType, GateResult } from "./types.js";

const ENVIRONMENT_PATTERNS = [
  /\bEPERM\b/i,
  /\bEACCES\b/i,
  /\bENOENT\b/i,
  /permission denied/i,
  /operation not permitted/i,
  /command not found/i,
  /not (?:installed|available) in PATH/i,
  /cannot (?:bind|listen)/i,
  /listen .* (?:localhost|127\.0\.0\.1)/i,
  /(?:localhost|127\.0\.0\.1).*listen/i,
  /browser executable.*(?:missing|not found)/i,
  /playwright.*(?:browser|chromium).*(?:missing|not installed|not found)/i,
  /network (?:is )?(?:disabled|unavailable|blocked)/i,
  /sandbox(?:ed)? (?:restriction|denial|denied|blocked|does not permit|prohibits)/i,
  /(?:restricted|blocked|denied) by (?:the )?sandbox/i,
];

const CREDENTIAL_PATTERNS = [
  /credential/i,
  /api[_ -]?key/i,
  /access token/i,
  /secret/i,
  /login required/i,
  /authentication required/i,
];

const PRODUCT_DECISION_PATTERNS = [
  /product decision/i,
  /business decision/i,
  /ambiguous requirement/i,
  /requires? clarification/i,
];

const UNSAFE_PATTERNS = [
  /destructive/i,
  /production data/i,
  /requires? sudo/i,
  /git push/i,
  /deploy/i,
  /irreversible/i,
];

const EXTERNAL_PATTERNS = [
  /external dependency/i,
  /third[- ]party/i,
  /service unavailable/i,
  /waiting for/i,
  /approval required/i,
];

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function inferBlockerType(text: string | undefined | null, suggested?: BlockerType | null): BlockerType {
  const value = text ?? "";
  if (matches(value, ENVIRONMENT_PATTERNS)) return "environment";
  if (matches(value, CREDENTIAL_PATTERNS)) return "credential";
  if (matches(value, UNSAFE_PATTERNS)) return "unsafe_action";
  if (matches(value, PRODUCT_DECISION_PATTERNS)) return "product_decision";
  if (matches(value, EXTERNAL_PATTERNS)) return "external_dependency";
  return suggested ?? "unknown";
}

export function gateFailureLooksEnvironmental(results: GateResult[]): boolean {
  const text = results
    .filter((result) => !result.ok)
    .map((result) => `${result.command}\n${result.stdout}\n${result.stderr}`)
    .join("\n\n");
  return inferBlockerType(text) === "environment";
}

export function blockerNeedsExplicitRetry(type: BlockerType | undefined): boolean {
  return type !== undefined;
}
