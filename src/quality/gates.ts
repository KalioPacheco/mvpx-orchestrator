import { execa } from "execa";
import type { GateResult } from "../types.js";
import { detectPackageManager, readPackageJson } from "../utils/project.js";

export interface GateDefinition {
  name: string;
  command: string;
  args: string[];
}

function scriptInvokes(script: string, child: string): boolean {
  const escaped = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b(?:npm|pnpm|bun)\\s+(?:run\\s+)?${escaped}(?:\\s|$)`, "i"),
    new RegExp(`\\byarn\\s+${escaped}(?:\\s|$)`, "i"),
  ];
  return patterns.some((pattern) => pattern.test(script));
}

export async function detectGates(root: string, requested: string[]): Promise<GateDefinition[]> {
  const pkg = await readPackageJson(root);
  if (!pkg) return [];

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const pm = await detectPackageManager(root);
  const existing = requested
    .filter((name, index) => requested.indexOf(name) === index)
    .filter((name) => typeof scripts[name] === "string");

  // v0.4.3: prefer explicit child gates over an aggregate parent such as `quality`.
  // This lets the validation router rerun/repair exactly one failing gate.
  const decomposed = existing.filter((name) => {
    const script = scripts[name] ?? "";
    const invokesRequestedChild = existing.some((child) => child !== name && scriptInvokes(script, child));
    return !invokesRequestedChild;
  });

  return decomposed.map((name) => {
    if (pm === "yarn") return { name, command: "yarn", args: [name] };
    return { name, command: pm, args: ["run", name] };
  });
}

export async function runGate(root: string, gate: GateDefinition): Promise<GateResult> {
  try {
    const result = await execa(gate.command, gate.args, {
      cwd: root,
      reject: false,
      timeout: 15 * 60 * 1000,
      env: { ...process.env, CI: "1" },
    });
    return {
      name: gate.name,
      command: [gate.command, ...gate.args].join(" "),
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      name: gate.name,
      command: [gate.command, ...gate.args].join(" "),
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runQualityGates(root: string, requested: string[]): Promise<GateResult[]> {
  const gates = await detectGates(root, requested);
  const results: GateResult[] = [];
  for (const gate of gates) results.push(await runGate(root, gate));
  return results;
}

export async function runQualityGate(root: string, requestedName: string): Promise<GateResult | null> {
  const gates = await detectGates(root, [requestedName]);
  if (gates.length === 0) return null;
  return runGate(root, gates[0]);
}

export function formatGateFailure(result: GateResult): string {
  return [
    `Gate: ${result.name}`,
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout.slice(-2500)}` : "",
    result.stderr ? `stderr:\n${result.stderr.slice(-2500)}` : "",
  ].filter(Boolean).join("\n");
}

export function formatGateFailures(results: GateResult[]): string {
  return results.filter((result) => !result.ok).map(formatGateFailure).join("\n\n");
}
