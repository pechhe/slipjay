#!/usr/bin/env bun
import { cancelThroughRunner, watchThroughRunner, controlRunner, deployThroughRunner, landThroughRunner, readDeploys, readPromotionState, readBuildThroughRunner, readRunLog, readRunArtifact, readLandingOutcome, readLandingHandoff, downloadSubmissionSource, manageRepairClaim, releaseThroughRunner, resetThroughRunner, runLogCommand, runnerLocation, recordClientFacts, recordClientFactsInBackground, readMetricsEvents, operationRunnerLocation } from "../lib/runner-client.ts";
import { pipelineMetrics, formatPipelineMetrics } from "../lib/pipeline-metrics.ts";
import { HANDOFF_MAX_BYTES, validSubmissionHandoff } from "../lib/submission-handoff.ts";
import type { SubmissionHandoff } from "../lib/submission-handoff.ts";
import { ATTEMPT_ID, readAttempt, releaseAttempt } from "../lib/workspace-attempts.ts";
import type { SweepOptions } from "../lib/workspace-sweep.ts";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { confirmableCandidate } from "../lib/release.ts";
import { startRunner } from "../lib/runner-service.ts";

import {
  attachWorkspaceIssue,
  cleanupLandedWorkspace,
  createWorkspace,
  resolveStartBase,
  inspectWorkspaces,
  landingPreview,
  releaseIntegration,
  planDisposableWorkspaces,
  pruneEmptyWorkspaces,
  readWorkspaceMode,
  workspaceContext,
  writeWorkspaceMode,
  refillPool,
  readySpares,
  spareAllowance,
  describeRetention,
  retainedWorkspaceMaterial,
  readLandedRecord,
  readLandingState,
  removeWorkspace,
  startSpareRefill,
  cutover,
  cutoverPending,
} from "../lib/slipjay.ts";
import { legacyStateHome, machineConfigPath } from "../lib/workspace-paths.ts";
import { checkoutIdentity, machineSpareLimit, machineSpareLimits, readMachineConfig, runnerSetting, setConfiguredRunner, setMachineSpareLimit } from "../lib/machine-config.ts";
import { setPolicy, showPolicy } from "../lib/policy-command.ts";
import { retiredFieldsWarning } from "../lib/execution-policy.ts";
import { workspaceMetadata } from "../lib/workspace-state.ts";
import { landingGuardDecision } from "../lib/landing-guard.ts";
import { landingTimingLine } from "../lib/landing-timing.ts";
import { repairFailedLanding } from "../lib/repair-workspace.ts";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

const LAND_USAGE = "Usage: slipjay land [--direct] [--handoff <json-file> | [--session <build-session-id>] [--ticket <n>]...]";

/** Disk use of a checkout, for spotting retained workspaces worth reclaiming. */
function diskUsage(root: string): string {
  try { return execFileSync("du", ["-sh", root], { encoding: "utf8", timeout: 60_000 }).split("\t")[0] ?? "?"; }
  catch { return "?"; }
}

/** What `prune --empty` (with `emptyIdleMs: 0`) or the automatic sweep would do now, changing nothing. */
async function printRetentionPlan(options: SweepOptions, json: boolean): Promise<void> {
  const planned = await planDisposableWorkspaces(process.cwd(), options);
  if (json) return console.log(JSON.stringify(planned, null, 2));
  if (planned[0]) console.log(`repository ${planned[0].repository}`);
  const unknown = "unknown";
  for (const workspace of planned) {
    const issue = workspace.issueNumber ? ` · issue #${workspace.issueNumber}` : "";
    const size = workspace.sizeBytes === null ? `size ${unknown}` : `${Math.round(workspace.sizeBytes / 1024 / 1024)} MB`;
    const landing = workspace.landing
      ? `${workspace.landing.phase}, ${workspace.landing.published === null ? `publication ${unknown}` : workspace.landing.published ? "published" : "not published"}`
      : "none";
    console.log(`\n${workspace.action.toUpperCase()} ${workspace.name} (${workspace.state}${issue} · ${size}): ${workspace.reason}`);
    console.log(`  path: ${workspace.root || unknown}`);
    if (workspace.state === "integration") continue;
    if (workspace.state === "orphan") console.log(`  repository: ${workspace.repository ?? "none (not a JJ checkout)"}`);
    else console.log(`  task: ${workspace.task ?? "none"} · assigned: ${workspace.assignedAt ?? unknown} · landing: ${landing}`);
    console.log(`  processes: ${workspace.holders === null ? unknown : workspace.holders.join(", ") || "none"}`);
    console.log(`  unique files: ${workspace.uniqueFiles === null ? unknown : workspace.uniqueFiles.join(", ") || "none"}`);
  }
}

/** The repository's integration checkout, even when `cwd` is inside one of its workspaces. */
async function integrationRoot(cwd: string): Promise<string> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  return context.integration.root;
}

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
 * `promote [--confirm <commit>] [--migrations-ready]`: plan a release here, or send
 * the candidate a human approved to the runner, which verifies and publishes it.
 * Progress goes to stderr; stdout is one JSON result.
 */
async function runPromote(args: string[]): Promise<number> {
  const options: { migrationsReady: boolean; confirm?: string } = { migrationsReady: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--migrations-ready") options.migrationsReady = true;
    else if (args[index] === "--confirm" && args[index + 1] && !args[index + 1]!.startsWith("-")) options.confirm = args[++index];
    else throw new Error("Usage: slipjay promote [--confirm <commit>] [--migrations-ready]");
  }
  const location = runnerLocation();
  if (options.confirm === undefined) {
    const plan = await releaseIntegration(process.cwd(),
      location ? { readPromotion: () => readPromotionState(process.cwd(), { location }), readBuild: (action, input) => readBuildThroughRunner(action, input) } : {});
    console.log(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }
  if (!location) throw new Error("slipjay promote --confirm runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const confirmable = await confirmableCandidate(process.cwd(), options.confirm, options.migrationsReady);
  if (confirmable.status !== "confirmable") {
    console.log(JSON.stringify(confirmable, null, 2));
    return 1;
  }
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error(`Stopped following; rerun slipjay promote --confirm ${options.confirm} to reattach`));
  process.once("SIGINT", stopFollowing);
  let followed: Awaited<ReturnType<typeof releaseThroughRunner>>;
  try {
    followed = await releaseThroughRunner(process.cwd(), { candidate: confirmable.candidate, remote: confirmable.remote,
      migrationsReady: options.migrationsReady, location, onLine: (line) => console.error(line), signal: following.signal });
  } finally {
    process.removeListener("SIGINT", stopFollowing);
  }
  const { operation, deploy, logUrl } = followed;
  const outcome = operation.result;
  const deployed = deploy?.result?.type === "deployed" ? deploy.result.record : deploy?.result?.type === "failed" ? deploy.result.deployment : undefined;
  let printed: Record<string, unknown>;
  if (outcome?.type === "released") {
    printed = { ...outcome.result, log: logUrl };
    if (deploy) {
      // The promotion's verdict is its production deploy's: `deployed`, or `deploy failed: <project> (<reason>)`, with any rollback.
      if (deploy.result?.type === "failed") console.error(`[runner] production ${deploy.result.reason}`);
      printed.production = { status: deploy.status, ...deploy.result?.type === "failed" ? { reason: deploy.result.reason } : {},
        ...deployed ? { record: deployed } : {}, log: runLogCommand(deploy.id) };
    }
  }
  else if (outcome?.type === "failed") {
    console.error(`[runner] release failed at ${outcome.stage}: ${outcome.reason}`);
    if (outcome.command) console.error(outcome.command);
    if (outcome.output !== undefined) console.error(outcome.output);
    printed = { ok: false, status: "failed", stage: outcome.stage, reason: outcome.reason, log: logUrl };
  } else printed = { ok: false, status: operation.status, ...outcome?.type === "cancelled" ? { reason: outcome.reason } : {}, log: logUrl };
  console.log(JSON.stringify(printed, null, 2));
  return outcome?.type !== "released" || (deploy && deploy.status !== "deployed") ? 1 : 0;
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

/** `reset`: reset the repository's declared target now, through the runner (or follow the open reset), to its verdict. */
async function runReset(args: string[]): Promise<number> {
  if (args.length) throw new Error("Usage: slipjay reset");
  const location = runnerLocation();
  if (!location) throw new Error("slipjay reset runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const { operation, logUrl } = await resetThroughRunner(process.cwd(), { location, onLine: (line) => console.error(line) });
  const outcome = operation.result;
  if (outcome?.type === "failed") console.error(`[runner] reset failed: ${outcome.reason}`);
  console.log(JSON.stringify({ ok: outcome?.type === "reset", status: operation.status,
    ...outcome?.type === "reset" ? { target: outcome.target, source: outcome.source } : {},
    ...outcome?.type === "failed" || outcome?.type === "cancelled" ? { reason: outcome.reason } : {}, log: logUrl }, null, 2));
  return outcome?.type === "reset" ? 0 : 1;
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

const CONFIG_USAGE = "Usage: slipjay config [--json] | config set runner <location> | config set spares <0-8> [--repo <integration checkout>] | config unset <runner|spares> [--repo <integration checkout>]";

/** `config`: this machine's runner location and spare limits, each with where it comes from. */
async function runConfig(args: string[]): Promise<number> {
  const [action, key, ...more] = args;
  if (!action || action === "--json") {
    if (args.length > 1) throw new Error(CONFIG_USAGE);
    const config = readMachineConfig();
    const runner = runnerSetting(process.env, config);
    const context = await workspaceContext().catch(() => null);
    const roots = [...new Set([...context ? [checkoutIdentity(context.integration.root)] : [], ...Object.keys(machineSpareLimits(config)).map(checkoutIdentity)])];
    const spares = await Promise.all(roots.map(async (repository) => {
      const repositoryContext = await workspaceContext(repository).catch(() => null);
      const allowance = repositoryContext ? await spareAllowance(repositoryContext) : null;
      return { repository, declared: allowance?.declared ?? null, machineLimit: machineSpareLimit(repository, config), effective: allowance?.spares ?? null, source: allowance?.source ?? null };
    }));
    if (action === "--json") console.log(JSON.stringify({ path: machineConfigPath(), runner, spares }, null, 2));
    else {
      console.log(`runner: ${runner.value ?? "(none)"} (${runner.source === "environment" ? `from SLIPJAY_RUNNER${runner.overriddenByEnvironment ? `, overriding ${runner.file}` : ""}` : runner.source === "file" ? machineConfigPath() : "unset"})`);
      for (const entry of spares) {
        const declaredAt = entry.source ? ` on ${entry.source.integrationBranch}${entry.source.commitId ? ` at ${entry.source.commitId.slice(0, 12)}` : ""}` : "";
        console.log(`spares: ${entry.repository}: ${entry.effective ?? "?"} (declared ${entry.declared ?? "?"}${declaredAt}, machine limit ${entry.machineLimit ?? "none"})`);
      }
    }
    return 0;
  }
  if (action !== "set" && action !== "unset") throw new Error(CONFIG_USAGE);
  const repoIndex = more.indexOf("--repo");
  const repoPath = repoIndex >= 0 ? more[repoIndex + 1] : undefined;
  if (repoIndex >= 0 && (!repoPath || repoPath.startsWith("-"))) throw new Error(CONFIG_USAGE);
  const values = repoIndex >= 0 ? more.filter((_, index) => index !== repoIndex && index !== repoIndex + 1) : more;
  if (key === "runner" && repoIndex < 0 && values.length === (action === "set" ? 1 : 0)) {
    await setConfiguredRunner(action === "set" ? values[0]! : null);
    const runner = runnerSetting();
    console.log(JSON.stringify({ runner }));
    if (runner.overriddenByEnvironment) console.error(`SLIPJAY_RUNNER overrides this setting in the current environment (${runner.value})`);
    return 0;
  }
  if (key === "spares" && values.length === (action === "set" ? 1 : 0)) {
    const count = action === "set" ? Number(values[0]) : null;
    if (count !== null && !Number.isInteger(count)) throw new Error(CONFIG_USAGE);
    const root = await integrationRoot(repoPath ? resolve(repoPath) : process.cwd());
    await setMachineSpareLimit(root, count);
    const context = await workspaceContext(root);
    const allowance = context ? await spareAllowance(context) : null;
    console.log(JSON.stringify({ repository: root, declared: allowance?.declared ?? null, machineLimit: allowance?.machineLimit ?? null, effective: allowance?.spares ?? null, source: allowance?.source ?? null }));
    return 0;
  }
  throw new Error(CONFIG_USAGE);
}

const ATTEMPT_USAGE = "Usage: slipjay attempt show <id> | attempt release <id>";

const POLICY_USAGE = "Usage: slipjay policy show [--json] | policy set --base <revision> [--patch <json>] [--spares <0-8|default>] [--process <standard|light|default>] [--landing-verification <json list|default>] [--json-lines]";

/** `policy`: read the integration branch's policy, or land a change to its settings fields. */
async function runPolicy(args: string[]): Promise<number> {
  const [action, ...flags] = args;
  if (action === "show" && (flags.length === 0 || (flags.length === 1 && flags[0] === "--json"))) {
    const view = await showPolicy(process.cwd());
    if (flags[0] === "--json") console.log(JSON.stringify(view, null, 2));
    else {
      console.log(`${view.integrationBranch} @ ${view.revision.slice(0, 12)}${view.declared ? "" : " (no slipjay.json)"}`);
      console.log(`spares: ${view.settings.spares}\nprocess: ${view.settings.process}`);
      console.log(`requiredLandingVerification:${view.settings.requiredLandingVerification.length ? "" : " (none)"}`);
      for (const check of view.settings.requiredLandingVerification as { executable: string; args: string[] }[]) console.log(`  ${[check.executable, ...check.args].join(" ")}`);
      const retired = retiredFieldsWarning(view.declared);
      if (retired) console.error(retired);
    }
    return 0;
  }
  if (action !== "set") throw new Error(POLICY_USAGE);
  // With --json-lines, a caller learns the operation as soon as it is followed, then reads the outcome as the last line.
  const jsonLines = flags.includes("--json-lines");
  const onOperation = jsonLines ? (operationId: string) => console.log(JSON.stringify({ phase: "following", operationId })) : undefined;
  // Every failure before submission is a refusal the caller can tell apart from a landing outcome.
  let result: Awaited<ReturnType<typeof setPolicy>>;
  try { result = await runPolicySet(flags.filter((flag) => flag !== "--json-lines"), onOperation); }
  catch (error) { result = { ok: false, phase: "refused", reason: error instanceof Error ? error.message : String(error) }; }
  console.log(jsonLines ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return result.ok ? 0 : result.phase === "refused" ? 2 : 1;
}

/** `policy set`: parse the flags and land the patch; throws only before anything is submitted. */
async function runPolicySet(flags: string[], onOperation?: (operationId: string) => void): Promise<Awaited<ReturnType<typeof setPolicy>>> {
  let base: string | undefined;
  let patch: Record<string, unknown> = {};
  const json = (flag: string, value: string) => { try { return JSON.parse(value) as unknown; } catch { throw new Error(`${flag} must be JSON`); } };
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]!, value = flags[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(POLICY_USAGE);
    if (flag === "--base") base = value;
    else if (flag === "--patch") {
      const supplied = json(flag, value);
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("--patch must be a JSON object");
      patch = { ...patch, ...supplied };
    }
    else if (flag === "--spares") patch.spares = value === "default" ? null : Number(value);
    else if (flag === "--process") patch.process = value === "default" ? null : value;
    else if (flag === "--landing-verification") patch.requiredLandingVerification = value === "default" ? null : json(flag, value);
    else throw new Error(POLICY_USAGE);
  }
  if (!base) throw new Error(POLICY_USAGE);
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error("Stopped following; rerun the same slipjay policy set to reattach"));
  process.once("SIGINT", stopFollowing);
  try { return await setPolicy(process.cwd(), { base, patch, location, signal: following.signal, onLine: (line) => console.error(line), ...onOperation ? { onOperation } : {} }); }
  finally { process.removeListener("SIGINT", stopFollowing); }
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
    // The Issue attached by `start --issue` or `attach-issue`, for clients that label the workspace.
    const issueNumber = context ? (await workspaceMetadata(context.current.name))?.issueNumber : undefined;
    console.log(context
      ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: { ...context.current, ...(issueNumber ? { issueNumber } : {}) }, integration: context.integration, integrationBranch: context.integrationBranch,
        spares: await spareAllowance(context),
        ...(landing ? { landing: { phase: landing.phase, artifactCommitId: landing.artifactCommitId, ...(landing.primaryCheckout ? { primaryCheckout: landing.primaryCheckout } : {}) } } : {}) }, null, 2)
      : "Not inside a Jujutsu repository");
  } else if (command === "landed") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error("Usage: slipjay landed <path>");
    console.log(JSON.stringify(await readLandedRecord(resolve(rest[0]!))));
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
    const flags = new Set(rest);
    const plan = flags.delete("--plan"), json = flags.delete("--json"), empty = flags.delete("--empty");
    if (flags.size || (!plan && (!empty || json))) throw new Error("Usage: slipjay prune --empty | prune [--empty] --plan [--json]");
    const reader: Pick<SweepOptions, "readBuild"> = runnerLocation() ? { readBuild: (action, input) => readBuildThroughRunner(action, input) } : {};
    if (plan) await printRetentionPlan({ ...reader, ...empty ? { emptyIdleMs: 0 } : {} }, json);
    else {
      const result = await pruneEmptyWorkspaces(process.cwd(), reader);
      for (const name of result.removed) console.log(`Removed empty workspace: ${name}`);
      for (const path of result.pruned) console.log(`Pruned state: ${path}`);
      for (const path of result.orphans) console.log(`Removed orphaned directory: ${path}`);
      for (const skipped of result.skipped) console.error(`Skipped ${skipped.name}: ${skipped.reason}`);
      if (result.removed.length === 0 && result.skipped.length === 0 && result.pruned.length === 0 && result.orphans.length === 0) console.log("No empty workspaces to prune.");
    }
  } else if (command === "pool") {
    if (rest[0] === "refill") await refillPool(process.cwd(), (outcome) => console.log(JSON.stringify(outcome)));
    else if (rest.length === 0) {
      const spares = await readySpares(process.cwd());
      console.log(spares.length ? spares.map((spare) => `ready\t${spare.name}\t${spare.root}`).join("\n") : "No ready spare workspace.");
    } else throw new Error("Usage: slipjay pool [refill]");
  } else if (command === "repair") {
    const json = rest.includes("--json"), args = rest.filter((arg) => arg !== "--json");
    if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("Usage: slipjay repair <failed-operation> [--json]");
    const location = runnerLocation();
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    const setup = await repairFailedLanding(process.cwd(), args[0]!, { location });
    console.log(json ? JSON.stringify(setup) : [`${setup.resumed ? "Resumed" : "Ready"}: repair of ${setup.operationId} in ${setup.workspacePath}`,
      `Brief: ${setup.briefPath}`, "Fix it there, review it, then slipjay land from that workspace."].join("\n"));
  } else if (command === "attach-issue") {
    const issueNumber = Number(rest[0]);
    const result = await attachWorkspaceIssue(process.cwd(), issueNumber);
    console.log(`Attached Issue #${result.issueNumber} to jj:${result.workspaceName}.`);
  } else if (command === "start") {
    const options = startOptions(rest);
    if (!options) {
      console.error('Usage: slipjay start [--integration] [--issue <n> | --base <revision>] [--attempt <id>] [--refill] [--json] ["task"]');
      process.exitCode = 2;
    } else if (options.json && options.resultFd === undefined) {
      process.exitCode = await startForJson(rest);
    } else {
      // The base names a revision of the caller's checkout, so it resolves there before moving to the integration root.
      const base = options.base ? await resolveStartBase(process.cwd(), options.base) : undefined;
      const root = options.integration ? await integrationRoot(process.cwd()) : process.cwd();
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const spareCount = (await readySpares(root)).length;
      const task = options.task || `Issue #${options.issueNumber}`;
      const result = await createWorkspace(task, root, {
        ...options.issueNumber ? { issueNumber: options.issueNumber } : base ? { base } : {},
        ...options.attemptId ? { attemptId: options.attemptId } : {},
      });
      // The runner is told in the background: a slow or unreachable one never delays the workspace.
      await recordClientFactsInBackground(result.workspacePath, [
        { kind: "workspace_start", workspace: result.current.name, machine: hostname(), startedAt },
        ...(result.created ? [{ kind: "pool_claim" as const, workspace: result.current.name, hit: Boolean(result.pooled), spareCount, durationMs: Date.now() - started }] : []),
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
        })}\n`);
      }
    }
  } else if (command === "attempt") {
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
  } else if (command === "preview") {
    const preview = await landingPreview();
    console.log(preview.stat || "(no changed files)");
  } else if (command === "land") {
    let handoff: SubmissionHandoff | undefined;
    const handoffIndex = rest.indexOf("--handoff");
    const flags = [...rest];
    if (handoffIndex >= 0) {
      const path = flags[handoffIndex + 1];
      if (!path || path.startsWith("--")) throw new Error(LAND_USAGE);
      const file = await open(path, "r");
      try {
        // Read one bounded buffer even if the file grows after stat.
        const bytes = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await file.read(bytes, size, bytes.length - size, null);
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > HANDOFF_MAX_BYTES) throw new Error("Handoff exceeds 64KiB");
        let value: unknown;
        try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch { throw new Error("Handoff is not valid JSON"); }
        if (!validSubmissionHandoff(value)) throw new Error("Invalid version-1 handoff evidence");
        handoff = value;
      } finally { await file.close(); }
      flags.splice(handoffIndex, 2);
    }
    let session: string | undefined;
    const tickets: number[] = [];
    for (let index = flags.indexOf("--session"); index >= 0; index = flags.indexOf("--session")) {
      const value = flags[index + 1];
      if (!value || value.startsWith("--") || session !== undefined) throw new Error(LAND_USAGE);
      session = value;
      flags.splice(index, 2);
    }
    for (let index = flags.indexOf("--ticket"); index >= 0; index = flags.indexOf("--ticket")) {
      const value = Number(flags[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(LAND_USAGE);
      tickets.push(value);
      flags.splice(index, 2);
    }
    if (flags.some((flag) => flag !== "--direct")) throw new Error(LAND_USAGE);
    // --direct lands the primary checkout itself, for a session explicitly working Direct.
    const location = runnerLocation();
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    const retired = retiredFieldsWarning((await workspaceContext().catch(() => null))?.configuration);
    if (retired) console.error(retired);
    const timing: { startedAt: number; stages: [string, number][] } = { startedAt: Date.now(), stages: [] };
    // The landing may remove this very directory, after which process.cwd() throws.
    const following = new AbortController();
    const stopFollowing = () => following.abort(new Error("Stopped following; rerun slipjay land to reattach"));
    process.once("SIGINT", stopFollowing);
    try {
      const runner = await landThroughRunner(process.cwd(), {
        location, handoff, session, tickets, direct: flags.includes("--direct"), onLine: (line) => console.error(line), signal: following.signal,
        onStage: (stage) => timing.stages.push([stage, Date.now()]),
      });
      // stderr, so stdout stays the JSON result.
      const finished = { ...timing, finishedAt: Date.now() };
      console.error(landingTimingLine(finished));
      console.log(JSON.stringify({ ok: runner.ok, verdict: runner.operation.status, log: runner.logUrl,
        ...(runner.operation.kind === "landing" && runner.operation.outcome ? { outcome: runner.operation.outcome } : {}) }));
      if (!runner.ok) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stopFollowing);
    }
  } else if (command === "release") {
    console.error("slipjay release is retired; use slipjay promote [--confirm <commit>] [--migrations-ready]");
    process.exitCode = 2;
  } else if (command === "promote") {
    process.exitCode = await runPromote(rest);
  } else if (command === "metrics") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--since")) throw new Error("Usage: slipjay metrics [--since <ISO date>]");
    const since = rest[1] ?? new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid metrics date");
    const location = runnerLocation();
    if (!location) throw new Error("Metrics requires a runner location");
    console.log(formatPipelineMetrics(pipelineMetrics(await readMetricsEvents(location), since)));
  } else if (command === "record-preview") {
    const port = Number(rest[0]);
    if (rest.length !== 1 || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Usage: slipjay record-preview <port>");
    const context = await workspaceContext();
    if (!context) throw new Error("Preview record requires a workspace");
    await recordClientFacts(process.cwd(), [{ kind: "preview_start", workspace: context.current.name, port }]);
  } else if (command === "watch") {
    if (rest.length !== 1 || rest[0] !== "--json") throw new Error("Usage: slipjay watch --json");
    const location = runnerLocation();
    if (!location)
      throw new Error("No runner location: set SLIPJAY_RUNNER or runner in ~/.slipjay/config.json");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await watchThroughRunner(
        location,
        (envelope) => console.log(JSON.stringify(envelope)),
        controller.signal,
      );
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } else if (command === "cancel") {
    if (rest.length !== 1 || rest[0]!.startsWith("-"))
      throw new Error("Usage: slipjay cancel <id>");
    const location = runnerLocation();
    if (!location)
      throw new Error("No runner location: set SLIPJAY_RUNNER or runner in ~/.slipjay/config.json");
    const outcome = await cancelThroughRunner(location, rest[0]!);
    console.log(JSON.stringify(outcome.result));
    if (!outcome.ok) process.exitCode = 1;
  } else if (command === "config") {
    process.exitCode = await runConfig(rest);
  } else if (command === "policy") {
    process.exitCode = await runPolicy(rest);
  } else if (command === "deploy") {
    process.exitCode = await runDeploy(rest);
  } else if (command === "reset") {
    process.exitCode = await runReset(rest);
  } else if (command === "deploys") {
    process.exitCode = await runDeploys(rest);
  } else if (command === "runner") {
    if (rest[0] === "artifact" && rest.length === 3) {
      const location = await operationRunnerLocation(rest[1]!);
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      console.log(JSON.stringify(await readRunArtifact(location, rest[1]!, rest[2]!), null, 2));
    } else if (["repair-claim", "repair-release", "repair-revoke"].includes(rest[0] ?? "") && rest.length === 2) {
      const location = runnerLocation();
      if (!location) throw new Error("No runner location configured");
      console.log(JSON.stringify(await manageRepairClaim(process.cwd(), location, rest[1]!, rest[0]!.slice(7) as "claim" | "release" | "revoke"), null, 2));
    } else if (rest[0] === "source" && rest.length === 3) {
      const location = await operationRunnerLocation(rest[1]!);
      if (!location) throw new Error("No runner location configured");
      console.log(JSON.stringify(await downloadSubmissionSource(location, rest[1]!, resolve(rest[2]!)), null, 2));
    } else if (rest[0] === "handoff" && rest.length === 2) {
      const location = await operationRunnerLocation(rest[1]!);
      if (!location) throw new Error("No runner location configured");
      console.log(JSON.stringify(await readLandingHandoff(location, rest[1]!), null, 2));
    } else if (rest[0] === "outcome" && rest.length === 2) {
      const location = await operationRunnerLocation(rest[1]!);
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      console.log(JSON.stringify(await readLandingOutcome(location, rest[1]!), null, 2));
    } else if (rest[0] === "log" && rest.length === 2) {
      const location = await operationRunnerLocation(rest[1]!);
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      process.stdout.write(await readRunLog(location, rest[1]!));
    } else if ((rest.length === 1 && (rest[0] === "kill" || rest[0] === "pause" || rest[0] === "resume")) || (rest.length === 2 && rest[0] === "kill" && !rest[1]!.startsWith("-"))) {
      const location = runnerLocation();
      if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
      const outcome = await controlRunner(location, rest[0] as "kill" | "pause" | "resume", process.env, rest[1]);
      console.log(outcome.line);
      if (!outcome.ok) process.exitCode = 1;
    } else if (rest.join(" ") === "serve") {
      const runner = await startRunner();
      console.error(`SlipJay runner listening on ${runner.url}`);
      // systemd stops the unit with SIGTERM; a running gate is left to restart recovery.
      await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
      process.exit(0);
    } else throw new Error("Usage: slipjay runner <serve|log <operation>|outcome <operation>|handoff <operation>|source <operation> <bundle-file>|repair-claim <operation>|repair-release <operation>|repair-revoke <operation>|artifact <operation> <run>|kill [<operation>]|pause|resume>");
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
    console.error("Usage: slipjay <--version|status|config|policy <show|set>|mode|list|pool [refill]|prune --empty|prune [--empty] --plan [--json]|attach-issue|start|attempt <show|release> <id>|repair <failed-operation> [--json]|preview|land|promote [--confirm <commit>] [--migrations-ready]|deploy <environment>|deploys [--environment <name>] [--json]|reset|metrics [--since <ISO date>]|record-preview <port>|watch --json|cancel <id>|cleanup [path]|remove <path>|cutover [--check]|runner <serve|log <operation>|outcome <operation>|handoff <operation>|source <operation> <bundle-file>|repair-claim <operation>|repair-release <operation>|repair-revoke <operation>|artifact <operation> <run>|kill [<operation>]|pause|resume>>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
