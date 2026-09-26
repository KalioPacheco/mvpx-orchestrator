import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureMvpxDir, mvpxDir } from "../state/store.js";
import type { Milestone, ProjectState } from "../types.js";

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function trimText(value: string | undefined, max = 1800): string {
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function milestoneBlock(milestone: Milestone): string {
  const changed = (milestone.changedFiles ?? []).slice(0, 20);
  return [
    `### ${milestone.id} — ${milestone.title}`,
    trimText(milestone.summary, 2200),
    changed.length ? `Changed files: ${changed.join(", ")}` : "",
    (milestone.decisions ?? []).length ? `Decisions:\n${milestone.decisions!.map((d) => `- ${trimText(d, 500)}`).join("\n")}` : "",
    (milestone.followUpNotes ?? []).length ? `Follow-up notes:\n${milestone.followUpNotes!.map((n) => `- ${trimText(n, 500)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export function renderProjectMemory(state: ProjectState, maxChars: number): string {
  const decisions = uniq(state.memory.decisions).slice(-40);
  const notes = uniq(state.memory.notes).slice(-40);
  const waiting = state.milestones.filter((m) => m.status === "waiting" || m.status === "blocked");
  const remaining = state.tasks.filter((t) => t.status === "todo" || t.status === "failed" || t.status === "running");
  const completed = state.milestones.filter((m) => m.status === "done").slice().reverse();

  const fixed = [
    "# MVPX Project Memory",
    "",
    "## Goal",
    trimText(state.goal, 3000),
    "",
    "## Project summary",
    trimText(state.memory.summary || state.lastMessage || "No summary yet.", 5000),
    "",
    "## Durable decisions",
    decisions.length ? decisions.map((d) => `- ${trimText(d, 700)}`).join("\n") : "- None recorded yet.",
    "",
    "## Durable notes",
    notes.length ? notes.map((n) => `- ${trimText(n, 700)}`).join("\n") : "- None recorded yet.",
    "",
    "## Active blockers",
    waiting.length
      ? waiting.map((m) => `- ${m.id} [${m.blockerType ?? "unknown"}]: ${trimText(m.blocker, 1200)}`).join("\n")
      : "- None.",
    "",
    "## Remaining executable work",
    remaining.length
      ? remaining.slice(0, 80).map((t) => `- ${t.id}: ${trimText(t.title, 220)}`).join("\n")
      : "- None.",
    "",
    "## Completed milestone handoffs",
  ].join("\n");

  // Keep the newest handoffs first, adding only what fits the bounded memory budget.
  let output = fixed;
  for (const milestone of completed) {
    const block = `\n\n${milestoneBlock(milestone)}`;
    if (output.length + block.length > maxChars) break;
    output += block;
  }

  if (output.length > maxChars) output = `${output.slice(0, maxChars - 80)}\n\n[Memory truncated to configured budget.]`;
  return `${output.trim()}\n`;
}

export function renderDecisions(state: ProjectState): string {
  const decisions = uniq([
    ...state.memory.decisions,
    ...state.milestones.flatMap((milestone) => milestone.decisions ?? []),
  ]);
  return `# MVPX Decisions\n\n${decisions.length ? decisions.map((d) => `- ${d}`).join("\n") : "No durable decisions recorded yet."}\n`;
}

export async function refreshMemoryFiles(state: ProjectState, maxChars: number): Promise<string> {
  await ensureMvpxDir(state.projectRoot);
  const memory = renderProjectMemory(state, maxChars);
  await writeFile(path.join(mvpxDir(state.projectRoot), "PROJECT_MEMORY.md"), memory, "utf8");
  await writeFile(path.join(mvpxDir(state.projectRoot), "DECISIONS.md"), renderDecisions(state), "utf8");
  return memory;
}
