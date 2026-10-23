import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { redactMigrationOutput } from "../landing/migration-command-evidence.ts";
import { withFinalizationSource } from "./post-integration-source.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { DeploymentEnvironment } from "../policy/deployment-policy.ts";
import type { FinalizationCommand } from "../policy/post-integration-policy.ts";
import type { DeployMigrations, DeployProjectOutcome, DeployRecord } from "../runner/runner-types.ts";
import { firstError, outputLines } from "../infra/verification-failure.ts";

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
/** Why a step failed: the first error block in either stream when it printed one (an uncaught error's last lines are its stack), else its last lines. */
export function failure(result: BoundedProcessResult, timeoutMs: number): string | null {
  if (result.exitCode === 0 && !result.timedOut && !result.signal && !result.error) return null;
  const error = firstError(outputLines(result));
  const detail = error.length ? error.join("\n").slice(0, 600) : (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n").slice(-600);
  return `${result.timedOut ? `timed out after ${timeoutMs} ms` : result.signal ? `stopped by ${result.signal}` : `exited ${result.exitCode ?? result.error}`}${detail ? `: ${detail}` : ""}`;
}

/**
 * Whether a promotion's migrations may have changed the schema: an environment that
 * declares none may have had them applied by hand; one that does changed it if its apply
 * ran, or found them already in place (`current` with files to apply: an earlier deploy
 * or the owner applied them), or an earlier deploy of the same commit did. A first
 * `verify_failed` and a deploy that never reached the migrations touched nothing.
 */
export const schemaMayHaveChanged = (declared: boolean, migrations: DeployMigrations | undefined, earlierChanged = false): boolean =>
  !declared || earlierChanged || migrations?.status === "applied" || migrations?.status === "apply_failed"
  || (migrations?.status === "current" && migrations.artifacts.length > 0);

/**
 * Deploy every project of one environment from an exact source view of `commitId`,
 * side by side, health-check each, and return the record. A failing project does
 * not stop the rest: the record says which projects serve the new commit. Where the
 * environment activates, traffic moves only once every project passed and its
 * declared migrations brought the database to the commit, and an activation that
 * fails moves the projects already activated back to `previousUrls`, unless the promotion
 * is `nonAdditive` and its migrations may have changed the schema (the owner decides).
 * Migrations known to be additive are applied before any project deploys, so the health
 * checks run the new code on its own schema; migrations that fail there leave nothing deployed.
 */
export async function runDeploy(input: {
  gitDirectory: string; environment: string; commitId: string; previous: string | null;
  policy: DeploymentEnvironment;
  /** The deployment each project served before, for moving traffic back. */
  previousUrls?: Record<string, string>;
  /** The promotion carries migrations that earlier code may not survive (see `nonAdditiveSql`). */
  nonAdditive?: boolean;
  /** An earlier deploy of this commit applied, or part-applied, its migrations. */
  earlierSchemaChange?: boolean;
  /** The migration files the deploy carries, for its record. */
  migrationArtifacts?: string[];
  /** Where the declared `environmentKeys` are read from. */
  readEnvironment: () => NodeJS.ProcessEnv;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  onProgress(line: string): void;
}): Promise<DeployRecord> {
  const { gitDirectory, environment, commitId, previous, policy, previousUrls = {}, nonAdditive = false, earlierSchemaChange = false } = input;
  const changes = await changesSince(gitDirectory, previous, commitId);
  let migrations: DeployMigrations | undefined;
  const projects = await withFinalizationSource(gitDirectory, commitId, async (root) => {
    const declared = input.readEnvironment();
    const env = sanitizedProcessEnv();
    for (const key of policy.environmentKeys) if (declared[key] !== undefined) env[key] = declared[key];
    Object.assign(env, { SLIPJAY_DEPLOY_ENVIRONMENT: environment, SLIPJAY_DEPLOY_COMMIT: commitId });
    const step = (command: FinalizationCommand, url?: string, extra: NodeJS.ProcessEnv = {}) => input.run({ executable: command.executable, args: command.args,
      cwd: path.join(root, command.cwd), env: { ...env, ...url ? { SLIPJAY_DEPLOY_URL: url } : {}, ...extra }, timeoutMs: policy.timeoutMs, maxOutputBytes: 256 * 1024 });
    // Brings the database to the commit and records how; false when it could not.
    const migrate = async (): Promise<boolean> => {
      if (!policy.migrations) return true;
      const { verify, apply } = policy.migrations;
      // A connection error can print the database URL: redact whole streams before clipping them.
      const redact = (value: string) => redactMigrationOutput(value, root, env);
      const failed = (result: BoundedProcessResult) => failure({ ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }, policy.timeoutMs);
      input.onProgress(`[migrations] verifying ${environment} against ${commitId.slice(0, 12)}`);
      const first = await step(verify);
      if (failure(first, policy.timeoutMs) === null) migrations = { artifacts, status: "current" };
      else if (first.exitCode !== 2 || first.timedOut || first.signal || first.error)
        migrations = { artifacts, status: "verify_failed", reason: `verify ${failed(first)}` };
      else {
        input.onProgress(`[migrations] applying pending migrations`);
        const applied = await step(apply);
        const after = failure(applied, policy.timeoutMs) === null ? await step(verify) : null;
        migrations = !after ? { artifacts, status: "apply_failed", reason: `apply ${failed(applied)}` }
          : failure(after, policy.timeoutMs) !== null ? { artifacts, status: "apply_failed", reason: `verify after apply ${failed(after)}` }
          : { artifacts, status: "applied" };
      }
      input.onProgress(`[migrations] ${migrations.status}${migrations.reason ? `: ${migrations.reason}` : ""}`);
      return !migrations.reason;
    };
    const holdBack = () => input.onProgress(`[deploy] activating nothing: ${environment} keeps serving what it served before`);
    const activates = policy.projects.some((project) => project.activate);
    // Additive migrations go first, so the health checks run the new code on its own schema;
    // the code before the commit already fits it. Any others go last before traffic moves, so
    // code before the commit runs on their schema only briefly: non-additive ones, and those of
    // a deploy that does not know its files (a rerun whose plan saw no commits, or a record from
    // before they were carried). Additivity is the plan's one classification (`nonAdditive`).
    const artifacts = input.migrationArtifacts ?? [];
    const migrateFirst = activates && !nonAdditive && artifacts.length > 0;
    if (migrateFirst && !await migrate()) {
      holdBack();
      return [];
    }
    // Projects deploy side by side: none takes traffic from another's deploy, and where the
    // environment activates, nothing moves until every one has passed. A command that throws
    // fails the deploy only once the others have stopped, since they share this source view.
    const settled = await Promise.allSettled(policy.projects.map(async (project): Promise<DeployProjectOutcome> => {
      input.onProgress(`[deploy ${project.name}] deploying ${commitId.slice(0, 12)} to ${environment}`);
      const result = await step(project.command);
      const url = result.stdout.split("\n").map((line) => line.trim()).findLast((line) => URL_LINE.test(line));
      const failed = failure(result, policy.timeoutMs);
      if (failed) {
        input.onProgress(`[deploy ${project.name}] failed: ${failed}`);
        return { name: project.name, ok: false, reason: failed };
      }
      input.onProgress(`[deploy ${project.name}] deployed${url ? ` ${url}` : ""}`);
      const unhealthy = project.healthCheck ? url ? failure(await step(project.healthCheck, url), policy.timeoutMs) : "printed no deployment URL to check" : null;
      if (unhealthy) {
        input.onProgress(`[deploy ${project.name}] health check failed: ${unhealthy}`);
        return { name: project.name, ok: false, ...(url ? { url } : {}), reason: `health check failed: ${unhealthy}` };
      }
      if (project.healthCheck) input.onProgress(`[deploy ${project.name}] healthy`);
      return { name: project.name, ok: true, ...(url ? { url } : {}) };
    }));
    const thrown = settled.find((result) => result.status === "rejected");
    if (thrown) throw thrown.reason;
    const outcomes = settled.map((result) => (result as PromiseFulfilledResult<DeployProjectOutcome>).value);
    if (!activates) return outcomes;
    for (const outcome of outcomes) outcome.activated = false;
    if (outcomes.some((outcome) => !outcome.ok) || !migrateFirst && !await migrate()) {
      holdBack();
      return outcomes;
    }
    // Until the schema may have changed, earlier code still fits it, so moving back is safe.
    const restore = !nonAdditive || !schemaMayHaveChanged(policy.migrations !== undefined, migrations, earlierSchemaChange);
    for (const [index, project] of policy.projects.entries()) {
      const outcome = outcomes[index]!;
      // Local service recovery follows the runner's migration compatibility decision too.
      const failed = outcome.url ? failure(await step(project.activate!, outcome.url, { SLIPJAY_DEPLOY_ROLLBACK_ALLOWED: restore ? "1" : "0" }), policy.timeoutMs) : "printed no deployment URL to activate";
      if (!failed) {
        outcome.activated = true;
        input.onProgress(`[deploy ${project.name}] activated ${outcome.url}`);
        continue;
      }
      Object.assign(outcome, { ok: false, activated: outcome.url ? "unknown" : false, reason: `activation failed: ${failed}` });
      input.onProgress(`[deploy ${project.name}] activation failed: ${failed}`);
      // A non-zero activation can have moved traffic before it failed. Recover that
      // project too; only a successful restore proves the earlier deployment serves.
      for (const [earlier, moved] of policy.projects.slice(0, index + 1).entries()) {
        const activated = outcomes[earlier]!;
        if (!restore || activated.activated === false) continue;
        const before = previousUrls[moved.name];
        // A deployment that served before may need another call than a first activation (Vercel: rollback, not promote).
        const unrestored = before ? failure(await step(moved.activate!, before, { SLIPJAY_DEPLOY_RESTORE: "1", SLIPJAY_DEPLOY_ROLLBACK_ALLOWED: "1" }), policy.timeoutMs) : "no earlier deployment is recorded";
        // An unsuccessful recovery cannot prove the earlier deployment serves.
        if (unrestored) {
          if (before) activated.activated = "unknown";
          activated.reason = `${activated.reason ? `${activated.reason}; ` : ""}could not be moved back: ${unrestored}`;
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
  return { environment, commitId, previous, changes, projects, ...migrations ? { migrations } : {} };
}
