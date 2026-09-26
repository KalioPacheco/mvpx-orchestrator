import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { PreflightIssue, PreflightReport } from "../types.js";
import { detectPackageManager, readPackageJson } from "../utils/project.js";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

function runArgs(pm: "npm" | "pnpm" | "yarn" | "bun", script: string): [string, string[]] {
  if (pm === "yarn") return ["yarn", [script]];
  return [pm, ["run", script]];
}

function execArgs(pm: "npm" | "pnpm" | "yarn" | "bun", args: string[]): [string, string[]] {
  if (pm === "yarn") return ["yarn", args];
  if (pm === "bun") return ["bunx", args];
  if (pm === "npm") return ["npm", ["exec", "--", ...args]];
  return [pm, ["exec", ...args]];
}

async function installDependencies(root: string, pm: "npm" | "pnpm" | "yarn" | "bun"): Promise<void> {
  let command = pm;
  let args: string[];
  if (pm === "pnpm") args = ["install", "--frozen-lockfile"];
  else if (pm === "yarn") args = ["install", "--immutable"];
  else if (pm === "bun") args = ["install", "--frozen-lockfile"];
  else args = [(await exists(path.join(root, "package-lock.json"))) ? "ci" : "install"];

  const result = await execa(command, args, { cwd: root, reject: false, stdio: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed during preflight preparation.`);
}

async function installPlaywrightChromium(root: string, pm: "npm" | "pnpm" | "yarn" | "bun"): Promise<void> {
  const [command, baseArgs] = execArgs(pm, ["playwright", "install", "chromium"]);
  const result = await execa(command, baseArgs, { cwd: root, reject: false, stdio: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command} ${baseArgs.join(" ")} failed during Playwright preparation.`);
}

export async function runPreflight(root: string, prepare = false): Promise<PreflightReport> {
  const pkg = await readPackageJson(root);
  if (!pkg) return { ok: true, issues: [], prepared: [] };

  const pm = await detectPackageManager(root);
  const issues: PreflightIssue[] = [];
  const prepared: string[] = [];

  const pmCheck = await execa(pm, ["--version"], { cwd: root, reject: false });
  if (pmCheck.exitCode !== 0) {
    issues.push({
      code: "package-manager-missing",
      severity: "blocking",
      message: `Package manager '${pm}' is not available in PATH.`,
      remediation: `Install ${pm} before running MVPX.`,
    });
    return { ok: false, packageManager: pm, issues, prepared };
  }

  const nodeModules = path.join(root, "node_modules");
  if (!(await exists(nodeModules))) {
    if (prepare) {
      await installDependencies(root, pm);
      prepared.push("project dependencies");
    } else {
      const install = pm === "npm" && await exists(path.join(root, "package-lock.json")) ? "npm ci" : `${pm} install`;
      issues.push({
        code: "dependencies-missing",
        severity: "blocking",
        message: "Project dependencies are not installed.",
        remediation: `Run '${install}' or rerun MVPX with --prepare.`,
      });
    }
  }

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const deps = {
    ...((pkg.dependencies ?? {}) as Record<string, string>),
    ...((pkg.devDependencies ?? {}) as Record<string, string>),
  };
  const usesPlaywright = Boolean(deps.playwright || deps["@playwright/test"] || Object.values(scripts).some((s) => /playwright/i.test(s)));

  if (usesPlaywright && (await exists(nodeModules))) {
    const [command, args] = execArgs(pm, ["playwright", "--version"]);
    const pw = await execa(command, args, { cwd: root, reject: false });
    if (pw.exitCode !== 0) {
      issues.push({
        code: "playwright-cli-missing",
        severity: "blocking",
        message: "Playwright is referenced by the project but its CLI is unavailable.",
        remediation: `Install project dependencies (${pm} install).`,
      });
    } else {
      const cacheCandidates = [
        process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
          ? path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
          : "",
        path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
        path.join(os.homedir(), ".cache", "ms-playwright"),
        path.join(root, "node_modules", "playwright-core", ".local-browsers"),
      ].filter(Boolean);
      const browserPresent = (await Promise.all(cacheCandidates.map(hasEntries))).some(Boolean);
      if (!browserPresent) {
        if (prepare) {
          await installPlaywrightChromium(root, pm);
          prepared.push("Playwright Chromium");
        } else {
          issues.push({
            code: "playwright-browser-missing",
            severity: "blocking",
            message: "Playwright is configured but no local browser cache was detected.",
            remediation: `Run '${pm === "yarn" ? "yarn playwright install chromium" : `${pm} exec playwright install chromium`}' or rerun MVPX with --prepare.`,
          });
        }
      }
    }
  }

  // Detect UI quality scripts early so users know what final validation will invoke.
  const uiScript = Object.keys(scripts).find((name) => name === "quality:ui");
  if (uiScript) {
    const [command, args] = runArgs(pm, uiScript);
    issues.push({
      code: "ui-quality-detected",
      severity: "warning",
      message: `UI quality gate detected: ${command} ${args.join(" ")}. It will run only during final validation by default.`,
    });
  }

  return {
    ok: !issues.some((issue) => issue.severity === "blocking"),
    packageManager: pm,
    issues,
    prepared,
  };
}
