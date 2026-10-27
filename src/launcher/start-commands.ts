import { recordClientFactsInBackground } from "../lib/runner/runner-client.ts";
import { ATTEMPT_ID, readAttempt, releaseAttempt } from "../lib/workspace/workspace-attempts.ts";
import { hostname } from "node:os";
import { createWorkspace, unusedWorkspaceStartRefusal, resolveStartBase, readySpares, startSpareRefill } from "../lib/slipjay.ts";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import type { Readable } from "node:stream";
import { integrationRoot } from "./command-context.ts";
import { fileURLToPath } from "node:url";

type StartOptions = { integration: boolean; json: boolean; refill: boolean; issueNumber: number | undefined; base: string | undefined; attemptId: string | undefined; resultFd: number | undefined; task: string };

/**
 * `start` flags, which precede the task: `--integration` allocates from the
 * integration checkout even inside a workspace; `--issue <n>` creates or resumes
 * that Issue's workspace; `--base <revision>` starts a new workspace (from the
 * integration checkout) on that revision of the current checkout instead of the
 * integration head, and takes no Issue; `--refill` then starts a background spare
 * refill; `--attempt <id>` records the start as that allocation attempt, so a caller that
 * never receives the result can still find and release its checkout (`slipjay attempt`);
 * `--json` prints one JSON result object. Null when the arguments are invalid.
 */
function startOptions(args: string[]): StartOptions | null {
  const options: StartOptions = { integration: false, json: false, refill: false, issueNumber: undefined, base: undefined, attemptId: undefined, resultFd: undefined, task: "" };
  let index = 0;
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--integration") options.integration = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--refill") options.refill = true;
    else if (flag === "--attempt") {
      const value = args[index + 1];
      if (!value || !ATTEMPT_ID.test(value)) return null;
      options.attemptId = value;
      index += 1;
    }
    else if (flag === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return null;
      options.base = value;
      options.integration = true;
      index += 1;
    }
    else if (flag === "--issue" || flag === "--result-fd") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      if (flag === "--issue") options.issueNumber = value;
      else options.resultFd = value;
      index += 1;
    } else break;
  }
  options.task = args.slice(index).join(" ").trim();
  // A flag is a request for help or a typo, never a task to start a workspace for.
  if (options.task.startsWith("-") || (!options.task && !options.issueNumber)) return null;
  if (options.base && options.issueNumber) return null;
  return options;
}

/**
 * `start --json`: run the start in a child whose stdout is this process's stderr,
 * so dependency-install output can never corrupt the JSON this process prints.
 */
async function startForJson(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("./workspace.ts", import.meta.url)), "start", "--result-fd", "3", ...args], {
    stdio: ["inherit", 2, "inherit", "pipe"],
  });
  let result = "";
  (child.stdio[3] as Readable).setEncoding("utf8").on("data", (chunk: string) => { result += chunk; });
  const code = await new Promise<number>((resolveExit) => {
    child.once("error", (error) => { console.error(error.message); resolveExit(1); });
    child.once("close", (exit) => resolveExit(exit ?? 1));
  });
  if (code === 0 && result.trim()) process.stdout.write(result);
  return code === 0 && !result.trim() ? 1 : code;
}

const ATTEMPT_USAGE = "Usage: slipjay attempt show <id> | attempt release <id>";

export async function runStart(rest: string[]): Promise<void> {
  const options = startOptions(rest);
  if (!options) {
    console.error('Usage: slipjay start [--integration] [--issue <n> | --base <revision>] [--attempt <id>] [--refill] [--json] ["task"]');
    process.exitCode = 2;
  } else if (options.json && options.resultFd === undefined) {
    process.exitCode = await startForJson(rest);
  } else {
    const refusal = options.integration && options.issueNumber ? await unusedWorkspaceStartRefusal(process.cwd(), options.issueNumber) : null;
    if (refusal) throw new Error(refusal);
    // The base names a revision of the caller's checkout, so it resolves there before moving to the integration root.
    const base = options.base ? await resolveStartBase(process.cwd(), options.base) : undefined;
    const root = options.integration ? await integrationRoot(process.cwd()) : process.cwd();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    // A metric only: a host whose processes cannot be read still starts, from a fresh workspace.
    const spareCount = (await readySpares(root).catch(() => [])).length;
    const task = options.task || `Issue #${options.issueNumber}`;
    const result = await createWorkspace(task, root, {
      ...options.issueNumber ? { issueNumber: options.issueNumber } : base ? { base } : {},
      ...options.attemptId ? { attemptId: options.attemptId } : {},
    });
    // The runner is told in the background: a slow or unreachable one never delays the workspace.
    await recordClientFactsInBackground(result.workspacePath, [
      { kind: "workspace_start", workspace: result.current.name, machine: hostname(), startedAt },
      ...(result.created ? [{ kind: "pool_claim" as const, workspace: result.current.name, hit: Boolean(result.pooled), spareCount, durationMs: Date.now() - started, steps: result.steps }] : []),
    ]);
    // Prepare the next session's spare in the background, so its start can claim it.
    // Every new workspace, claimed or fresh, tops the pool up: a miss on an empty pool fills it for the next start.
    const refill = options.refill || result.created ? await startSpareRefill(root).catch((error) => ({ started: false, reason: error.message })) : undefined;
    if (refill && !refill.started) console.error(`Spare refill not started: ${refill.reason}`);
    if (options.resultFd === undefined) console.log(result.workspacePath);
    else {
      writeSync(options.resultFd, `${JSON.stringify({
        workspacePath: result.workspacePath, workspaceName: result.current.name, integrationRoot: result.integration.root,
        issueNumber: options.issueNumber ?? null, created: result.created ?? false, reused: result.reused ?? false, pooled: Boolean(result.pooled),
        ...(options.attemptId ? { attemptId: options.attemptId } : {}),
        ...(refill ? { refill } : {}),
        steps: result.steps,
      })}\n`);
    }
  }
}

export async function runAttempt(rest: string[]): Promise<void> {
  const [action, attemptId, ...extra] = rest;
  if ((action !== "show" && action !== "release") || !attemptId || extra.length) throw new Error(ATTEMPT_USAGE);
  if (action === "show") {
    const attempt = await readAttempt(attemptId);
    if (!attempt) throw new Error(`No allocation attempt '${attemptId}'`);
    console.log(JSON.stringify(attempt, null, 2));
  } else {
    const released = await releaseAttempt(attemptId);
    console.log(JSON.stringify(released));
    if (!released.released) process.exitCode = 1;
  }
}
