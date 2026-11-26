import { readClaimInput } from "./claim-commands.ts";
import type { ManagedClaimRequest } from "../lib/workspace/workspace-claim-service.ts";
import { recordClientFactsInBackground } from "../lib/runner/runner-client.ts";
import { ATTEMPT_ID, readAttempt, releaseAttempt } from "../lib/workspace/workspace-attempts.ts";
import { hostname } from "node:os";
import { createWorkspace, resolveStartBase } from "../lib/workspace/workspace-create.ts";
import { setWorkspaceForgeProject } from "../lib/workspace/workspace-state.ts";
import { startSpareRefill } from "../lib/workspace/workspace-spares.ts";
import { startClientUpgradeThrottled } from "../lib/workspace/workspace-upgrade.ts";
import { writeSync } from "node:fs";

type StartOptions = { claimStdin: boolean; integration: boolean; json: boolean; refill: boolean; issueNumber: number | undefined; base: string | undefined; attemptId: string | undefined; resultFd: number | undefined; task: string };

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
  const options: StartOptions = { claimStdin: false, integration: false, json: false, refill: false, issueNumber: undefined, base: undefined, attemptId: undefined, resultFd: undefined, task: "" };
  let index = 0;
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--claim-stdin") options.claimStdin = true;
    else if (flag === "--integration") options.integration = true;
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

const ATTEMPT_USAGE = "Usage: slipjay attempt show <id> | attempt release <id>";

export async function runStart(rest: string[]): Promise<void> {
  const options = startOptions(rest);
  if (!options) {
    console.error('Usage: slipjay start [--integration] [--issue <n> | --base <revision>] [--attempt <id>] [--refill] [--json] ["task"]');
    process.exitCode = 2;
    return;
  }
  // Start's subprocesses capture their output or log to files. The install tees
  // captured stdout through process.stdout.write, and Bun's console.log can
  // bypass that method. Redirect both for JSON on stdout, then restore them
  // before emitting the result. An explicit result fd leaves stdout alone.
  const { write } = process.stdout;
  const { log } = console;
  const jsonOnStdout = options.json && options.resultFd === undefined;
  if (jsonOnStdout) {
    process.stdout.write = process.stderr.write.bind(process.stderr);
    console.log = console.error.bind(console);
  }
  let receipt: string;
  try {
    receipt = await start(options);
  } finally {
    if (jsonOnStdout) {
      process.stdout.write = write;
      console.log = log;
    }
  }
  if (options.resultFd === undefined) process.stdout.write(receipt);
  else writeSync(options.resultFd, receipt);
}

async function start(options: StartOptions): Promise<string> {
  // The base names a revision of the caller's checkout, so it resolves there before moving to the integration root.
  const cwd = process.cwd();
  const base = options.base ? await resolveStartBase(cwd, options.base) : undefined;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const task = options.task || `Issue #${options.issueNumber}`;
  const claim = options.claimStdin ? await readClaimInput() as ManagedClaimRequest : undefined;
  const result = await createWorkspace(task, cwd, {
    integration: options.integration,
    ...claim ? { claim } : {},
    ...options.issueNumber ? { issueNumber: options.issueNumber } : base ? { base } : {},
    ...options.attemptId ? { attemptId: options.attemptId } : {},
  });
  // New assignments already reset their metadata. Only a reused checkout can
  // carry a Forge project from a previous acquisition.
  if (!result.created) await setWorkspaceForgeProject(result.workspacePath, null);
  // The runner is told in the background: a slow or unreachable one never delays the workspace.
  await recordClientFactsInBackground(result.workspacePath, [
    { kind: "workspace_start", workspace: result.current.name, machine: hostname(), startedAt },
    ...(result.created ? [{ kind: "pool_claim" as const, workspace: result.current.name, hit: Boolean(result.pooled), spareCount: result.spareCount, durationMs: Date.now() - started, steps: result.steps }] : []),
  ]);
  // Prepare the next session's spare in the background, so its start can claim it.
  // Every new workspace, claimed or fresh, tops the pool up: a miss on an empty pool fills it for the next start.
  const root = result.integration.root;
  const refill = options.refill || result.created ? await startSpareRefill(root, { integrationRoot: root }).catch((error) => ({ started: false, reason: error.message })) : undefined;
  if (refill && !refill.started) console.error(`Spare refill not started: ${refill.reason}`);
  // Keep this machine's client on what landed, at most once every ten minutes: the spawn is awaited,
  // the upgrade it starts is detached, so a start never waits for a build.
  const upgrade = await startClientUpgradeThrottled();
  if (upgrade.started) console.error(`Started a client upgrade in the background (log: ~/.slipjay/state/upgrade.log)`);
  if (!options.json && options.resultFd === undefined) return `${result.workspacePath}\n`;
  return `${JSON.stringify({
    ...(result.claim ? { claim: result.claim } : {}),
    workspacePath: result.workspacePath, workspaceName: result.current.name, integrationRoot: result.integration.root,
    issueNumber: options.issueNumber ?? null, created: result.created ?? false, reused: result.reused ?? false, pooled: Boolean(result.pooled),
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    ...(refill ? { refill } : {}),
    steps: result.steps,
    installAttempts: (result.readiness as { installAttempts?: Record<string, unknown>[] } | undefined)?.installAttempts,
  })}\n`;
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
