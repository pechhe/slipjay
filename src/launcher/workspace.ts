#!/usr/bin/env bun
import { controlRunner, deployThroughRunner, landThroughRunner, readDeploys, readRunLog, releaseThroughRunner, runnerLocation } from "../lib/runner-client.ts";
import { confirmableCandidate } from "../lib/release.ts";
import { startRunner } from "../lib/runner-service.ts";

import {
  attachWorkspaceIssue,
  cleanupLandedWorkspace,
  createWorkspace,
  inspectWorkspaces,
  landingPreview,
  releaseIntegration,
  pruneEmptyWorkspaces,
  readWorkspaceMode,
  workspaceContext,
  writeWorkspaceMode,
  provisionSpare,
  readySpares,
  describeRetention,
  retainedWorkspaceMaterial,
  readLandingState,
  removeWorkspace,
  startSpareRefill,
  cutover,
  cutoverPending,
} from "../lib/slipjay.ts";
import { legacyStateHome } from "../lib/workspace-paths.ts";
import { landingGuardDecision } from "../lib/landing-guard.ts";
import { landingTimingLine, landingTimingRecord } from "../lib/landing-timing.ts";
import { appendMetric } from "../lib/metrics.ts";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";

/** Disk use of a checkout, for spotting retained workspaces worth reclaiming. */
function diskUsage(root: string): string {
  try { return execFileSync("du", ["-sh", root], { encoding: "utf8", timeout: 60_000 }).split("\t")[0] ?? "?"; }
  catch { return "?"; }
}

/** The repository's integration checkout, even when `cwd` is inside one of its workspaces. */
async function integrationRoot(cwd: string): Promise<string> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  return context.integration.root;
}

type StartOptions = { integration: boolean; json: boolean; refill: boolean; issueNumber: number | undefined; resultFd: number | undefined; task: string };

/**
 * `start` flags, which precede the task: `--integration` allocates from the
 * integration checkout even inside a workspace; `--issue <n>` creates or resumes
 * that Issue's workspace; `--refill` then starts a background spare refill;
 * `--json` prints one JSON result object. Null when the arguments are invalid.
 */
function startOptions(args: string[]): StartOptions | null {
  const options: StartOptions = { integration: false, json: false, refill: false, issueNumber: undefined, resultFd: undefined, task: "" };
  let index = 0;
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--integration") options.integration = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--refill") options.refill = true;
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
  return options;
}

/**
 * `start --json`: run the start in a child whose stdout is this process's stderr,
 * so dependency-install output can never corrupt the JSON this process prints.
 */
async function startForJson(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "start", "--result-fd", "3", ...args], {
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

/**
 * Remove the workspace at `path` if it has landed or is untouched; unfinished
 * work stays in place and reports failure, so a caller (such as Claude Code's
 * WorktreeRemove hook) never treats a kept workspace as removed.
 */
async function removeWorkspaceAt(path: string): Promise<number> {
  const context = await workspaceContext(path).catch(() => null);
  if (!context || context.current.name === "default") {
    console.log(`No isolated workspace at ${path}; nothing to remove.`);
    return 0;
  }
  const name = context.current.name;
  const result = await cleanupLandedWorkspace(path);
  if (result.cleaned) {
    console.log(`Removed landed workspace jj:${name}`);
    return 0;
  }
  if (result.reason === "not-landed") {
    try {
      await removeWorkspace(context.integration.root, name);
      console.log(`Removed untouched workspace jj:${name}`);
      return 0;
    } catch (error) {
      console.error(`Kept jj:${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  console.error(`Kept jj:${name}: ${describeRetention(result)}`);
  return 1;
}

/**
 * `release [--confirm <commit>] [--migrations-ready]`: plan a release here, or send
 * the candidate a human approved to the runner, which verifies and publishes it.
 * Progress goes to stderr; stdout is one JSON result.
 */
async function runRelease(args: string[]): Promise<number> {
  const options: { migrationsReady: boolean; confirm?: string } = { migrationsReady: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--migrations-ready") options.migrationsReady = true;
    else if (args[index] === "--confirm" && args[index + 1] && !args[index + 1]!.startsWith("-")) options.confirm = args[++index];
    else throw new Error("Usage: slipjay release [--confirm <commit>] [--migrations-ready]");
  }
  if (options.confirm === undefined) {
    const plan = await releaseIntegration(process.cwd());
    console.log(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }
  const location = runnerLocation();
  if (!location) throw new Error("slipjay release --confirm runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const startedAt = Date.now();
  const confirmable = await confirmableCandidate(process.cwd(), options.confirm, options.migrationsReady);
  if (confirmable.status !== "confirmable") {
    console.log(JSON.stringify(confirmable, null, 2));
    return 1;
  }
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error(`Stopped following; rerun slipjay release --confirm ${options.confirm} to reattach`));
  process.once("SIGINT", stopFollowing);
  let followed: Awaited<ReturnType<typeof releaseThroughRunner>>;
  try {
    followed = await releaseThroughRunner(process.cwd(), { candidate: confirmable.candidate, remote: confirmable.remote,
      migrationsReady: options.migrationsReady, location, onLine: (line) => console.error(line), signal: following.signal });
  } finally {
    process.removeListener("SIGINT", stopFollowing);
  }
  const { operation, logUrl } = followed;
  const outcome = operation.result;
  let printed: Record<string, unknown>;
  if (outcome?.type === "released") printed = { ...outcome.result, log: logUrl };
  else if (outcome?.type === "failed") {
    console.error(`[runner] release failed at ${outcome.stage}: ${outcome.reason}`);
    if (outcome.command) console.error(outcome.command);
    if (outcome.output !== undefined) console.error(outcome.output);
    printed = { ok: false, status: "failed", stage: outcome.stage, reason: outcome.reason, log: logUrl };
  } else printed = { ok: false, status: operation.status, ...outcome?.type === "cancelled" ? { reason: outcome.reason } : {}, log: logUrl };
  console.log(JSON.stringify(printed, null, 2));
  await appendMetric("releases", { status: printed.status, candidate: confirmable.candidate,
    commits: outcome?.type === "released" ? outcome.result.commits : null, totalMs: Date.now() - startedAt });
  if (outcome?.type !== "released") return 1;
  // A published release whose post-release step failed still stands; 2 tells the caller to retry the step.
  return outcome.result.postRelease && !outcome.result.postRelease.ok ? 2 : 0;
}

/** `deploy <environment>`: deploy the integration branch's latest commit now, through the runner, and follow it. */
async function runDeploy(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("Usage: slipjay deploy <environment>");
  const location = runnerLocation();
  if (!location) throw new Error("slipjay deploy runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const { operation, logUrl } = await deployThroughRunner(process.cwd(), { environment: args[0]!, location, onLine: (line) => console.error(line) });
  const outcome = operation.result;
  if (outcome?.type === "failed") console.error(`[runner] deploy failed: ${outcome.reason}`);
  const record = outcome?.type === "deployed" ? outcome.record : outcome?.type === "failed" ? outcome.deployment : undefined;
  console.log(JSON.stringify({ ok: outcome?.type === "deployed", status: operation.status,
    ...outcome?.type === "failed" ? { reason: outcome.reason } : {}, ...record ? { record } : {}, log: logUrl }, null, 2));
  return outcome?.type === "deployed" ? 0 : 1;
}

/** `deploys [--environment <name>] [--json]`: what each deploy put where, newest first. */
async function runDeploys(args: string[]): Promise<number> {
  let environment: string | undefined;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") asJson = true;
    else if (args[index] === "--environment" && args[index + 1] && !args[index + 1]!.startsWith("-")) environment = args[++index];
    else throw new Error("Usage: slipjay deploys [--environment <name>] [--json]");
  }
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const deploys = await readDeploys(process.cwd(), { location, ...environment ? { environment } : {} });
  if (asJson) {
    console.log(JSON.stringify(deploys.map((operation) => ({ id: operation.id, environment: operation.environment, commitId: operation.commitId,
      status: operation.status, submittedBy: operation.submittedBy, submittedAt: operation.submittedAt, finishedAt: operation.finishedAt,
      ...operation.result?.type === "deployed" ? { record: operation.result.record } : {},
      ...operation.result?.type === "failed" ? { reason: operation.result.reason, ...operation.result.deployment ? { record: operation.result.deployment } : {} } : {},
    })), null, 2));
    return 0;
  }
  for (const operation of deploys) {
    const record = operation.result?.type === "deployed" ? operation.result.record : operation.result?.type === "failed" ? operation.result.deployment : undefined;
    console.log(`${operation.submittedAt}  ${operation.environment}  ${operation.commitId.slice(0, 12)}  ${operation.status}${operation.result?.type === "failed" ? `: ${operation.result.reason}` : ""}`);
    for (const project of record?.projects ?? []) console.log(`  ${project.name}: ${project.ok ? project.url ?? "deployed" : `failed: ${project.reason}`}`);
    if (record) {
      console.log(`  ${record.changes.length} change${record.changes.length === 1 ? "" : "s"} since ${record.previous?.slice(0, 12) ?? "the first deploy"}`);
      for (const change of record.changes) console.log(`    ${change.commitId.slice(0, 12)} ${change.subject}`);
    }
  }
  if (!deploys.length) console.log("No deploys yet.");
  return 0;
}

/** `cutover [--check]`: move Slipway's state from ~/.slipway to ~/.slipjay once, or only report whether it would. */
async function runCutover(args: string[]): Promise<number> {
  if (args.some((flag) => flag !== "--check")) throw new Error("Usage: slipjay cutover [--check]");
  const result = await cutover({ check: args.includes("--check") });
  if (result.status === "refused") {
    console.error(`Refusing the cutover while ${result.holders.length === 1 ? "this holds" : "these hold"} slipjay state; wait for ${result.holders.length === 1 ? "it" : "them"} to finish, then rerun:`);
    for (const holder of result.holders) console.error(`  - ${holder}`);
  }
  if (result.status === "already-cut-over" && result.reappeared) {
    console.error(`Old-location state exists again (${result.reappeared.join(", ")}): something still running Slipway wrote it after the cutover. slipjay ignores it; stop that process.`);
  }
  console.log(JSON.stringify(result, null, 2));
  return result.status === "refused" ? 1 : 0;
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command !== "status" && command !== "cutover" && command !== "--version" && cutoverPending()) {
    // Before the cutover, only `status` and `cutover` run: anything else would start a second lock store.
    console.error(`slipjay ${command ?? ""}`.trim() + ` refused: this machine's slipjay state still lives under ${legacyStateHome()}. `
      + "Run `slipjay cutover` once while nothing is landing (`slipjay cutover --check` reports what holds it), then retry.");
    process.exitCode = 1;
  } else if (command === "--version") {
    console.log(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } else if (command === "cutover") {
    process.exitCode = await runCutover(rest);
  } else if (command === "status" && cutoverPending()) {
    const context = await workspaceContext();
    console.log(JSON.stringify({
      cutover: { required: true, legacyState: legacyStateHome(), command: "slipjay cutover" },
      ...(context ? { workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch } : {}),
    }, null, 2));
  } else if (command === "status") {
    const context = await workspaceContext();
    const landing = context && context.current.name !== "default" ? await readLandingState(context.current.name, { readOnly: true }) : null;
    console.log(context
      ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch,
        ...(landing ? { landing: { phase: landing.phase, artifactCommitId: landing.artifactCommitId, ...(landing.primaryCheckout ? { primaryCheckout: landing.primaryCheckout } : {}) } } : {}) }, null, 2)
      : "Not inside a Jujutsu repository");
  } else if (command === "mode") {
    const requested = rest[0];
    console.log(requested ? await writeWorkspaceMode(requested) : await readWorkspaceMode());
  } else if (command === "list") {
    const context = await workspaceContext();
    for (const workspace of await inspectWorkspaces()) {
      const issue = workspace.metadata?.issueNumber ? ` · issue #${workspace.metadata.issueNumber}` : "";
      const state = workspace.name === "default" ? "integration" : workspace.metadata?.spare ? "spare"
        : workspace.hasWork ? "unlanded" : workspace.landed ? "landed" : "empty";
      // Landed checkouts should be gone; say why one is still here and what it costs.
      const paths = state === "landed" && workspace.root && context
        ? await retainedWorkspaceMaterial(workspace.root, context.integration.root).catch(() => [])
        : [];
      const kept = paths.length ? ` · ${diskUsage(workspace.root)} kept: ${describeRetention({ reason: "unique-files", paths })}` : "";
      console.log(`${workspace.name}\t${workspace.root}\t${state}${issue}${kept}`);
    }
  } else if (command === "prune") {
    if (rest[0] !== "--empty") throw new Error("Usage: slipjay prune --empty");
    const result = await pruneEmptyWorkspaces();
    for (const name of result.removed) console.log(`Removed empty workspace: ${name}`);
    for (const path of result.pruned) console.log(`Pruned state: ${path}`);
    for (const skipped of result.skipped) console.error(`Skipped ${skipped.name}: ${skipped.reason}`);
    if (result.removed.length === 0 && result.skipped.length === 0 && result.pruned.length === 0) console.log("No empty workspaces to prune.");
  } else if (command === "pool") {
    if (rest[0] === "refill") console.log(JSON.stringify(await provisionSpare(), null, 2));
    else if (rest.length === 0) {
      const spares = await readySpares(process.cwd());
      console.log(spares.length ? spares.map((spare) => `ready\t${spare.name}\t${spare.root}`).join("\n") : "No ready spare workspace.");
    } else throw new Error("Usage: slipjay pool [refill]");
  } else if (command === "attach-issue") {
    const issueNumber = Number(rest[0]);
    const result = await attachWorkspaceIssue(process.cwd(), issueNumber);
    console.log(`Attached Issue #${result.issueNumber} to jj:${result.workspaceName}.`);
  } else if (command === "start") {
    const options = startOptions(rest);
    if (!options) {
      console.error('Usage: slipjay start [--integration] [--issue <n>] [--refill] [--json] ["task"]');
      process.exitCode = 2;
    } else if (options.json && options.resultFd === undefined) {
      process.exitCode = await startForJson(rest);
    } else {
      const root = options.integration ? await integrationRoot(process.cwd()) : process.cwd();
      const task = options.task || `Issue #${options.issueNumber}`;
      const result = await createWorkspace(task, root, options.issueNumber ? { issueNumber: options.issueNumber } : {});
      // Prepare the next session's spare in the background, so its start can claim it.
      // A claimed spare is replaced in the background too, so a burst of starts finds the pool refilled.
      const refill = options.refill || result.pooled ? await startSpareRefill(root).catch((error) => ({ started: false, reason: error.message })) : undefined;
      if (refill && !refill.started) console.error(`Spare refill not started: ${refill.reason}`);
      if (options.resultFd === undefined) console.log(result.workspacePath);
      else {
        writeSync(options.resultFd, `${JSON.stringify({
          workspacePath: result.workspacePath, workspaceName: result.current.name, integrationRoot: result.integration.root,
          issueNumber: options.issueNumber ?? null, created: result.created ?? false, reused: result.reused ?? false, pooled: Boolean(result.pooled),
          ...(refill ? { refill } : {}),
        })}\n`);
      }
    }
  } else if (command === "preview") {
    const preview = await landingPreview();
    console.log(preview.stat || "(no changed files)");
  } else if (command === "land") {
    if (rest.some((flag) => flag !== "--direct")) throw new Error("Usage: slipjay land [--direct]");
    // --direct lands the primary checkout itself, for a session explicitly working Direct.
    const location = runnerLocation();
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    const timing: { startedAt: number; stages: [string, number][] } = { startedAt: Date.now(), stages: [] };
    // The landing may remove this very directory, after which process.cwd() throws.
    const landedFrom = basename(process.cwd());
    const following = new AbortController();
    const stopFollowing = () => following.abort(new Error("Stopped following; rerun slipjay land to reattach"));
    process.once("SIGINT", stopFollowing);
    try {
      const runner = await landThroughRunner(process.cwd(), {
        location, direct: rest.includes("--direct"), onLine: (line) => console.error(line), signal: following.signal,
        onStage: (stage) => timing.stages.push([stage, Date.now()]),
      });
      // stderr, so stdout stays the JSON result.
      const finished = { ...timing, finishedAt: Date.now() };
      console.error(landingTimingLine(finished));
      await appendMetric("landings", { workspace: landedFrom, verdict: runner.operation.status, ...landingTimingRecord(finished, runner.ok) });
      console.log(JSON.stringify({ ok: runner.ok, verdict: runner.operation.status, log: runner.logUrl }));
      if (!runner.ok) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stopFollowing);
    }
  } else if (command === "release") {
    process.exitCode = await runRelease(rest);
  } else if (command === "deploy") {
    process.exitCode = await runDeploy(rest);
  } else if (command === "deploys") {
    process.exitCode = await runDeploys(rest);
  } else if (command === "runner") {
    if (rest[0] === "log" && rest.length === 2) {
      const location = runnerLocation();
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      process.stdout.write(await readRunLog(location, rest[1]!));
    } else if (rest.length === 1 && (rest[0] === "kill" || rest[0] === "pause" || rest[0] === "resume")) {
      const location = runnerLocation();
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      const outcome = await controlRunner(location, rest[0]);
      console.log(outcome.line);
      if (!outcome.ok) process.exitCode = 1;
    } else if (rest.join(" ") === "serve") {
      const runner = await startRunner();
      console.error(`SlipJay runner listening on ${runner.url}`);
      // systemd stops the unit with SIGTERM; a running gate is left to restart recovery.
      await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
      process.exit(0);
    } else throw new Error("Usage: slipjay runner <serve|log <operation>|kill|pause|resume>");
  } else if (command === "guard") {
    // Claude Code PreToolUse hook: reads the tool call on stdin, prints a deny decision.
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const decision = await landingGuardDecision(input.trim() ? JSON.parse(input) : {});
    if (decision) console.log(JSON.stringify(decision));
  } else if (command === "cleanup") {
    if (rest.length > 1 || rest[0]?.startsWith("-")) throw new Error("Usage: slipjay cleanup [path]");
    const result = await cleanupLandedWorkspace(rest[0] ? resolve(rest[0]) : process.cwd());
    console.log(result.cleaned ? "Workspace removed." : `Workspace retained: ${describeRetention(result)}.`);
  } else if (command === "remove") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error("Usage: slipjay remove <path>");
    process.exitCode = await removeWorkspaceAt(resolve(rest[0]!));
  } else {
    console.error("Usage: slipjay <--version|status|mode|list|pool [refill]|prune --empty|attach-issue|start|preview|land|release [--confirm <commit>] [--migrations-ready]|deploy <environment>|deploys [--environment <name>] [--json]|cleanup [path]|remove <path>|cutover [--check]|runner <serve|log <operation>|kill|pause|resume>>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
