import { rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ensureMvpxDir } from "../state/store.js";
import type { GitCheckpoint } from "../types.js";

function safeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "checkpoint";
}

async function git(root: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = await execa("git", args, { cwd: root, reject: false, env: { ...process.env, ...env } });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function createCheckpoint(root: string, milestoneId: string): Promise<GitCheckpoint> {
  await ensureMvpxDir(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${safeRefPart(milestoneId)}-${stamp}`;
  const indexFile = path.join(root, ".mvpx", `checkpoint-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    await git(root, ["read-tree", "HEAD"], env);
    await git(root, ["add", "-A", "--", "."], env);
    const tree = await git(root, ["write-tree"], env);
    const head = await git(root, ["rev-parse", "HEAD"]);
    const commit = await git(root, ["commit-tree", tree, "-p", head, "-m", `MVPX checkpoint ${milestoneId}`], {
      ...env,
      GIT_AUTHOR_NAME: "MVPX",
      GIT_AUTHOR_EMAIL: "mvpx@local",
      GIT_COMMITTER_NAME: "MVPX",
      GIT_COMMITTER_EMAIL: "mvpx@local",
    });
    const ref = `refs/mvpx/checkpoints/${id}`;
    await git(root, ["update-ref", ref, commit]);
    return { id, milestoneId, commit, ref, createdAt: new Date().toISOString() };
  } finally {
    await rm(indexFile, { force: true });
  }
}

export async function rollbackToCheckpoint(root: string, checkpoint: GitCheckpoint): Promise<void> {
  // Ignored files (node_modules, caches, env files) are intentionally not removed.
  await git(root, ["clean", "-fd"]);
  await git(root, ["restore", `--source=${checkpoint.commit}`, "--worktree", "--", "."]);
  // Codex is instructed not to stage files. Reset any accidental staging while preserving the restored worktree.
  await git(root, ["reset", "--mixed", "HEAD"]);
}

export async function listChangesSinceCheckpoint(root: string, checkpoint: GitCheckpoint): Promise<string[]> {
  const tracked = await git(root, ["diff", "--name-only", checkpoint.commit, "--", "."]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  return Array.from(new Set([
    ...tracked.split("\n").map((value: string) => value.trim()).filter(Boolean),
    ...untracked.split("\n").map((value: string) => value.trim()).filter(Boolean),
  ])).sort();
}
