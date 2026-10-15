import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { stat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { integrateLandingCandidate, prepareLandingCandidate, rollbackFailure, verifyPreparedCandidate, integratePreparedCandidate } from "./landing-candidate.ts";
import type { PreparedLandingCandidate } from "./landing-candidate.ts";
import { importSubmissionSource } from "./submission-source.ts";
import { duplicateLandingSource, retainLandingSource, retainLandingArtifact, importLandingArtifact, RETAINED_ARTIFACT_REVISIONS } from "./landing-artifact.ts";
import type { LandingArtifact } from "./landing-artifact.ts";
import { completeLanding, fetchIntegration, landingIO } from "./landing-steps.ts";
import { createDeployScheduler } from "./deploy-scheduler.ts";
import { createResetScheduler } from "./reset-scheduler.ts";
import { runReset } from "./reset.ts";
import { ensureDeployCommit, ensureOnIntegrationBranch, runDeploy, schemaMayHaveChanged } from "./deploy.ts";
import { readExactExecutionPolicy } from "./post-integration-source.ts";
import { confirmRelease, returnRelease } from "./release.ts";
import { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
import { admissionLane, KILLABLE_STAGES, OWNER_KILL_REASON, RUNNER_CONTROL_ID, RUNNER_DEFAULT_LIMITS, RUNNER_DEFAULT_WORKERS, RUNNER_SLICE, SYSTEMD_SLICE_ENV, repositoryKey, repositoryLane, RUNNER_JJ_DEFAULTS, servedDeploy } from "./runner-contract.ts";
import { newOperationId } from "./runner-log.ts";
import { parseFailureOutput } from "./failure-classification.ts";
import { commandEvidence } from "./command-evidence.ts";
import { retainCommandArtifact } from "./command-artifact.ts";
import { redactVerificationOutput } from "./verification-failure.ts";
import { redactMigrationOutput } from "./migration-command-evidence.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { CompletedRelease, DeployOperation, DeployRecord, Executor, KillOutcome, PromotionFacts, LandingOperation, Operation, OperationEvent, OperationLog, RunnerConfig, RunnerLimits, RunnerStage, ReleaseOperation, ResetOperation, RunPurpose } from "./runner-contract.ts";

const configuredRepository = (config: RunnerConfig, repo: string) =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1];
import { jj, run as workspaceRun, revisionExists, revisionFacts, workspaceContext } from "./workspace-jj.ts";

/**
 * An integration the runner could not finalize or publish. It stays on the runner's
 * integration branch, because the external target may already reflect it, and every
 * later turn retries it first; nothing else lands until it is published.
 */
class HeldIntegration extends Error {
  constructor(readonly commitId: string, readonly stage: "finalizing" | "publishing", reason: string, readonly output?: string) {
    super(`${reason}\nThe runner holds ${commitId.slice(0, 12)}, integrated but not published, and retries it before the next landing.`);
  }
}

/** The owner's kill reached the operation; it ends cancelled, never passed. */
class OwnerKill extends Error {
  constructor() { super(OWNER_KILL_REASON); }
}

/** A verified attempt lost its authoritative remote parent before integration. */
class PrefixInvalidated extends Error {}

/** Where a runner keeps commands and their budget: see `localExecutor`. */
export type LocalExecutorOptions = {
  host?: string; env?: NodeJS.ProcessEnv; limits?: RunnerLimits;
  /**
   * The runner home that owns the commands. A later process with the same home stops whatever an
   * earlier one left running (`recover`); without one, nothing outlives this process's knowledge.
   */
  home?: string;
  /** The systemd slice whose `limits` bound every run (RUNNER_SLICE); tests use a disposable one. */
  slice?: string;
};

/**
 * Runs commands on this host. Each run's process group is killed on abort or
 * timeout, but a gate's own tools may start further groups (setsid) or systemd
 * scopes that a group signal never reaches. Under a systemd user manager each
 * run therefore gets a slice of its own beneath its owner's slice, its command
 * runs in a scope there, and killing the slice kills everything in it, on abort
 * and after every run. Commands learn their slice from SYSTEMD_SLICE_ENV; a
 * command that starts its own systemd user scope passes it as `--slice`, so the
 * scope stays inside the run and its limits. The owner's slice is named from
 * `home`, so a later process of the same runner can stop whatever an earlier one
 * left running (`recover`) without touching other units. Every slice sits beneath
 * `slice`, whose `limits` bound all runs together: the workers' gates, deploys and
 * every process they start, however they nest. Memory beyond `memoryHigh` is
 * throttled; `memoryMax` is the hard ceiling. A run that is itself a SlipJay
 * command nests beneath its own slice instead, inside the limits already set
 * above it.
 *
 * Elsewhere there is no combined budget, so the executor runs one command at a
 * time, kills the command's process group after it, and records the group under
 * `home` while it runs so `recover` can stop it after a crash. Tools that leave
 * the group are out of reach there.
 *
 * Either way, a run whose processes cannot be shown stopped makes every later run
 * fail until they are, so nothing reuses a checkout they may still hold.
 */
export function localExecutor({ host = hostname(), env = process.env, limits = {}, home, slice: budget = RUNNER_SLICE }: LocalExecutorOptions = {}): Executor {
  const runtimeDir = process.platform === "linux" ? env.XDG_RUNTIME_DIR : undefined;
  const { settled, contained } = runContainment();
  if (!runtimeDir) return groupExecutor(host, home, { settled, contained });
  const systemctl = (args: string[]) => new Promise<{ failure: string | null; stdout: string }>((resolve) =>
    execFile("systemctl", ["--user", ...args], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } }, (error, stdout, stderr) =>
      resolve({ failure: error ? (stderr.trim() || error.message) : null, stdout: stdout.trim() })));
  const parent = env[SYSTEMD_SLICE_ENV];
  const nested = parent !== undefined && /^[0-9a-z]+(?:-[0-9a-z]+)*\.slice$/.test(parent);
  const ownerSlice = `${(nested ? parent : budget).slice(0, -".slice".length)}-${createHash("sha256").update(home ?? randomUUID()).digest("hex").slice(0, 12)}.slice`;
  /** Kill everything in `slice` and its children, then wait for systemd to stop them. */
  const quiesce = async (slice: string) => {
    await systemctl(["kill", "--signal=SIGKILL", slice]);
    await systemctl(["stop", slice]);
    const { failure, stdout } = await systemctl(["show", "--property=ActiveState", "--value", slice]);
    return failure ?? (stdout === "inactive" ? null : `${slice} is ${stdout}`);
  };
  const { memoryHigh, memoryMax, cpuQuota, tasksMax } = { ...RUNNER_DEFAULT_LIMITS, ...limits };
  // Runtime properties: they last until the user manager restarts, and each runner start sets them again.
  // Refuse execution if the shared budget cannot be enforced; never run uncapped.
  let sliced: Promise<void> | undefined;
  const enforce = () => sliced ??= (nested ? Promise.resolve({ failure: null }) : systemctl(["set-property", "--runtime", budget,
    `MemoryHigh=${memoryHigh}`, `MemoryMax=${memoryMax}`, `CPUQuota=${cpuQuota}`, `TasksMax=${tasksMax}`])).then(({ failure }) => {
    if (failure === null) return;
    sliced = undefined;
    throw new Error(`SlipJay runner: could not enforce the limits of ${budget}: ${failure}`);
  });
  return {
    host,
    combinedLimits: true,
    ...home === undefined ? {} : { async recover() {
      const failure = await quiesce(ownerSlice);
      if (failure) throw new Error(`SlipJay runner: could not stop the commands an earlier runner left in ${ownerSlice}: ${failure}`);
    } },
    async run(request) {
      await enforce();
      await settled();
      const id = randomUUID().replaceAll("-", "");
      const runSlice = `${ownerSlice.slice(0, -".slice".length)}-${id}.slice`;
      const stop = () => { void quiesce(runSlice); };
      request.abortSignal?.addEventListener("abort", stop, { once: true });
      return contained(runSlice, () => runBoundedProcess({
        ...request, executable: "systemd-run",
        args: ["--user", "--scope", "--quiet", "--collect", `--slice=${runSlice}`, `--unit=slipjay-run-${id}.scope`, "--", request.executable, ...request.args],
        env: { ...request.env ?? sanitizedProcessEnv(), XDG_RUNTIME_DIR: runtimeDir, [SYSTEMD_SLICE_ENV]: runSlice },
      }).finally(() => request.abortSignal?.removeEventListener("abort", stop)), () => quiesce(runSlice));
    },
  };
}

/**
 * Fences runs whose processes could not be shown stopped. `contained` runs `work`, then `stop`;
 * when `stop` reports a failure the run rejects and is remembered, and `settled`, which every run
 * awaits first, retries it and rejects until it succeeds.
 */
export function runContainment() {
  const unstopped = new Map<string, () => Promise<string | null>>();
  return {
    async settled() {
      for (const [name, retry] of unstopped) {
        const failure = await retry();
        if (failure) throw new Error(`SlipJay runner: the processes of an earlier run (${name}) could not be stopped: ${failure}`);
        unstopped.delete(name);
      }
    },
    async contained<T>(name: string, work: () => Promise<T>, stop: () => Promise<string | null>): Promise<T> {
      let result: T;
      try { result = await work(); } finally {
        const failure = await stop();
        if (failure) unstopped.set(name, stop);
      }
      if (unstopped.has(name)) throw new Error(`SlipJay runner: could not stop the processes of ${name}: the next run waits until they stop`);
      return result;
    },
  };
}

/** A process group's leader start time as `ps` reports it, or null once the leader is gone. */
const processStart = (pid: number): string | null => {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
};
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
/** SIGKILL a process group and wait for it to be gone; the failure, or null. */
async function stopGroup(pid: number): Promise<string | null> {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  for (let waited = 0; groupAlive(pid); waited += 50) {
    if (waited >= 10_000) return `process group ${pid} survived SIGKILL`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** The executor without a systemd user manager: see `localExecutor`. */
function groupExecutor(host: string, home: string | undefined, { settled, contained }: ReturnType<typeof runContainment>): Executor {
  const records = home === undefined ? undefined : join(home, "commands");
  let turn: Promise<unknown> = Promise.resolve();
  return {
    host,
    ...records === undefined ? {} : { async recover() {
      const left = await readdir(records).catch(() => [] as string[]);
      for (const name of left) {
        const file = join(records, name);
        const recorded = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as { pid: number; started: string | null } | null;
        // A leader that is alive with another start time is a reused pid, not ours.
        const current = recorded && processStart(recorded.pid);
        if (recorded && groupAlive(recorded.pid) && (current === null || current === recorded.started)) {
          const failure = await stopGroup(recorded.pid);
          if (failure) throw new Error(`SlipJay runner: could not stop the command an earlier runner left: ${failure}`);
        }
        await rm(file, { force: true });
      }
    } },
    run(request) {
      const run = turn.then(async () => {
        await settled();
        const id = randomUUID();
        let pid: number | undefined;
        const record = records && join(records, `${id}.json`);
        if (records) await mkdir(records, { recursive: true });
        return contained(`command ${id}`, () => runBoundedProcess({ ...request, onSpawn: (spawned) => {
          pid = spawned;
          if (record) writeFileSync(record, JSON.stringify({ pid, started: processStart(pid) }));
          request.onSpawn?.(spawned);
        } }), async () => {
          const failure = pid === undefined ? null : await stopGroup(pid);
          if (!failure && record) await rm(record, { force: true });
          return failure;
        });
      });
      turn = run.catch(() => {});
      return run;
    },
  };
}

/**
 * How many operations run at once: the config's `workers`, or RUNNER_DEFAULT_WORKERS. Without
 * enforced combined limits concurrent runs would share no budget, so such an executor runs one
 * at a time and refuses a config that asks for more.
 */
export function runnerWorkers(config: Pick<RunnerConfig, "workers">, executor: Pick<Executor, "combinedLimits">): number {
  if (executor.combinedLimits) return Math.max(1, Math.floor(config.workers ?? RUNNER_DEFAULT_WORKERS));
  if ((config.workers ?? 1) > 1) throw new Error(`${config.workers} workers require an executor with enforced combined resource limits (a systemd user manager); this host has none, so it runs one command at a time`);
  return 1;
}

/**
 * Each repository has one serial lane that owns its warm checkout and every transition
 * of its integration and release branches: its landings, resets of the target landings
 * finalize against, and the publication of its releases take turns in arrival order.
 * A release verifies its pinned candidate first, in a release lane with a checkout of
 * its own, beside the repository's landings (but never beside its reset, nor in a shared
 * lane: see `admissionLane`), and joins the repository lane only to publish. Different repositories share no checkout, branch, target or environment, so
 * their lanes run at once. At most `workers` operations run at once, a release counting
 * as one until it has published; an operation waiting for a worker is admitted oldest
 * first. Deploys take turns in a separate lane that only reads the warm store, so a
 * deploy that waits minutes on its build never holds a landing.
 */
export function createRunnerQueue(input: {
  log: OperationLog; executor: Executor; home: string; config: RunnerConfig;
  environment?: () => NodeJS.ProcessEnv;
}): {
  wake(): void; recover(): Promise<void>; idle(): Promise<void>;
  /** Delete the remote candidate of a landing cancelled while queued, after the running turn. */
  cancelled(operation: Operation): void;
  /** Stop scheduling deploys and resets: clears timers that are waiting for an interval. */
  close(): void;
  /**
   * Kill a running landing, release or reset while it is in KILLABLE_STAGES: the named one, or,
   * unnamed, the only one running. An unnamed kill with several running kills none.
   */
  kill(operationId?: string): KillOutcome;
  logPath(operationId: string): string; readLog(operationId: string): Promise<string | null>;
} {
  const { log, executor, home, config, environment } = input;
  if (Object.values(config.repos).some((repo) => repo.verificationDepth === 2) && !executor.combinedLimits)
    throw new Error("Depth-two verification requires an executor with enforced combined resource limits");
  const workers = runnerWorkers(config, executor);
  /** Each lane's work holding its checkouts now, and any chained behind it, by `admissionLane`. */
  const lanes = new Map<string, Promise<void>>();
  const laneOf = (repo: string) => repositoryLane(config, repo);
  /** Worker reservations, including operations whose lane callback has not started yet. */
  const admitted = new Map<string, Operation>();
  // Queue-owned runtime attempts; their immutable evidence lives in the existing log.
  type PreparedPrefix = { artifact: LandingArtifact; checkout: string; overlap: boolean };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  type PrefixTurn = { operation: LandingOperation; slot: number; attempt: number; prepared: ReturnType<typeof deferred<PreparedPrefix | null>>;
    completed: ReturnType<typeof deferred<boolean>>; invalidation: AbortController; predecessor?: PrefixTurn; remoteRebuilt?: boolean };
  const prefixes = new Map<string, PrefixTurn[]>();
  const attempts = new Set<Promise<void>>();
  /** Running landings, releases and resets, by operation, in their current stage. */
  const running = new Map<string, { operation: Operation; stage: RunnerStage; controller: AbortController }>();
  /** Recovery holds every lane: nothing is admitted until it finishes. */
  let recovering: Promise<void> | undefined;
  const logPath = (id: string) => join(home, "logs", `${id}.log`);
  function append(id: string, event: OperationEvent): void {
    log.append(id, event);
  }
  function runFinished(runId: string, result: BoundedProcessResult, started: number, request: BoundedProcessRequest, privateOutput = false): Extract<OperationEvent, { type: "run_finished" }> {
    return { type: "run_finished", runId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      durationMs: Date.now() - started, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      killed: result.cancelled, ...(privateOutput ? {} : { diagnosticCapture: result.diagnosticOutput ? result.diagnosticOutput.incomplete ? "incomplete" : "selected" : "unavailable",
        ...parseFailureOutput(redactMigrationOutput(
        `${result.diagnosticOutput?.stdout ?? ""}\n${result.diagnosticOutput?.stderr ?? ""}\n${result.stdout}\n${result.stderr}`, request.cwd, request.env)) }) };
  }
  const repoCheckout = (repo: string) => join(home, "repos", repo);
  const checkoutPath = (operation: Operation) => operation.kind === "release" ? join(home, "releases", operation.repo) : repoCheckout(operation.repo);
  /**
   * The temporary directory of every gate command run in `checkout`, emptied at each turn.
   * It isolates a checkout's temporary state from other operations', including any lock a
   * gate keeps there: the runner's own limits bound concurrent runs together.
   */
  const scratchOf = (checkout: string) => join(tmpdir(), `slipjay-${createHash("sha256").update(checkout).digest("hex").slice(0, 12)}`);
  /** The published integration of an earlier submission of this exact commit, if any. */
  async function publishedIntegration(checkout: string, operation: LandingOperation, branch: string, remote: string): Promise<{ base: string; commitId: string } | null> {
    for (const earlier of log.operationsForChange(operation.repo, operation.changeId)) {
      if (earlier.id === operation.id || earlier.commitId !== operation.commitId) continue;
      const integrated = log.events({ operationId: earlier.id }).map((stored) => stored.event).findLast((event) => event.type === "integrated");
      if (integrated && await revisionExists(checkout, `${integrated.commitId} & ::${branch}@${remote}`))
        return { base: integrated.base, commitId: integrated.commitId };
    }
    return null;
  }
  async function cleanup(operation: LandingOperation, checkout: string, remote: string): Promise<void> {
    try {
      // A candidate this checkout never fetched (cancelled while queued, or interrupted by a
      // restart) has no local bookmark to delete until it is fetched.
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", operation.bookmark]).catch(() => {});
      await jj(checkout, ["bookmark", "track", `${operation.bookmark}@${remote}`]).catch(() => {});
      await jj(checkout, ["bookmark", "delete", operation.bookmark]);
      await jj(checkout, ["git", "push", "--remote", remote, "--bookmark", operation.bookmark]);
    } catch (error) {
      // Leave no half-deleted bookmark behind: a resubmission fetches the candidate afresh.
      await jj(checkout, ["bookmark", "forget", "--include-remotes", operation.bookmark]).catch(() => {});
      append(operation.id, { type: "progress", line: `Candidate bookmark cleanup failed: ${message(error)}` });
    }
  }
  /** Ask the schedulers about every environment and the reset the commit declares; they decide whether one is due. */
  async function schedule(repo: string, commitId: string): Promise<void> {
    const { configuration } = await readExactExecutionPolicy(join(repoCheckout(repo), ".git"), commitId);
    if (configuration?.deployments) scheduler.consider(repo, configuration.deployments.environments);
    resetScheduler.consider(repo, configuration?.reset ?? null);
  }
  /** Re-ask the schedulers with the policy of the repository's last landed commit, if it has one. */
  async function scheduleLatest(repo: string, progress: (line: string) => void = () => {}): Promise<void> {
    const landed = log.lastLanded(repo);
    if (landed) await schedule(repo, landed.commitId).catch((error: unknown) => progress(`Could not schedule deploys and resets: ${message(error)}`));
  }
  const resetScheduler = createResetScheduler({
    log,
    submit(repo) {
      const landed = log.lastLanded(repo);
      if (!landed) return;
      log.append(newOperationId(), { type: "submitted", kind: "reset", repo, commitId: landed.commitId, submittedBy: `${executor.host}:schedule` });
      wakeMain();
    },
  });
  const scheduler = createDeployScheduler({
    log,
    submit(repo, environment, commitId) {
      log.append(newOperationId(), { type: "submitted", kind: "deploy", repo, environment, commitId, submittedBy: `${executor.host}:schedule` });
      wakeDeploys();
    },
  });
  let deploying: Promise<void> = Promise.resolve();
  let deployPending = false;
  function wakeDeploys(): void {
    if (deployPending) return;
    deployPending = true;
    deploying = deploying.then(() => { deployPending = false; return deployLoop(); });
  }
  async function deployLoop(): Promise<void> {
    for (;;) {
      if (log.paused()) return;
      const operation = log.openOperations().find((entry): entry is DeployOperation => entry.kind === "deploy" && entry.status === "queued");
      if (!operation) return;
      await processDeploy(operation);
    }
  }
  async function processDeploy(operation: DeployOperation): Promise<void> {
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    let verdict: OperationEvent;
    append(operation.id, { type: "stage", stage: "deploying" });
    try {
      const repository = configuredRepository(config, operation.repo);
      if (!repository) throw new Error(`Repository ${operation.repo} is not configured on this runner`);
      const gitDirectory = join(checkoutPath(operation), ".git");
      if (!await stat(gitDirectory).then(() => true, () => false))
        throw new Error(`The runner has no checkout of ${operation.repo} yet; it makes one at its first landing`);
      await ensureDeployCommit(gitDirectory, repository.url, operation.commitId);
      const exact = await readExactExecutionPolicy(gitDirectory, operation.commitId);
      // The branch comes from the last commit this runner landed, not from the commit asking to deploy.
      const landed = log.lastLanded(operation.repo);
      const branch = (landed ? (await readExactExecutionPolicy(gitDirectory, landed.commitId)).configuration : exact.configuration)?.integrationBranch;
      if (!branch) throw new Error(`${operation.repo} declares no integrationBranch to deploy from`);
      await ensureOnIntegrationBranch(gitDirectory, repository.url, branch, operation.commitId);
      const policy = exact.configuration?.deployments?.environments[operation.environment];
      if (!policy) throw new Error(`${operation.commitId.slice(0, 12)} declares no ${operation.environment} deployment`);
      // The environment served a commit once any of its projects served it.
      const earlier = log.deployments(operation.repo, operation.environment).filter((entry) => entry.id !== operation.id).map((entry) => ({ entry, record: recordOf(entry) }));
      const previous = earlier.find(({ record }) => record?.projects.some(servedDeploy))?.entry.commitId ?? null;
      const previousUrls = Object.fromEntries(policy.projects.flatMap(({ name }) => {
        const url = earlier.flatMap(({ record }) => record?.projects ?? []).find((project) => project.name === name && servedDeploy(project))?.url;
        return url ? [[name, url]] : [];
      }));
      const manual = operation.promotion?.nonAdditiveMigrations ?? [];
      // A closed deploy of this commit with no record (a restart or crash cut it short) may have applied them too: nothing says it did not.
      const earlierSchemaChange = earlier.some(({ entry, record }) => entry.commitId === operation.commitId && entry.result
        && (!record || record.migrations?.status === "applied" || record.migrations?.status === "apply_failed"));
      const record = await runDeploy({
        gitDirectory: exact.gitDirectory, environment: operation.environment, commitId: operation.commitId, previous, policy,
        previousUrls, nonAdditive: manual.length > 0, earlierSchemaChange, migrationArtifacts: operation.promotion?.migrationArtifacts ?? [],
        readEnvironment: environment ?? (() => process.env), onProgress: progress,
        run: async (request) => {
          const runId = randomUUID();
          const started = Date.now();
          const context = commandEvidence(request, checkoutPath(operation));
          append(operation.id, { type: "run_started", runId, command: context.status === "recorded" ? [context.executable, ...context.args].join(" ") : "command context unavailable (capacity)", host: executor.host, timeoutMs: request.timeoutMs, purpose: "deploy", commandEvidence: context });
          const result = await executor.run(request).catch((error: unknown) => {
            append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started, artifact: { status: "unavailable", reason: "capture-failed" } });
            throw error;
          });
          append(operation.id, { ...runFinished(runId, result, started, request), artifact: await retainCommandArtifact({ home, operationId: operation.id, runId, request, result, privateOutput: true }) });
          return result;
        },
      });
      const failed = [...record.migrations?.reason ? [{ name: "migrations", reason: record.migrations.reason }] : [],
        ...record.projects.filter((project) => !project.ok)];
      if (failed.length && operation.promotion) record.rollback = await rollBack(operation, operation.promotion, record, policy.migrations !== undefined, earlierSchemaChange);
      verdict = failed.length
        ? { type: "failed", stage: "deploying", deployment: record,
          reason: `deploy failed: ${failed.map((project) => `${project.name} (${project.reason})`).join(", ")}${record.rollback ? `; ${record.rollback.reason}` : ""}` }
        : { type: "deployed", record };
    } catch (error) {
      verdict = { type: "failed", stage: "deploying", reason: message(error) };
    }
    append(operation.id, verdict);
    // Landings that arrived while this deploy ran were told to wait for it; a deploy that
    // never reached its projects is retried once the interval passes.
    await scheduleLatest(operation.repo, progress);
  }
  /**
   * After a promotion's production deploy failed: production already serves what it
   * served before (nothing activated, or moved back), so return the release branch to
   * match, in the serial lane that owns branch moves. A promotion whose non-additive
   * migrations may have changed the schema, or whose migrations failed part-way, is
   * left as it is: the code before it may not run on the migrated schema.
   */
  async function rollBack(operation: DeployOperation, { merge, nonAdditiveMigrations: manual }: PromotionFacts, record: DeployRecord, declaresMigrations: boolean, earlierSchemaChange: boolean): Promise<NonNullable<DeployRecord["rollback"]>> {
    if (record.migrations?.status === "apply_failed") return { automatic: false,
      reason: "not rolled back automatically, because applying the migrations failed and the database may be partly migrated: the owner decides" };
    // A deploy that stopped before the migrations, or whose first verify refused, changed no schema (and no earlier deploy of the commit did): the code before the promotion still fits.
    if (manual.length && schemaMayHaveChanged(declaresMigrations, record.migrations, earlierSchemaChange)) return { automatic: false,
      reason: `not rolled back automatically, because the promotion carries non-additive migrations (${manual.join(", ")}): the owner decides` };
    const unrecovered = record.projects.filter((project) => project.activated);
    if (unrecovered.length) return { automatic: false,
      reason: `rollback incomplete: ${unrecovered.map((project) => project.activated === "unknown"
        ? `${project.name} activation or recovery outcome is unknown (${project.reason ?? "no earlier deployment"})`
        : `${project.name} still serves the promotion (${project.reason ?? "no earlier deployment"})`).join(", ")}; the release branch stays on the release` };
    const returned = await serially(operation.repo, () => returnRelease(repoCheckout(operation.repo), { merge, candidate: operation.commitId }));
    return returned.returned
      ? { automatic: true, releaseBranch: returned.releaseBranch, reason: `rolled back: production serves what it served before, and the release branch is back on ${returned.releaseBranch.slice(0, 12)}` }
      : { automatic: false, reason: `rollback incomplete: production serves what it served before, but the release branch still holds the release: ${returned.reason}` };
  }
  /** Run `work` in the repository's lane, after its running turn, and resume the queue after it. */
  function serially<T>(repo: string, work: () => Promise<T>): Promise<T> {
    let value: T;
    const pending = inLane(laneOf(repo), async () => { value = await work(); });
    // Submissions that woke the queue while `work` held the lane are taken up after it.
    pending.then(wakeMain, wakeMain);
    return pending.then(() => value);
  }
  /**
   * The production deploy of a promoted commit: an open or finished deploy of it, or a
   * new one carrying what undoing it needs. A rerun confirm of a promotion whose deploy
   * failed deploys it again.
   */
  function productionDeploy(promotion: ReleaseOperation, result: CompletedRelease): string {
    const existing = log.deployments(promotion.repo, "production").find((entry) => entry.commitId === promotion.commitId
      && (entry.status === "queued" || entry.status === "running" || entry.status === "deployed"));
    if (existing) return existing.id;
    // A rerun confirm of a candidate the release branch already holds plans no commits, so
    // the facts come from the deploy that first carried them.
    const shipped = result.status === "released_by"
      ? log.deployments(promotion.repo, "production").find((entry) => entry.commitId === promotion.commitId && entry.promotion)?.promotion : undefined;
    const id = newOperationId();
    log.append(id, { type: "submitted", kind: "deploy", repo: promotion.repo, environment: "production", commitId: promotion.commitId,
      submittedBy: `promotion:${promotion.id}`, promotion: shipped ?? { merge: result.merge, nonAdditiveMigrations: result.nonAdditiveMigrations, migrationArtifacts: result.migrationArtifacts } });
    return id;
  }
  /**
   * Admit queued landings, releases and resets, oldest first, while a worker is free: each
   * to its lane once that lane is idle, so a lane's operations keep their order. A pause
   * admits nothing new; running operations finish.
   */
  function wakeMain(): void {
    if (recovering || log.paused()) return;
    for (const operation of log.openOperations()) {
      if (admitted.size >= workers) return;
      if (operation.kind === "deploy" || operation.status !== "queued" || (operation.kind === "landing" && operation.admission === "pending")) continue;
      const lane = admissionLane(laneOf(operation.repo), operation.repo, operation.kind);
      const active = prefixes.get(operation.repo) ?? [];
      const depth = configuredRepository(config, operation.repo)?.verificationDepth ?? 1;
      if (operation.kind === "landing" && depth === 2 && laneOf(operation.repo) === operation.repo && executor.combinedLimits) {
        if (active.length >= 2 || lanes.has(lane) || resetConflict(operation)) continue;
        // A queued reset/release is an arrival-order fence, even while no lane is held.
        const before = log.openOperations(operation.repo).slice(0, log.openOperations(operation.repo).findIndex((entry) => entry.id === operation.id));
        if (before.some((entry) => entry.kind !== "landing" && entry.kind !== "deploy")) continue;
        const turn: PrefixTurn = { operation, attempt: 1, slot: active.some((entry) => entry.slot === 0) ? 1 : 0,
          prepared: deferred(), completed: deferred(), invalidation: new AbortController(), predecessor: active.at(-1) };
        prefixes.set(operation.repo, [...active, turn]);
        admitted.set(operation.id, operation);
        const pending = processOperation(operation, turn).finally(() => {
          turn.prepared.resolve(null);
          turn.completed.resolve(log.operation(operation.id)?.status === "landed");
          prefixes.set(operation.repo, (prefixes.get(operation.repo) ?? []).filter((entry) => entry !== turn));
          admitted.delete(operation.id); attempts.delete(pending); wakeMain();
        });
        attempts.add(pending);
        continue;
      }
      if (active.length || lanes.has(lane) || resetConflict(operation)) continue;
      admitted.set(operation.id, operation);
      void inLane(lane, () => processOperation(operation))
        .finally(() => { admitted.delete(operation.id); wakeMain(); });
    }
  }
  /**
   * A reset rewrites the external state a release may verify against, so a release
   * verifying beside its repository lane and a reset of that repository never overlap.
   */
  function resetConflict(operation: Operation): boolean {
    if (operation.kind === "reset" && (prefixes.get(operation.repo)?.length ?? 0) > 0) return true;
    if (operation.kind === "reset") return lanes.has(admissionLane(laneOf(operation.repo), operation.repo, "release"));
    return operation.kind === "release"
      && [...admitted.values()].some((entry) => entry.kind === "reset" && laneOf(entry.repo) === laneOf(operation.repo));
  }
  async function processOperation(operation: LandingOperation | ReleaseOperation | ResetOperation, prefix?: PrefixTurn): Promise<void> {
    let stage: RunnerStage = "queued";
    let stageStarted = Date.now();
    let installSource: "fresh" | "existing" | undefined;
    let rebaseConflict = false;
    let conflictFiles: string[] = [];
    const stageDetail = (): OperationEvent => ({ type: "stage_detail", stage, durationMs: Date.now() - stageStarted,
      ...(stage === "installing" ? { installSource } : {}), ...(stage === "rebasing" ? { conflict: rebaseConflict, files: conflictFiles } : {}) });
    const controller = new AbortController();
    running.set(operation.id, { operation, stage, controller });
    let verdict: OperationEvent | undefined;
    let retryPrefix = false;
    const checkout = prefix ? join(home, "verifiers", operation.repo, String(prefix.slot)) : checkoutPath(operation);
    const scratch = scratchOf(checkout);
    let remote: string | undefined;
    let integrationBranch: string | undefined;
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    async function withAuthority<T>(pending: Promise<T>): Promise<T> {
      const signal = AbortSignal.any([controller.signal, ...prefix ? [prefix.invalidation.signal] : []]);
      const fail = () => controller.signal.aborted ? new OwnerKill() : new Error("Exact predecessor invalidated this attempt");
      if (signal.aborted) throw fail();
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => { aborted = () => reject(fail()); signal.addEventListener("abort", aborted, { once: true }); });
      try { return await Promise.race([pending, cancellation]); }
      finally { signal.removeEventListener("abort", aborted); }
    }
    // Gate and migration commands both go through the executor, so each run records where it ran.
    async function run(request: BoundedProcessRequest, purpose?: RunPurpose): Promise<BoundedProcessResult> {
      const runId = randomUUID();
      const started = Date.now();
      const context = commandEvidence(request, checkout);
      append(operation.id, { type: "run_started", runId, command: context.status === "recorded" ? [context.executable, ...context.args].join(" ") : "command context unavailable (capacity)", host: executor.host, timeoutMs: request.timeoutMs,
        purpose: purpose ?? (stage === "resetting" ? "reset" : stage === "finalizing" ? "finalization" : stage === "installing" ? "dependencies" : "gate"), ...(prefix ? { attempt: prefix.attempt } : {}), commandEvidence: context });
      const abortSignal = AbortSignal.any([controller.signal, ...prefix ? [prefix.invalidation.signal] : [], ...request.abortSignal ? [request.abortSignal] : []]);
      const privateRun = stage === "resetting" || stage === "finalizing";
      const runEnvironment = privateRun ? request.env : { ...sanitizedProcessEnv(request.env), TMPDIR: scratch };
      if ((purpose === "migration_generate" || purpose === "migration_verify") && request.env?.SLIPJAY_MIGRATION_CONTEXT)
        runEnvironment!.SLIPJAY_MIGRATION_CONTEXT = request.env.SLIPJAY_MIGRATION_CONTEXT;
      const result = await executor.run({ ...request, env: runEnvironment,
        redactOutput: privateRun ? request.redactOutput : (value) => redactVerificationOutput(value, checkout), abortSignal }).catch((error: unknown) => {
        append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started, artifact: { status: "unavailable", reason: "capture-failed" } });
        throw error;
      });
      const finished = runFinished(runId, result, started, request, privateRun);
      finished.artifact = await retainCommandArtifact({ home, operationId: operation.id, runId, request, result, privateOutput: privateRun });
      append(operation.id, finished);
      return result;
    }
    // Finalization, then publication, of an integrated commit (completeLanding).
    async function finishIntegration(context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>, commitId: string, publisher = checkout, expectedBase?: string): Promise<void> {
      setStage("finalizing");
      const tail = await completeLanding(publisher, context, commitId, { ...(environment ? { environment } : {}), expectedBase, runCommand: run, onPublishing: () => setStage("publishing") })
        .catch((error: unknown) => { throw new HeldIntegration(commitId, stage === "publishing" ? "publishing" : "finalizing", message(error)); });
      if (tail.timings) {
        const { finalizingStartedAt, publishingStartedAt, finishedAt } = tail.timings;
        append(operation.id, { type: "stage_detail", stage: "finalizing", durationMs: 0, migrateDurationMs: Math.max(0, (publishingStartedAt ?? finishedAt) - finalizingStartedAt) });
        if (publishingStartedAt !== undefined) append(operation.id, { type: "stage_detail", stage: "publishing", durationMs: 0, pushDurationMs: Math.max(0, finishedAt - publishingStartedAt), remoteMoved: !tail.publication.ok && /remote.*(?:mov|chang|refus)|(?:mov|chang).*remote/i.test(tail.publication.reason ?? "") });
      }
      if (!tail.postIntegration.ok)
        throw new HeldIntegration(commitId, "finalizing", `Post-integration ${tail.postIntegration.status}: ${tail.postIntegration.reason ?? "no reason recorded"}`, tail.postIntegration.output);
      if (!tail.publication.ok) throw new HeldIntegration(commitId, "publishing", tail.publication.reason ?? "Integration publication failed");
      if (log.snapshot(executor.host).held.some((entry) => entry.repo === operation.repo && entry.commitId === commitId))
        append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId, retried: true });
    }
    const setStage = (next: RunnerStage) => {
      // A kill that landed between runs stops the operation before it moves a branch.
      if (controller.signal.aborted) throw new OwnerKill();
      if (prefix?.invalidation.signal.aborted) throw new Error("Prepared prefix invalidated by its predecessor");
      if (stage !== "queued") append(operation.id, stageDetail());
      stageStarted = Date.now();
      stage = next;
      running.set(operation.id, { operation, stage, controller });
      append(operation.id, { type: "stage", stage });
    };
    try {
      if (prefix?.predecessor) {
        // This attempt's own authority: a rebuilt attempt gets a fresh controller.
        const invalidation = prefix.invalidation;
        const invalidate = () => invalidation.abort();
        prefix.predecessor.invalidation.signal.addEventListener("abort", invalidate, { once: true });
        if (prefix.predecessor.invalidation.signal.aborted) invalidate();
        void prefix.predecessor.completed.promise.then((published) => { if (!published) invalidate(); });
      }
      const repository = configuredRepository(config, operation.repo);
      if (!repository) throw new Error(`Repository ${operation.repo} is not configured on this runner`);
      setStage("fetching");
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      if (!await stat(checkout).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) {
        await mkdir(dirname(checkout), { recursive: true });
        await jj(dirname(checkout), ["git", "clone", repository.url, checkout]);
      }
      // Recover a committed rename while resolving policy, before requiring its
      // local bookmark. Fetch and track only the new target; never delete the old one.
      let context = await workspaceContext(checkout, undefined, { fetchMissingBookmarks: true });
      if (!context || context.current.name !== "default") throw new Error("Runner checkout must be the default jj workspace");
      for (const [key, value] of Object.entries({ ...RUNNER_JJ_DEFAULTS, ...config.jj })) await jj(checkout, ["config", "set", "--repo", key, value]);
      integrationBranch = context.integrationBranch;
      remote = context.configuration.remote ?? "origin";
      const branch = context.integrationBranch;
      const retained = operation.kind === "landing" ? log.events({ operationId: operation.id }).find((row) => row.event.type === "source_retained")?.event : undefined;
      const retainedSource = retained?.type === "source_retained" ? retained : undefined;
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch, ...operation.kind === "landing" && !retainedSource ? ["--branch", operation.bookmark] : []]);
      if (retainedSource) await importSubmissionSource(home, operation.repo, operation.id, retainedSource, checkout);
      const sourceRevision = retainedSource ? operation.commitId : operation.kind === "landing" ? operation.bookmark : operation.commitId;
      if (prefix) {
        if ((await revisionFacts(checkout, retainedSource ? operation.commitId : `${prefix.operation.bookmark}@${remote}`)).commitId !== operation.commitId)
          throw new Error("Fetched source differs from submitted commit");
        await retainLandingSource(checkout, operation.id, prefix.attempt, operation.commitId);
        append(operation.id, { type: "attempt_started", attempt: prefix.attempt, source: operation.commitId, checkout });
      }
      // jj's default trunk() names only main, master or trunk: published integration history on any
      // other branch would be mutable, and the candidate cleanup below would abandon it.
      await jj(checkout, ["config", "set", "--repo", 'revset-aliases."trunk()"', `${branch}@${remote}`]);
      // The release checkout holds no integration: what the repository lane finishes is not its concern.
      if (operation.kind === "release") {
        await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
        await release(operation);
        return;
      }
      const recordedHold = log.snapshot(executor.host).held.find((entry) => entry.repo === operation.repo);
      if (!prefix && recordedHold && await revisionExists(checkout, `${recordedHold.commitId} & ::${branch}@${remote}`))
        append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId: recordedHold.commitId });
      // A commit integrated by an earlier turn but never published (a failed push, or
      // a restart after finalization) may already be applied to the external target.
      // Finish it before anything moves the bookmark: dropping it would orphan that state.
      if (!prefix && await jj(checkout, ["log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"])) {
        const held = (await revisionFacts(checkout, branch)).commitId;
        if (!log.snapshot(executor.host).held.some((entry) => entry.repo === operation.repo && entry.commitId === held))
          append(operation.id, { type: "integration_held", repo: operation.repo, commitId: held, reason: "An earlier integration is not yet published" });
        progress(`Finishing ${held.slice(0, 12)}, integrated by an earlier landing but not yet published`);
        await finishIntegration(context, held);
        setStage("fetching");
      }
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      let predecessor: PreparedPrefix | null = null;
      if (prefix?.predecessor) {
        predecessor = await withAuthority(prefix.predecessor.prepared.promise);
        if (!predecessor) throw new Error("Predecessor did not prepare a valid prefix");
        if (!predecessor.overlap) {
          setStage("waiting-for-predecessor");
          if (!await withAuthority(prefix.predecessor.completed.promise)) throw new Error("Predecessor did not publish");
          await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch]);
        }
        await importLandingArtifact(checkout, predecessor.checkout, predecessor.artifact);
        await jj(checkout, ["bookmark", "set", branch, "-r", predecessor.artifact.candidate]);
      }
      // Read the freshly fetched integration policy, rather than an earlier warm tip.
      context = await workspaceContext(checkout);
      if (!context) throw new Error("Runner checkout context is unavailable");
      const submittedPolicy = prefix && operation.kind === "landing"
        ? (await readExactExecutionPolicy(await jj(checkout, ["git", "root"]), operation.commitId)).configuration : null;
      const hasBarrier = (policy: { migrationFinalization?: unknown; postIntegration?: unknown; reset?: unknown } | null) =>
        Boolean(policy?.migrationFinalization || policy?.postIntegration || policy?.reset);
      if (prefix?.predecessor && (hasBarrier(context.configuration) || hasBarrier(submittedPolicy))) {
        setStage("waiting-for-predecessor");
        if (!await withAuthority(prefix.predecessor.completed.promise)) throw new Error("Barrier predecessor did not publish");
      }
      if (operation.kind === "reset") {
        verdict = await reset(branch);
        return;
      }
      // A reland of a submission whose integration has since been published (by the
      // step above, or before a restart) is already landed: never integrate it twice.
      const published = await publishedIntegration(checkout, operation, branch, remote);
      if (published) {
        verdict = { type: "landed", ...published, branch, remote };
        return;
      }
      if (!retainedSource) await jj(checkout, ["bookmark", "track", `${operation.bookmark}@${remote}`]);
      // Drop earlier candidates; never the published integration, which a candidate on an older base does not contain.
      await jj(checkout, ["abandon", "-r", `mutable() ~ ::${sourceRevision} ~ ::${branch}@${remote} ~ ${RETAINED_ARTIFACT_REVISIONS}`]);
      const commits = await jj(checkout, ["log", "-r", sourceRevision, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (commits !== operation.commitId) throw new Error(`Candidate bookmark ${operation.bookmark} does not resolve to submitted commit ${operation.commitId}`);
      const visible = await jj(checkout, ["log", "-r", `change_id(${operation.changeId})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (!prefix && !retainedSource && (visible.split("\n").filter(Boolean).length !== 1 || visible !== operation.commitId))
        throw new Error(`Submitted change ${operation.changeId} must have exactly one visible commit matching ${operation.commitId}`);
      if (prefix || retainedSource) await duplicateLandingSource(checkout, operation.commitId, branch);
      else await jj(checkout, ["edit", operation.commitId]);
      const description = await jj(checkout, ["log", "-r", operation.commitId, "--no-graph", "-T", "description"]);
      const trailer = (name: string) => { const value = new RegExp(`^${name}:\\s*#?(\\d+)\\s*$`, "m").exec(description)?.[1]; return value ? Number(value) : undefined; };
      const identity = log.events({ operationId: operation.id }).findLast((row) => row.event.type === "identity")?.event;
      append(operation.id, { ...(identity?.type === "identity" ? identity : { type: "identity", submitterKind: "unknown", submitterId: operation.submittedBy, workspace: "unknown", machine: operation.submittedBy }), type: "identity", ticket: trailer("Ticket"), spec: trailer("Spec") });
      await recordShape(checkout, context.integrationBranch, operation.commitId, context.configuration.migrationFinalization);
      const candidateContext = context;
      const candidateOptions = {
        pinnedSource: Boolean(prefix || retainedSource),
        environment, onProgress: progress,
        onStage: (next) => { if (next !== "cleaning") setStage(next); },
        runCommand: run,
        adapter: {
          verify: async ({ base, candidate }) => {
            append(operation.id, { type: "verification_base", base });
            await recordShape(checkout, candidateContext.integrationBranch, candidate, candidateContext.configuration.migrationFinalization);
            const verification = await runRequiredVerification({
              root: checkout, checks: candidateContext.configuration.requiredLandingVerification,
              environment, onProgress: progress, run,
            });
            if (prefix?.invalidation.signal.aborted) throw new Error("Exact predecessor invalidated this attempt; late verification success is not evidence");
            if (verification.status === "passed") append(operation.id, { type: "verification_passed", base, candidate });
            return verification;
          },
        },
      } satisfies import("./landing-candidate.ts").CandidateOptions;
      const candidateIO = {
        ...landingIO,
        async assertStackConflictFree(cwd, branch, changeId) {
          try {
            await landingIO.assertStackConflictFree(cwd, branch, changeId);
          } catch (error) {
            rebaseConflict = true;
            conflictFiles = (await jj(cwd, ["resolve", "--list", "-r", changeId]).catch(() => "")).split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0]!);
            throw error;
          }
        },
        landingPreview: async () => ({ context: candidateContext, target: await revisionFacts(checkout, prefix || retainedSource ? "@" : operation.commitId) }),
        ensureLandingDescription: async (_cwd, _context, target) => target,
        async prepareCandidateDependencies(cwd, candidate, target, onProgress, runCommand) {
          await recordShape(cwd, candidate.integrationBranch, target.commitId, candidate.configuration.migrationFinalization);
          setStage("installing");
          installSource = await stat(join(cwd, "node_modules")).then(() => "existing" as const, () => "fresh" as const);
          await landingIO.prepareCandidateDependencies(cwd, candidate, target, onProgress, runCommand);
        },
      } satisfies import("./landing-candidate.ts").LandingIO;
      const integrated = prefix
        ? await (async () => {
          const prepared = await prepareLandingCandidate(checkout, candidateOptions, candidateIO);
          // As integrateLandingCandidate does: any later failure restores generated migration state.
          try { return await integratePrefix(prepared); }
          catch (error) { return rollbackFailure(error, prepared.rollback); }
        })()
        : await integrateLandingCandidate(checkout, candidateOptions, candidateIO);
      const { base, artifact } = integrated;
      if (prefix) {
        verdict = { type: "landed", base, commitId: artifact.commitId, branch, remote };
        return;
      }
      append(operation.id, { type: "integrated", base, commitId: artifact.commitId });
      await finishIntegration(candidateContext, artifact.commitId);
      verdict = { type: "landed", base, commitId: artifact.commitId, branch, remote };
      async function integratePrefix(prepared: PreparedLandingCandidate) {
        const artifact: LandingArtifact = { operationId: operation.id, attempt: prefix!.attempt, source: operation.commitId,
          base: prepared.base, candidate: prepared.artifact.commitId };
        const policy = candidateContext.configuration;
        const overlap = !hasBarrier(policy) && !hasBarrier(submittedPolicy);
        await retainLandingArtifact(checkout, artifact);
        append(operation.id, { type: "attempt_prepared", ...artifact, checkout, overlap,
          ...(predecessor ? { predecessor: { operationId: predecessor.artifact.operationId, attempt: predecessor.artifact.attempt, candidate: predecessor.artifact.candidate } } : {}) });
        prefix!.prepared.resolve({ artifact, checkout, overlap });
        const verified = await verifyPreparedCandidate(checkout, prepared, candidateOptions, candidateIO);
        if (prefix!.predecessor) {
          setStage("waiting-for-predecessor");
          if (!await withAuthority(prefix!.predecessor.completed.promise)) throw new Error("Exact predecessor did not publish; dependent evidence invalidated");
        }
        setStage("waiting-for-predecessor");
        return serially(operation.repo, async () => {
          // Only this canonical checkout owns integration, finalisation, publication and recovery.
          const publisher = repoCheckout(operation.repo);
          if (!await stat(publisher).then(() => true, () => false)) {
            await mkdir(dirname(publisher), { recursive: true });
            await jj(dirname(publisher), ["git", "clone", repository!.url, publisher]);
          }
          for (const [key, value] of Object.entries({ ...RUNNER_JJ_DEFAULTS, ...config.jj })) await jj(publisher, ["config", "set", "--repo", key, value]);
          await jj(publisher, ["git", "fetch", "--remote", remote!, "--branch", branch]);
          const canonical = await workspaceContext(publisher);
          if (!canonical) throw new Error("Canonical publisher is unavailable");
          const local = (await revisionFacts(publisher, branch)).commitId;
          let tip = (await revisionFacts(publisher, `${branch}@${remote}`)).commitId;
          if (local !== tip && !await revisionExists(publisher, `${local} & ::${branch}@${remote}`)) {
            // Held external state remains canonical, even when this attempt verified elsewhere.
            await finishIntegration(canonical, local, publisher);
            await jj(publisher, ["git", "fetch", "--remote", remote!, "--branch", branch]);
            tip = (await revisionFacts(publisher, `${branch}@${remote}`)).commitId;
          }
          if (tip !== artifact.base) throw new PrefixInvalidated("Remote integration changed; exact-prefix verification is invalidated");
          if (retainedSource) await importSubmissionSource(home, operation.repo, operation.id, retainedSource, publisher);
          else await jj(publisher, ["git", "fetch", "--remote", remote!, "--branch", prefix!.operation.bookmark]);
          if ((await revisionFacts(publisher, retainedSource ? operation.commitId : `${prefix!.operation.bookmark}@${remote}`)).commitId !== operation.commitId)
            throw new Error("Submitted source changed; exact-prefix verification is invalidated");
          if (prefix!.invalidation.signal.aborted || controller.signal.aborted) throw new Error("Prefix no longer has publication authority");
          await importLandingArtifact(publisher, checkout, artifact);
          await jj(publisher, ["bookmark", "set", branch, "-r", tip]);
          await jj(publisher, ["new", artifact.candidate]);
          append(operation.id, { type: "publication_intent", attempt: artifact.attempt, base: artifact.base, candidate: artifact.candidate });
          const result = await integratePreparedCandidate(publisher, { ...verified, context: canonical }, candidateOptions, landingIO);
          append(operation.id, { type: "integrated", base: artifact.base, commitId: artifact.candidate });
          await finishIntegration(canonical, artifact.candidate, publisher, artifact.base);
          return result;
        });
      }
    } catch (error) {
      // A fresh attempt: once for a dependent whose predecessor's outcome invalidated it (it then
      // has no predecessor), and once for a head whose remote base moved. Its own failure, an
      // owner kill or a pause never rebuilds.
      retryPrefix = Boolean(prefix && !controller.signal.aborted && !log.paused()
        && (prefix.predecessor ? prefix.invalidation.signal.aborted : error instanceof PrefixInvalidated && !prefix.remoteRebuilt));
      // A failed reset after a publication failure must not append a second verdict.
      if (log.operation(operation.id)?.result) progress(message(error));
      else if (controller.signal.aborted) verdict = { type: "cancelled", reason: OWNER_KILL_REASON };
      else if (prefix?.invalidation.signal.aborted) verdict = { type: "failed", stage: "waiting-for-predecessor", reason: "Exact predecessor invalidated this attempt; its verification does not diagnose the submitted source" };
      else if (error instanceof HeldIntegration) {
        append(operation.id, { type: "integration_held", repo: operation.repo, commitId: error.commitId, reason: error.message });
        verdict = { type: "failed", stage: error.stage, reason: error.message, ...(error.output ? { output: error.output } : {}) };
      }
      else if (error instanceof RequiredVerificationError) verdict = {
        type: "failed", stage: "verifying", reason: error.message,
        command: error.evidence.command, output: error.evidence.stdoutTail + error.evidence.stderrTail,
      };
      else verdict = { type: "failed", stage, reason: message(error) };
      if (prefix && verdict?.type !== "landed") {
        append(operation.id, { type: "attempt_invalidated", attempt: prefix.attempt, reason: message(error) });
        prefix.invalidation.abort();
        prefix.prepared.resolve(null);
        if (retryPrefix && prefix.predecessor) {
          // Wait for the predecessor's outcome while still running here, so a kill reaches this
          // attempt and a pause that starts meanwhile is seen before anything rebuilds.
          const killed = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
          await Promise.race([prefix.predecessor.completed.promise, killed]);
          if (controller.signal.aborted) { retryPrefix = false; verdict = { type: "cancelled", reason: OWNER_KILL_REASON }; }
          else if (log.paused()) retryPrefix = false;
          // It rebuilds as the head, on whatever that outcome left.
          else prefix.predecessor = undefined;
        }
        else if (retryPrefix) prefix.remoteRebuilt = true;
        if (retryPrefix) {
          // Fence later admission onto the fresh attempt before dependent cleanup can wake it.
          prefix.attempt += 1;
          prefix.prepared = deferred();
          prefix.invalidation = new AbortController();
          verdict = undefined;
        }
        else prefix.completed.resolve(false);
      }
    } finally {
      if (stage !== "queued") append(operation.id, stageDetail());
      running.delete(operation.id);
      // Delete the candidate bookmark before the verdict: an author's repository that fetches
      // every bookmark after that would otherwise import it and pin the submitted commit.
      if (!retryPrefix && remote && operation.kind === "landing") await cleanup(operation, checkout, remote);
      // This checkout belongs to the runner: leave failed candidates in history,
      // and start the next turn from the integration (including any held commit).
      if (integrationBranch) {
        try { await jj(checkout, ["new", integrationBranch]); }
        catch (error) {
          const reason = `Runner checkout could not return to ${integrationBranch}: ${message(error)}`;
          progress(reason);
          if (verdict?.type === "failed") verdict = { ...verdict, reason: `${verdict.reason}\n${reason}` };
        }
      }
      if (verdict) append(operation.id, verdict);
      if (verdict?.type === "landed")
        await schedule(operation.repo, verdict.commitId).catch((error: unknown) => progress(`Could not schedule deploys and resets: ${message(error)}`));
      // A reset, whatever its verdict, starts the next interval.
      if (operation.kind === "reset") await scheduleLatest(operation.repo, progress);
    }
    if (retryPrefix && prefix) {
      // A fresh immutable attempt, never an owner kill, hold, source replacement or paused rebuild.
      await processOperation(operation, prefix);
    }
    async function recordShape(cwd: string, branch: string, commit: string, migration: import("./execution-policy.ts").MigrationFinalizationPolicy | null | undefined): Promise<void> {
      const diff = await jj(cwd, ["diff", "--from", branch, "--to", commit, "--git"]);
      const paths = [...new Set([...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => match[2]!))];
      const insertions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      const roots = (prefix: string) => [...new Set(paths.flatMap((path) => path.startsWith(`${prefix}/`) ? [path.split("/")[1]!] : []))];
      const migrationPaths = [...migration?.triggerPaths ?? [], ...migration?.artifactPaths ?? []];
      const gitDirectory = await jj(cwd, ["git", "root"]);
      const tree = await workspaceRun("git", ["--git-dir", gitDirectory, "rev-parse", `${commit}^{tree}`], { cwd });
      if (tree.code !== 0) throw new Error("Could not observe candidate tree for change shape");
      append(operation.id, { type: "change_shape", files: paths.length, insertions, deletions, packages: roots("packages"), apps: roots("apps"),
        migrationBearing: paths.some((path) => migrationPaths.some((root) => path === root || path.startsWith(`${root}/`))),
        testFiles: paths.filter((path) => /(?:test|spec)\.[cm]?[jt]sx?$/.test(path)),
        fileSet: createHash("sha256").update(tree.stdout.trim()).digest("hex"),
        sizeBucket: insertions + deletions <= 100 ? "small" : insertions + deletions <= 1000 ? "medium" : "large" });
    }
    /**
     * Run the reset the integration tip declares, in its exact source: the integration
     * branch was just set to the remote, so the tip is the newest commit any landing
     * finalized against the target. The step's output stays in an owner-only file beside
     * the run log, never in an event.
     */
    async function reset(branch: string): Promise<OperationEvent> {
      await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 });
      const source = (await revisionFacts(checkout, branch)).commitId;
      const { gitDirectory, configuration } = await readExactExecutionPolicy(join(checkout, ".git"), source);
      const policy = configuration?.reset;
      if (!policy) return { type: "failed", stage, reason: `${source.slice(0, 12)} declares no reset` };
      setStage("resetting");
      progress(`Resetting ${policy.target} from ${source.slice(0, 12)}`);
      const reason = await runReset({ gitDirectory, source, policy, run, abortSignal: controller.signal,
        outputPath: join(home, "logs", `${operation.id}.reset-output`), reasonPath: join(home, "logs", `${operation.id}.reset-reason`),
        readEnvironment: environment ?? (() => process.env) });
      // A killed probe or command comes back as a signalled result: it ends cancelled, not failed.
      if (controller.signal.aborted) throw new OwnerKill();
      return reason === null ? { type: "reset", target: policy.target, source } : { type: "failed", stage, reason };
    }
    /**
     * A candidate that declares a production deployment is a promotion: it must be a
     * commit staging deployed, and once the release branch holds it, production deploys
     * exactly that commit in the deploy lane, so a slow deploy never holds a landing.
     * Only publication takes the repository lane. The approval is this operation, which
     * only a kill ends once it runs, and staging evidence is never withdrawn, so neither
     * changes during verification; `confirmRelease` rechecks the planned release base.
     */
    async function release(operation: ReleaseOperation): Promise<void> {
      const { configuration } = await readExactExecutionPolicy(join(checkout, ".git"), operation.commitId);
      const promotes = Boolean(configuration?.deployments?.environments.production);
      if (promotes && !log.deployments(operation.repo, "staging").some((entry) => entry.commitId === operation.commitId && entry.result?.type === "deployed")) {
        append(operation.id, { type: "failed", stage, reason: `Staging is not green on ${operation.commitId.slice(0, 12)}: production promotes only a commit staging deployed` });
        return;
      }
      const result = await confirmRelease(checkout, { candidate: operation.commitId, migrationsReady: operation.migrationsReady,
        onProgress: progress, onStage: setStage, run, ...(environment ? { environment } : {}),
        exclusively: (publication) => {
          // A shared-lane release owns the publication lane for its whole turn.
          // Rejoining it would wait for this very release to finish.
          if (admissionLane(laneOf(operation.repo), operation.repo, "release") === laneOf(operation.repo)) return publication();
          if (lanes.has(laneOf(operation.repo))) progress(`Verified; publishing after ${operation.repo}'s running turn`);
          return serially(operation.repo, publication);
        } });
      if (controller.signal.aborted) throw new OwnerKill();
      if (result.status === "released" || result.status === "released_by") {
        append(operation.id, { type: "released", result, ...promotes ? { deploy: productionDeploy(operation, result) } : {} });
        if (promotes) wakeDeploys();
      } else if (result.status === "verification_failed") append(operation.id, {
        type: "failed", stage: "verifying", reason: result.reason,
        command: result.evidence.command, output: result.evidence.stdoutTail + result.evidence.stderrTail,
      });
      else if (!result.ok && result.status === "refused") append(operation.id, { type: "failed", stage, reason: result.reason });
      else throw new Error(`Unexpected release result ${result.status}`);
    }
  }
  async function recoverRunning(): Promise<void> {
    for (const operation of log.openOperations().filter((entry) => entry.status === "running")) {
      const checkout = checkoutPath(operation);
      let remote: string | undefined;
      if (operation.kind === "deploy") {
        // Scheduling at startup retries a deploy whose projects never ran.
        // Production deploys only through a promotion, whose rerun confirm deploys it again.
        const again = operation.environment === "production" ? `slipjay promote --confirm ${operation.commitId.slice(0, 12)}` : `slipjay deploy ${operation.environment}`;
        // A restart can stop a deploy between activations or part-way through its migrations; it is not rolled back,
        // and its rerun follows the schema as possibly changed.
        const activating = operation.promotion ? "; projects it activated before the restart keep serving it, and its migrations may have been applied" : "";
        append(operation.id, { type: "failed", stage: operation.stage, reason: `runner restarted during ${operation.stage}${activating}; deploy again with ${again}` });
        continue;
      }
      if (operation.kind === "reset") {
        // The schedule waits a full interval after this one; the owner can reset again at once.
        append(operation.id, { type: "failed", stage: operation.stage, reason: `runner restarted during ${operation.stage}; run slipjay reset again` });
        continue;
      }
      if (operation.kind === "release") {
        // A release that published reports itself on a rerun confirm.
        append(operation.id, { type: "failed", stage: operation.stage,
          reason: `runner restarted during ${operation.stage}; rerun slipjay promote --confirm ${operation.commitId.slice(0, 12)}` });
        continue;
      }
      let verdict: OperationEvent = { type: "failed", stage: operation.stage, reason: `runner restarted during ${operation.stage}; land again` };
      let integrated = log.events({ operationId: operation.id }).map((stored) => stored.event).findLast((event) => event.type === "integrated");
      const retainUnresolved = () => {
        if (integrated && !log.snapshot(executor.host).held.some((entry) => entry.repo === operation.repo && entry.commitId === integrated!.commitId))
          append(operation.id, { type: "integration_held", repo: operation.repo, commitId: integrated.commitId, reason: "Publication of the retained integration is unconfirmed after restart" });
      };
      retainUnresolved();
      try {
        if (configuredRepository(config, operation.repo)) {
          const context = await workspaceContext(checkout);
          if (context) remote = context.configuration.remote ?? "origin";
          // Stopped after integrating but before recording it: record the held commit,
          // so a reland recognises it once the next turn publishes it.
          if (!integrated && context && remote) {
            const branch = context.integrationBranch;
            const intent = log.events({ operationId: operation.id }).map((row) => row.event).findLast((event) => event.type === "publication_intent");
            if (intent?.type === "publication_intent" && (await revisionFacts(checkout, branch)).commitId === intent.candidate) {
              integrated = { type: "integrated", base: intent.base, commitId: intent.candidate };
              append(operation.id, integrated);
              retainUnresolved();
            }
            // A retained submission verifies a duplicate of its source, under a change ID of its own:
            // the verified candidates name it.
            const changes = [operation.changeId];
            for (const stored of log.events({ operationId: operation.id }))
              if (stored.event.type === "verification_passed") {
                const change = await jj(checkout, ["log", "-r", `present(${stored.event.candidate})`, "--no-graph", "-T", "change_id"]);
                if (change) changes.push(change);
              }
            const held = await jj(checkout, ["log", "-r", `${branch} & (${changes.map((change) => `change_id(${change})`).join(" | ")}) ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
            // Another operation's integration of the same change (an earlier submission) is not this one's.
            const claimed = log.operationsForChange(operation.repo, operation.changeId).some((other) =>
              log.events({ operationId: other.id }).some((stored) => stored.event.type === "integrated" && stored.event.commitId === held));
            if (!integrated && held && !claimed) {
              const [base = ""] = (await jj(checkout, ["log", "-r", `${held}-`, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n");
              integrated = { type: "integrated", base, commitId: held };
              append(operation.id, integrated);
              retainUnresolved();
            }
          }
          if (integrated) {
            if (!context || !remote) throw new Error("Runner checkout context is unavailable");
            const branch = context.integrationBranch;
            const fetched = await fetchIntegration(checkout, remote, branch);
            if (fetched.code !== 0) throw new Error(fetched.stderr || fetched.stdout);
            if (await revisionExists(checkout, `${integrated.commitId} & ::${branch}@${remote}`)) {
              append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId: integrated.commitId });
              verdict = { type: "landed", base: integrated.base, commitId: integrated.commitId, branch, remote };
            }
          }
        }
      } catch (error) {
        append(operation.id, { type: "progress", line: `Recovery could not confirm publication: ${message(error)}` });
      }
      if (remote) await cleanup(operation, checkout, remote);
      append(operation.id, verdict);
    }
  }
  // Reconcile warm repositories even when their failed operation is already terminal.
  // Failure to observe the remote is not evidence that an existing hold recovered.
  async function reconcileHeld(): Promise<void> {
    for (const repo of Object.keys(config.repos).map(repositoryKey)) {
      const checkout = repoCheckout(repo);
      try {
        const context = await workspaceContext(checkout);
        if (!context) continue;
        const branch = context.integrationBranch;
        const remote = context.configuration.remote ?? "origin";
        let known = log.snapshot(executor.host).held.find((entry) => entry.repo === repo);
        // Local evidence survives even when a remote outage prevents confirmation.
        const ahead = await jj(checkout, ["log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
        if (ahead) {
          const commitId = (await revisionFacts(checkout, branch)).commitId;
          if (known?.commitId !== commitId)
            append(RUNNER_CONTROL_ID, { type: "integration_held", repo, commitId, reason: "Publication of the retained integration is unconfirmed after restart" });
        }
        const fetched = await fetchIntegration(checkout, remote, branch);
        if (fetched.code !== 0) continue;
        known = log.snapshot(executor.host).held.find((entry) => entry.repo === repo);
        if (known && await revisionExists(checkout, `${known.commitId} & ::${branch}@${remote}`))
          append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo, commitId: known.commitId });
      } catch { /* An unavailable checkout cannot prove recovery; retain recorded holds. */ }
    }
  }
  /** Run `work` in `lane`, after whatever holds it. A failure of earlier work does not stop it. */
  function inLane(lane: string, work: () => Promise<void>): Promise<void> {
    const previous = lanes.get(lane) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work).finally(() => {
      if (lanes.get(lane) === pending) lanes.delete(lane);
    });
    lanes.set(lane, pending);
    return pending;
  }
  return {
    wake() {
      wakeMain();
      wakeDeploys();
    },
    async recover() {
      // Every lane is idle at startup; recovery waits for any that is not, and holds them all.
      // Commands an earlier process left running stop before recovery touches their checkouts.
      recovering = Promise.allSettled([...lanes.values(), ...attempts]).then(async () => { await executor.recover?.(); await recoverRunning(); await reconcileHeld(); })
        .finally(() => { recovering = undefined; });
      await recovering;
      for (const repo of Object.keys(config.repos).map(repositoryKey)) await scheduleLatest(repo);
    },
    cancelled(operation) {
      if (operation.kind !== "landing") return;
      // A submission that woke the queue while this cleanup held the lane is admitted after it.
      void inLane(laneOf(operation.repo), async () => {
        const checkout = checkoutPath(operation);
        const context = await workspaceContext(checkout).catch(() => null);
        if (context) await cleanup(operation, checkout, context.configuration.remote ?? "origin");
      }).finally(wakeMain);
    },
    async idle() {
      for (;;) {
        if (recovering) await recovering;
        await Promise.allSettled([...lanes.values(), ...attempts]);
        const lane = deploying;
        await lane;
        if (!recovering && !lanes.size && !attempts.size && lane === deploying) return;
      }
    },
    close() { scheduler.close(); resetScheduler.close(); },
    kill(operationId) {
      const target = operationId === undefined ? undefined : running.get(operationId);
      if (operationId !== undefined && !target) return { status: "not_running", operation: log.operation(operationId) };
      if (!target && running.size > 1)
        return { status: "ambiguous", operations: [...running.values()].map((entry) => log.operation(entry.operation.id) ?? entry.operation) };
      const entry = target ?? [...running.values()][0];
      if (!entry) return { status: "idle" };
      const operation = log.operation(entry.operation.id) ?? entry.operation;
      if (!KILLABLE_STAGES.includes(entry.stage)) return { status: "refused", operation };
      entry.controller.abort();
      return { status: "killed", operation };
    },
    logPath,
    async readLog(id) {
      const events = log.events({ operationId: id }).filter((row) => row.event.type !== "submitted");
      return events.length ? events.map((stored) => `${JSON.stringify(stored)}\n`).join("") : null;
    },
  };
}

/** What a finished deploy put in its environment: every project, or the ones a failed deploy reached. */
const recordOf = (operation: DeployOperation): DeployRecord | undefined =>
  operation.result?.type === "deployed" ? operation.result.record : operation.result?.type === "failed" ? operation.result.deployment : undefined;

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
