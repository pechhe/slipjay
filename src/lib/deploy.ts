import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { withFinalizationSource } from "./post-integration-source.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { DeploymentEnvironment } from "./deployment-policy.ts";
import type { FinalizationCommand } from "./post-integration-policy.ts";
import type { DeployProjectOutcome, DeployRecord } from "./runner-contract.ts";

/** How many commits a deploy record lists; a longer range says how many it left out. */
const CHANGES_LIMIT = 200;
const URL_LINE = /^https?:\/\/\S+$/;

async function git(gitDirectory: string, args: string[]): Promise<string> {
  const result = await runBoundedProcess({ executable: "git", args: ["--git-dir", gitDirectory, ...args], cwd: gitDirectory,
    env: sanitizedProcessEnv(), timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.error || result.signal)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-2).join(" ")}`);
  return result.stdout;
}

/**
 * Make `commitId` readable from the runner's warm store without touching its refs or
 * working copy, which the landing lane owns: a commit landed elsewhere (a direct
 * landing) is fetched by id, objects only.
 */
export async function ensureDeployCommit(gitDirectory: string, url: string, commitId: string): Promise<void> {
  if (await git(gitDirectory, ["cat-file", "-e", `${commitId}^{commit}`]).then(() => true, () => false)) return;
  await git(gitDirectory, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, commitId]);
}

/** Refuse a commit that is not on the remote's integration branch: only landed work deploys. */
export async function ensureOnIntegrationBranch(gitDirectory: string, url: string, branch: string, commitId: string): Promise<void> {
  const tip = (await git(gitDirectory, ["ls-remote", url, `refs/heads/${branch}`])).split("\t")[0]?.trim();
  if (!tip || !/^[a-f0-9]{40,64}$/.test(tip)) throw new Error(`Could not read ${branch} on ${url}`);
  await ensureDeployCommit(gitDirectory, url, tip);
  if (!await git(gitDirectory, ["merge-base", "--is-ancestor", commitId, tip]).then(() => true, () => false))
    throw new Error(`${commitId.slice(0, 12)} is not on ${branch}; only landed commits deploy`);
}

/** The commits from `previous` (exclusive) to `commitId`, newest first; just `commitId` for a first deploy. */
async function changesSince(gitDirectory: string, previous: string | null, commitId: string): Promise<DeployRecord["changes"]> {
  const range = previous ? [`${previous}..${commitId}`] : ["-n", "1", commitId];
  const out = await git(gitDirectory, ["log", `--max-count=${CHANGES_LIMIT}`, "--format=%H%x09%s", ...range]);
  return out.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { commitId: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

/** Why a finished command did not succeed, with the tail of its output; null when it did. */
function failure(result: BoundedProcessResult, timeoutMs: number): string | null {
  if (result.exitCode === 0 && !result.timedOut && !result.signal && !result.error) return null;
  const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n").slice(-600);
  return `${result.timedOut ? `timed out after ${timeoutMs} ms` : result.signal ? `stopped by ${result.signal}` : `exited ${result.exitCode ?? result.error}`}${tail ? `: ${tail}` : ""}`;
}

/**
 * Deploy every project of one environment from an exact source view of `commitId`,
 * one after another, health-check each, and return the record. A failing project does
 * not stop the rest: the record says which projects serve the new commit. Where the
 * environment activates, traffic moves only once every project passed, and an
 * activation that fails moves the projects already activated back to `previousUrls`,
 * unless `restore` is false (the owner decides).
 */
export async function runDeploy(input: {
  gitDirectory: string; environment: string; commitId: string; previous: string | null;
  policy: DeploymentEnvironment;
  /** The deployment each project served before, for moving traffic back. */
  previousUrls?: Record<string, string>;
  restore?: boolean;
  /** Where the declared `environmentKeys` are read from. */
  readEnvironment: () => NodeJS.ProcessEnv;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  onProgress(line: string): void;
}): Promise<DeployRecord> {
  const { gitDirectory, environment, commitId, previous, policy, previousUrls = {}, restore = true } = input;
  const changes = await changesSince(gitDirectory, previous, commitId);
  const projects = await withFinalizationSource(gitDirectory, commitId, async (root) => {
    const declared = input.readEnvironment();
    const env = sanitizedProcessEnv();
    for (const key of policy.environmentKeys) if (declared[key] !== undefined) env[key] = declared[key];
    Object.assign(env, { SLIPJAY_DEPLOY_ENVIRONMENT: environment, SLIPJAY_DEPLOY_COMMIT: commitId });
    const step = (command: FinalizationCommand, url?: string) => input.run({ executable: command.executable, args: command.args,
      cwd: path.join(root, command.cwd), env: url ? { ...env, SLIPJAY_DEPLOY_URL: url } : env, timeoutMs: policy.timeoutMs, maxOutputBytes: 256 * 1024 });
    const outcomes: DeployProjectOutcome[] = [];
    for (const project of policy.projects) {
      input.onProgress(`[deploy ${project.name}] deploying ${commitId.slice(0, 12)} to ${environment}`);
      const result = await step(project.command);
      const url = result.stdout.split("\n").map((line) => line.trim()).findLast((line) => URL_LINE.test(line));
      const failed = failure(result, policy.timeoutMs);
      if (failed) {
        outcomes.push({ name: project.name, ok: false, reason: failed });
        input.onProgress(`[deploy ${project.name}] failed: ${failed}`);
        continue;
      }
      input.onProgress(`[deploy ${project.name}] deployed${url ? ` ${url}` : ""}`);
      const unhealthy = project.healthCheck ? url ? failure(await step(project.healthCheck, url), policy.timeoutMs) : "printed no deployment URL to check" : null;
      if (unhealthy) {
        outcomes.push({ name: project.name, ok: false, ...(url ? { url } : {}), reason: `health check failed: ${unhealthy}` });
        input.onProgress(`[deploy ${project.name}] health check failed: ${unhealthy}`);
        continue;
      }
      if (project.healthCheck) input.onProgress(`[deploy ${project.name}] healthy`);
      outcomes.push({ name: project.name, ok: true, ...(url ? { url } : {}) });
    }
    if (!policy.projects.some((project) => project.activate)) return outcomes;
    for (const outcome of outcomes) outcome.activated = false;
    if (outcomes.some((outcome) => !outcome.ok)) {
      input.onProgress(`[deploy] activating nothing: ${environment} keeps serving what it served before`);
      return outcomes;
    }
    for (const [index, project] of policy.projects.entries()) {
      const outcome = outcomes[index]!;
      const failed = outcome.url ? failure(await step(project.activate!, outcome.url), policy.timeoutMs) : "printed no deployment URL to activate";
      if (!failed) {
        outcome.activated = true;
        input.onProgress(`[deploy ${project.name}] activated ${outcome.url}`);
        continue;
      }
      Object.assign(outcome, { ok: false, reason: `activation failed: ${failed}` });
      input.onProgress(`[deploy ${project.name}] activation failed: ${failed}`);
      for (const [earlier, moved] of policy.projects.slice(0, index).entries()) {
        if (!restore) continue;
        const activated = outcomes[earlier]!;
        const before = previousUrls[moved.name];
        const unrestored = before ? failure(await step(moved.activate!, before), policy.timeoutMs) : "no earlier deployment is recorded";
        // The project stays activated on the promotion, and the record says why.
        if (unrestored) {
          activated.reason = `could not be moved back: ${unrestored}`;
          input.onProgress(`[deploy ${moved.name}] could not be moved back: ${unrestored}`);
        } else {
          Object.assign(activated, { activated: false, restored: true });
          input.onProgress(`[deploy ${moved.name}] moved back to ${before}`);
        }
      }
      break;
    }
    return outcomes;
  });
  return { environment, commitId, previous, changes, projects };
}
