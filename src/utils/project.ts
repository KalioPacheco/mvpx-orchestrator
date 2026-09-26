import { access, mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProjectRoot(input?: string): Promise<string> {
  const requested = path.resolve(input ?? process.cwd());
  await access(requested);

  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    reject: false,
  });

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`MVPX requires a Git repository: ${requested}`);
  }

  return path.resolve(result.stdout.trim());
}

export async function ensureMvpxLocallyIgnored(root: string): Promise<void> {
  const result = await execa("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: root,
    reject: false,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return;

  const excludePath = path.resolve(root, result.stdout.trim());
  await mkdir(path.dirname(excludePath), { recursive: true });

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const entries = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  if (!entries.has(".mvpx/")) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}.mvpx/\n`, "utf8");
  }
}

export async function isGitDirty(root: string): Promise<boolean> {
  const result = await execa("git", ["status", "--porcelain"], {
    cwd: root,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to inspect Git status in ${root}: ${result.stderr}`);
  }
  return result.stdout.trim().length > 0;
}

export async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function detectPackageManager(root: string): Promise<PackageManager> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}
