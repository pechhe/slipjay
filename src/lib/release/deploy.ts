import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { redactMigrationOutput } from "../landing/migration-command-evidence.ts";
import { readExactExecutionPolicy, withFinalizationSource } from "./post-integration-source.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { DeploymentEnvironment, PrebuildCommand } from "../policy/deployment-policy.ts";
import type { FinalizationCommand } from "../policy/post-integration-policy.ts";
import type { DeployMigrations, DeployProjectOutcome, DeployRecord, DeployStepTiming, MachineLease } from "../runner/runner-types.ts";
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
/** What a deploy's commands run with: the declared keys, and which environment and commit they serve. */
function commandEnvironment(policy: DeploymentEnvironment, environment: string, commitId: string, declared: NodeJS.ProcessEnv, previous: string | null = null): NodeJS.ProcessEnv {
  const env = sanitizedProcessEnv();
  for (const key of policy.environmentKeys) if (declared[key] !== undefined) env[key] = declared[key];
  if (previous !== null) env.SLIPJAY_DEPLOY_PREVIOUS = previous;
  return Object.assign(env, { SLIPJAY_DEPLOY_ENVIRONMENT: environment, SLIPJAY_DEPLOY_COMMIT: commitId });
}

/**
 * What a prebuild of one commit came to: `built`; `failed`, the source did not build; or `inconclusive`, it could not
 * build for a reason that is not the source (no machine, a timeout or signal, a declared inconclusive exit code), which
 * says nothing about the commit.
 */
export type PrebuildResult = { status: "built" } | { status: "failed"; reason: string; command: string } | { status: "inconclusive"; reason: string; command: string };

/**
 * Runs production's `prebuild` for `commitId` in a source view of it, on the machine `lease` gives, as its deploy would.
 * The deploy builds whatever this did not.
 */
export async function prebuildRelease(input: {
  gitDirectory: string;
  commitId: string;
  policy: DeploymentEnvironment & { prebuild: PrebuildCommand };
  readEnvironment(): NodeJS.ProcessEnv;
  lease(): Promise<MachineLease>;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  abortSignal: AbortSignal;
}): Promise<PrebuildResult> {
  const { policy, policy: { prebuild } } = input;
  const shown = [prebuild.executable, ...prebuild.args].join(" ");
  try {
    return await withFinalizationSource(input.gitDirectory, input.commitId, async (root) => {
      const lease = await input.lease();
      try {
        const result = await input.run({ executable: prebuild.executable, args: prebuild.args, cwd: path.join(root, prebuild.cwd),
          env: { ...commandEnvironment(policy, "production", input.commitId, input.readEnvironment()), ...lease.env },
          timeoutMs: policy.timeoutMs, maxOutputBytes: 256 * 1024, abortSignal: input.abortSignal });
        const failed = failure(result, policy.timeoutMs);
        if (!failed) return { status: "built" } as const;
        const sourceFailed = !result.timedOut && !result.signal && !result.error && result.exitCode !== null
          && !prebuild.inconclusiveExitCodes?.includes(result.exitCode);
        return sourceFailed ? { status: "failed", reason: failed, command: shown } : { status: "inconclusive", reason: failed, command: shown };
      } finally { await lease.close().catch(() => null); }
    }, sanitizedProcessEnv, input.abortSignal);
  } catch (error) {
    return { status: "inconclusive", reason: `could not run: ${error instanceof Error ? error.message : String(error)}`, command: shown };
  }
}

/** Keep source errors and the retained log, not BuildKit's final process wrapper and stack frames. */
function imageFailure(lines: string[]): string | undefined {
  const summary = /^the \S+ image build failed \(exit \d+\):/i;
  const step = /^#\d+\s+[\d.]+\s+/;
  const cause = /\b(?:error(?: TS\d+)?|\w*Error):|\s->\s/i;
  const pointer = /^the build's plain-progress output is kept at /;
  const clean = lines.map((line) => line.trim());
  const start = clean.findLastIndex((line) => summary.test(line));
  if (start < 0 && !clean.some((line) => step.test(line) && cause.test(line.replace(step, "")))) return undefined;
  const log = clean.findLast((line) => pointer.test(line));
  const kept = clean.filter((line, index) => {
    const body = line.replace(step, "");
    if (/^(?:at\s|Bun v|#\d+\s+ERROR:|ERROR: failed to build\b|error: (?:script )?"[^"]+" exited with code)/.test(body)) return false;
    return (start >= 0 ? index > start : step.test(line)) && cause.test(body);
  });
  const limit = 2000 - (log && log.length < 2000 ? log.length + 1 : 0);
  const detail = [...new Set(start < 0 ? kept : [clean[start]!, ...kept])].join("\n");
  const clipped = detail.length > limit ? detail.slice(0, limit - 1).replace(/\s*\S*$/, "") + "…" : detail;
  return [clipped, log && log.length < 2000 ? log : undefined].filter(Boolean).join("\n") || undefined;
}

export function failure(result: BoundedProcessResult, timeoutMs: number): string | null {
  if (result.exitCode === 0 && !result.timedOut && !result.signal && !result.error) return null;
  const lines = outputLines(result);
  const error = firstError(lines);
  const detail = imageFailure(lines) ?? (error.length ? error.join("\n").slice(0, 600) : (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n").slice(-600));
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
  /** A production deploy no promotion carries: it redeploys the commit production serves, so it leases no machine. */
  redeploy?: boolean;
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
  /** Leases the build machine of `pool` holding the commit, for an environment that names one; absent, its deploy fails. */
  lease?(pool: string): Promise<MachineLease>;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  onProgress(line: string): void;
}): Promise<DeployRecord> {
  const { gitDirectory, environment, commitId, previous, policy, previousUrls = {}, nonAdditive = false, earlierSchemaChange = false } = input;
  // A serving release can outlive its local Git object (for example in a shallow store).
  // List just the candidate when the previous object cannot anchor the range.
  const previousAvailable = previous && previous !== commitId
    ? await git(gitDirectory, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${previous}^{commit}`]).then((resolved) => resolved.trim() === previous, () => false)
    : false;
  const changes = await changesSince(gitDirectory, previousAvailable || previous === commitId ? previous : null, commitId);
  let migrations: DeployMigrations | undefined;
  let machine: DeployRecord["machine"];
  const projects = await withFinalizationSource(gitDirectory, commitId, async (root) => {
    const declared = input.readEnvironment();
    const env = commandEnvironment(policy, environment, commitId, declared, previous);
    // The machine is the environment's for the whole deploy: its migrations may need it as much as its projects.
    // A production redeploy of the commit it serves needs none: whatever the machine built for that commit exists already.
    // A promotion retrying a commit production partly serves still leases, since what failed may need the machine.
    let lease: MachineLease | undefined;
    if (policy.machine && input.redeploy && environment === "production" && commitId === previous) input.onProgress(`[deploy] redeploying ${commitId.slice(0, 12)}, which production serves: no machine leased`);
    else if (policy.machine) {
      if (!input.lease) throw new Error(`deployments ${environment} names machine ${policy.machine}, but this runner has no remote verifier to lease it from`);
      lease = await input.lease(policy.machine);
      Object.assign(env, lease.env);
      input.onProgress(`[deploy] on ${lease.machine.name}`);
    }
    const deploy = async (): Promise<DeployProjectOutcome[]> => {
      const step = (command: FinalizationCommand, url?: string, extra: NodeJS.ProcessEnv = {}, source = { root, env }) => input.run({ executable: command.executable, args: command.args,
        cwd: path.join(source.root, command.cwd), env: { ...source.env, ...url ? { SLIPJAY_DEPLOY_URL: url } : {}, ...extra }, timeoutMs: policy.timeoutMs, maxOutputBytes: 256 * 1024 });
      // Shared steps run once; each project's record references the same interval.
      const timings = policy.projects.map((): NonNullable<DeployProjectOutcome["timings"]> => ({}));
      const timed = async <T>(save: (timing: DeployStepTiming) => void, work: () => Promise<T>, passed: (value: T) => boolean): Promise<T> => {
        const startedAt = new Date().toISOString(), start = performance.now();
        let outcome: DeployStepTiming["outcome"] = "failed";
        try { const value = await work(); outcome = passed(value) ? "passed" : "failed"; return value; }
        finally { save({ startedAt, durationMs: Math.max(0, performance.now() - start), outcome }); }
      };
      const failedStep = async (...args: Parameters<typeof step>) => failure(await step(...args), policy.timeoutMs);
      const projectStep = (index: number, name: "health" | "activate" | "rollback", command: FinalizationCommand, url?: string, extra: NodeJS.ProcessEnv = {}, missing?: string, source?: Parameters<typeof step>[3]) =>
        missing ? Promise.resolve(missing) : timed((timing) => { timings[index]![name] = timing; }, () => failedStep(command, url, extra, source), (reason) => reason === null);
      // Brings the database to the commit and records how; false when it could not.
      const migrateCommands = async (): Promise<boolean> => {
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
      const migrate = () => !policy.migrations ? Promise.resolve(true) : timed((timing) => {
        for (const project of timings) project.migrate = timing;
      }, migrateCommands, (ok) => ok);
      const holdBack = () => input.onProgress(`[deploy] activating nothing: ${environment} keeps serving what it served before`);
      if (policy.preflight) {
        const preflight = policy.preflight;
        input.onProgress(`[deploy] checking preflight for ${environment}`);
        const preflightFailed = await timed((timing) => {
          for (const project of timings) project.preflight = timing;
        }, () => failedStep(preflight), (reason) => reason === null);
        if (preflightFailed) {
          holdBack();
          return policy.projects.map((project, index) => ({ name: project.name, ok: false, activated: false, reason: `preflight failed: ${preflightFailed}`, timings: timings[index] }));
        }
      }
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
        return policy.projects.map((project, index) => ({ name: project.name, ok: false, activated: false, reason: `migrations failed: ${migrations?.reason}`, timings: timings[index] }));
      }
      // Projects deploy side by side: none takes traffic from another's deploy, and where the
      // environment activates, nothing moves until every one has passed. A command that throws
      // fails the deploy only once the others have stopped, since they share this source view.
      const settled = await Promise.allSettled(policy.projects.map(async (project, index): Promise<DeployProjectOutcome> => {
        input.onProgress(`[deploy ${project.name}] deploying ${commitId.slice(0, 12)} to ${environment}`);
        const result = await timed((timing) => { timings[index]!.build = timing; }, () => step(project.command),
          (result) => failure(result, policy.timeoutMs) === null);
        const failed = failure(result, policy.timeoutMs);
        const url = result.stdout.split("\n").map((line) => line.trim()).findLast((line) => URL_LINE.test(line));
        if (failed) {
          input.onProgress(`[deploy ${project.name}] failed: ${failed}`);
          return { name: project.name, ok: false, reason: failed, timings: timings[index] };
        }
        input.onProgress(`[deploy ${project.name}] deployed${url ? ` ${url}` : ""}`);
        const unhealthy = project.healthCheck ? await projectStep(index, "health", project.healthCheck, url, {}, url ? undefined : "printed no deployment URL to check") : null;
        if (unhealthy) {
          input.onProgress(`[deploy ${project.name}] health check failed: ${unhealthy}`);
          return { name: project.name, ok: false, ...(url ? { url } : {}), reason: `health check failed: ${unhealthy}`, timings: timings[index] };
        }
        if (project.healthCheck) input.onProgress(`[deploy ${project.name}] healthy`);
        return { name: project.name, ok: true, ...(url ? { url } : {}), timings: timings[index] };
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
        const failed = await projectStep(index, "activate", project.activate!, outcome.url, { SLIPJAY_DEPLOY_ROLLBACK_ALLOWED: restore ? "1" : "0" }, outcome.url ? undefined : "printed no deployment URL to activate");
        if (!failed) {
          outcome.activated = true;
          input.onProgress(`[deploy ${project.name}] activated ${outcome.url}`);
          continue;
        }
        Object.assign(outcome, { ok: false, activated: outcome.url ? "unknown" : false, reason: `activation failed: ${failed}` });
        input.onProgress(`[deploy ${project.name}] activation failed: ${failed}`);
        // A non-zero activation can have moved traffic before it failed. Recover that
        // project too; only a successful restore proves the earlier deployment serves.
        if (!restore) break;
        const movedProjects = policy.projects.slice(0, index + 1).flatMap((moved, earlier) =>
          outcomes[earlier]!.activated === false ? [] : [{ moved, earlier, before: previousUrls[moved.name] }]);
        const restoreProjects = async (serving?: { root: string; env: NodeJS.ProcessEnv; policy: DeploymentEnvironment }, sourceFailure?: string) => {
          for (const { moved, earlier, before } of movedProjects) {
            const activated = outcomes[earlier]!;
            const previousActivate = serving?.policy.projects.find((project) => project.name === moved.name)?.activate;
            // A deployment that served before may need another call than a first activation (Vercel: rollback, not promote).
            const unrestored = await projectStep(earlier, "rollback", previousActivate ?? moved.activate!, before,
              { SLIPJAY_DEPLOY_RESTORE: "1", SLIPJAY_DEPLOY_ROLLBACK_ALLOWED: "1" }, before ? sourceFailure : "no earlier deployment is recorded",
              previousActivate ? serving : undefined);
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
        };
        if (previous && previousAvailable && movedProjects.some(({ before }) => before)) {
          let restoring = false, restored = false;
          try {
            const exact = await readExactExecutionPolicy(gitDirectory, previous);
            const servingPolicy = exact.configuration?.deployments?.environments[environment];
            if (servingPolicy && movedProjects.some(({ moved, before }) => before && servingPolicy.projects.some(({ name, activate }) => name === moved.name && activate))) {
              const servingEnv = { ...commandEnvironment(servingPolicy, environment, previous, declared, previous), ...lease?.env };
              await withFinalizationSource(exact.gitDirectory, previous, async (servingRoot) => {
                restoring = true;
                await restoreProjects({ root: servingRoot, env: servingEnv, policy: servingPolicy });
                restored = true;
              });
              break;
            }
          } catch (error) {
            if (restored) {
              input.onProgress(`[deploy] rollback source cleanup failed after restoring ${previous.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
              break;
            }
            if (restoring) throw error; // Never retry a restore that may already have moved traffic.
            input.onProgress(`[deploy] could not prepare previous release ${previous.slice(0, 12)} for rollback (${error instanceof Error ? error.message : String(error)}); falling back to candidate source`);
          }
        }
        await restoreProjects();
        break;
      }
      return outcomes;
    };
    try { return await deploy(); } finally {
      if (lease) {
        machine = { ...lease.machine, billed: await lease.close().catch(() => null) };
        if (machine.billed) input.onProgress(`[deploy] ${machine.name} billed ${Math.round(machine.billed.seconds)} s ($${machine.billed.dollars.toFixed(4)})`);
      }
    }
  });
  return { environment, commitId, previous, changes, projects, ...migrations ? { migrations } : {}, ...machine ? { machine } : {} };
}
