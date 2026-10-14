import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { withFinalizationSource } from "./post-integration-source.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { DeploymentEnvironment } from "./deployment-policy.ts";
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

/**
 * Deploy every project of one environment from an exact source view of `commitId`,
 * one after another, and return the record. A failing project does not stop the
 * rest: the record says which projects serve the new commit.
 */
export async function runDeploy(input: {
  gitDirectory: string; environment: string; commitId: string; previous: string | null;
  policy: DeploymentEnvironment;
  /** Where the declared `environmentKeys` are read from. */
  readEnvironment: () => NodeJS.ProcessEnv;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  onProgress(line: string): void;
}): Promise<DeployRecord> {
  const { gitDirectory, environment, commitId, previous, policy } = input;
  const changes = await changesSince(gitDirectory, previous, commitId);
  const projects = await withFinalizationSource(gitDirectory, commitId, async (root) => {
    const declared = input.readEnvironment();
    const env = sanitizedProcessEnv();
    for (const key of policy.environmentKeys) if (declared[key] !== undefined) env[key] = declared[key];
    Object.assign(env, { SLIPJAY_DEPLOY_ENVIRONMENT: environment, SLIPJAY_DEPLOY_COMMIT: commitId });
    const outcomes: DeployProjectOutcome[] = [];
    for (const project of policy.projects) {
      input.onProgress(`[deploy ${project.name}] deploying ${commitId.slice(0, 12)} to ${environment}`);
      const result = await input.run({ executable: project.command.executable, args: project.command.args,
        cwd: path.join(root, project.command.cwd), env, timeoutMs: policy.timeoutMs, maxOutputBytes: 256 * 1024 });
      const url = result.stdout.split("\n").map((line) => line.trim()).findLast((line) => URL_LINE.test(line));
      if (result.exitCode === 0 && !result.timedOut && !result.signal && !result.error) {
        outcomes.push({ name: project.name, ok: true, ...(url ? { url } : {}) });
        input.onProgress(`[deploy ${project.name}] deployed${url ? ` ${url}` : ""}`);
        continue;
      }
      const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n").slice(-600);
      const reason = `${result.timedOut ? `timed out after ${policy.timeoutMs} ms` : result.signal ? `stopped by ${result.signal}` : `exited ${result.exitCode ?? result.error}`}${tail ? `: ${tail}` : ""}`;
      outcomes.push({ name: project.name, ok: false, reason });
      input.onProgress(`[deploy ${project.name}] failed: ${reason}`);
    }
    return outcomes;
  });
  return { environment, commitId, previous, changes, projects };
}
