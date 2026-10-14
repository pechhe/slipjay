import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { stat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { integrateLandingCandidate } from "./landing-candidate.ts";
import { completeLanding, fetchIntegration, landingIO } from "./landing-steps.ts";
import { createDeployScheduler } from "./deploy-scheduler.ts";
import { createResetScheduler } from "./reset-scheduler.ts";
import { runReset } from "./reset.ts";
import { ensureDeployCommit, ensureOnIntegrationBranch, runDeploy, schemaMayHaveChanged } from "./deploy.ts";
import { readExactExecutionPolicy } from "./post-integration-source.ts";
import { confirmRelease, returnRelease } from "./release.ts";
import { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
import { KILLABLE_STAGES, OWNER_KILL_REASON, RUNNER_CONTROL_ID, RUNNER_DEFAULT_LIMITS, RUNNER_DEFAULT_WORKERS, RUNNER_SLICE, repositoryKey, repositoryLane, RUNNER_JJ_DEFAULTS, servedDeploy } from "./runner-contract.ts";
import { newOperationId } from "./runner-log.ts";
import { parseFailureOutput } from "./failure-classification.ts";
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

/**
 * Runs commands on this host. Each run's process group is killed on abort or
 * timeout, but a gate's own tools may start further groups (setsid) that a group
 * signal never reaches. Under a systemd user manager each run therefore gets its
 * own transient scope, and stopping the scope kills everything left in it, on
 * abort and after every run. Elsewhere only the run's process group is killed.
 * Every scope joins RUNNER_SLICE, whose `limits` bound all runs together: the
 * workers' gates, deploys and every process they start, however they nest.
 * Memory beyond `memoryHigh` is throttled; `memoryMax` is the hard ceiling.
 */
export function localExecutor(host = hostname(), env: NodeJS.ProcessEnv = process.env, limits: RunnerLimits = {}): Executor {
  const runtimeDir = process.platform === "linux" ? env.XDG_RUNTIME_DIR : undefined;
  if (!runtimeDir) return { host, run: runBoundedProcess };
  const systemctl = (args: string[]) => new Promise<string | null>((resolve) =>
    execFile("systemctl", ["--user", ...args], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } }, (error, _stdout, stderr) => resolve(error ? (stderr.trim() || error.message) : null)));
  const kill = (unit: string) => systemctl(["kill", "--signal=SIGKILL", unit]).then(() => {});
  const { memoryHigh, memoryMax, cpuQuota, tasksMax } = { ...RUNNER_DEFAULT_LIMITS, ...limits };
  // Runtime properties: they last until the user manager restarts, and each runner start sets them again.
  // A run never waits on a failure to set them: the runner's journal says so and the next run tries again.
  let sliced: Promise<void> | undefined;
  const slice = () => sliced ??= systemctl(["set-property", "--runtime", RUNNER_SLICE,
    `MemoryHigh=${memoryHigh}`, `MemoryMax=${memoryMax}`, `CPUQuota=${cpuQuota}`, `TasksMax=${tasksMax}`]).then((failure) => {
    if (failure === null) return;
    console.error(`SlipJay runner: could not set the limits of ${RUNNER_SLICE}, so runs are not capped: ${failure}`);
    sliced = undefined;
  });
  return {
    host,
    async run(request) {
      await slice();
      const unit = `slipjay-run-${randomUUID()}.scope`;
      const stop = () => { void kill(unit); };
      request.abortSignal?.addEventListener("abort", stop, { once: true });
      try {
        return await runBoundedProcess({
          ...request, executable: "systemd-run",
          args: ["--user", "--scope", "--quiet", "--collect", `--slice=${RUNNER_SLICE}`, `--unit=${unit}`, "--", request.executable, ...request.args],
          env: { ...request.env ?? sanitizedProcessEnv(), XDG_RUNTIME_DIR: runtimeDir },
        });
      } finally {
        request.abortSignal?.removeEventListener("abort", stop);
        await kill(unit);
      }
    },
  };
}

/**
 * Each repository has one serial lane that owns its warm checkout and every transition
 * of its integration and release branches: its landings, releases and resets of the
 * target landings finalize against take turns in arrival order. Different repositories
 * share no checkout, branch, target or environment, so their lanes run at once, at most
 * `workers` of them; an operation waiting for a worker is admitted oldest first.
 * Deploys take turns in a separate lane that only reads the warm store, so a deploy
 * that waits minutes on its build never holds a landing.
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
  const workers = Math.max(1, Math.floor(config.workers ?? RUNNER_DEFAULT_WORKERS));
  /** Each lane's work holding its repositories' checkouts now, and any chained behind it, by `repositoryLane`. */
  const lanes = new Map<string, Promise<void>>();
  const laneOf = (repo: string) => repositoryLane(config, repo);
  /** Operations admitted to a worker, which they hold until they finish. */
  const admitted = new Set<string>();
  /** Running landings, releases and resets, by operation, in their current stage. */
  const running = new Map<string, { operation: Operation; stage: RunnerStage; controller: AbortController }>();
  /** Recovery holds every lane: nothing is admitted until it finishes. */
  let recovering: Promise<void> | undefined;
  const logPath = (id: string) => join(home, "logs", `${id}.log`);
  function append(id: string, event: OperationEvent): void {
    log.append(id, event);
  }
  function runFinished(runId: string, result: BoundedProcessResult, started: number, request: BoundedProcessRequest, privateOutput = false): OperationEvent {
    return { type: "run_finished", runId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      durationMs: Date.now() - started, outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      killed: result.cancelled, ...(privateOutput ? {} : parseFailureOutput(redactMigrationOutput(`${result.stdout}\n${result.stderr}`, request.cwd, request.env))) };
  }
  const repoCheckout = (repo: string) => join(home, "repos", repo);
  const checkoutPath = (operation: Operation) => repoCheckout(operation.repo);
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
          append(operation.id, { type: "run_started", runId, command: [request.executable, ...request.args].join(" "), host: executor.host, timeoutMs: request.timeoutMs, purpose: "deploy" });
          const result = await executor.run(request).catch((error: unknown) => {
            append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started });
            throw error;
          });
          append(operation.id, runFinished(runId, result, started, request));
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
    const returned = await serially(operation.repo, () => returnRelease(checkoutPath(operation), merge));
    return returned.returned
      ? { automatic: true, releaseBranch: returned.releaseBranch, reason: `rolled back: production serves what it served before, and the release branch is back on ${returned.releaseBranch.slice(0, 12)}` }
      : { automatic: false, reason: `rollback incomplete: production serves what it served before, but the release branch still holds the release: ${returned.reason}` };
  }
  /** Run `work` in the repository's lane, after its running turn, and resume the queue after it. */
  function serially<T>(repo: string, work: () => Promise<T>): Promise<T> {
    let value: T;
    const pending = inLane(repo, async () => { value = await work(); });
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
   * to its repository's lane once that lane is idle, so a repository's operations keep
   * their order. A pause admits nothing new; running operations finish.
   */
  function wakeMain(): void {
    if (recovering || log.paused()) return;
    for (const operation of log.openOperations()) {
      if (admitted.size >= workers) return;
      if (operation.kind === "deploy" || operation.status !== "queued" || lanes.has(laneOf(operation.repo))) continue;
      admitted.add(operation.id);
      void inLane(operation.repo, () => processOperation(operation))
        .finally(() => { admitted.delete(operation.id); wakeMain(); });
    }
  }
  async function processOperation(operation: LandingOperation | ReleaseOperation | ResetOperation): Promise<void> {
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
    const checkout = checkoutPath(operation);
    let remote: string | undefined;
    let integrationBranch: string | undefined;
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    // Gate and migration commands both go through the executor, so each run records where it ran.
    async function run(request: BoundedProcessRequest, purpose?: RunPurpose): Promise<BoundedProcessResult> {
      const runId = randomUUID();
      const started = Date.now();
      append(operation.id, { type: "run_started", runId, command: [request.executable, ...request.args].join(" "), host: executor.host, timeoutMs: request.timeoutMs, purpose: purpose ?? (stage === "resetting" ? "reset" : "gate") });
      const abortSignal = request.abortSignal ? AbortSignal.any([request.abortSignal, controller.signal]) : controller.signal;
      const runEnvironment = stage === "resetting" ? request.env : sanitizedProcessEnv(request.env);
      if ((purpose === "migration_generate" || purpose === "migration_verify") && request.env?.SLIPJAY_MIGRATION_CONTEXT)
        runEnvironment!.SLIPJAY_MIGRATION_CONTEXT = request.env.SLIPJAY_MIGRATION_CONTEXT;
      const result = await executor.run({ ...request, env: runEnvironment,
        redactOutput: stage === "resetting" ? request.redactOutput : (value) => redactVerificationOutput(value, checkout), abortSignal }).catch((error: unknown) => {
        append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started });
        throw error;
      });
      append(operation.id, runFinished(runId, result, started, request, stage === "resetting"));
      return result;
    }
    // Finalization, then publication, of an integrated commit (completeLanding).
    async function finishIntegration(context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>, commitId: string): Promise<void> {
      setStage("finalizing");
      const tail = await completeLanding(checkout, context, commitId, { ...(environment ? { environment } : {}), onPublishing: () => setStage("publishing") })
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
      if (stage !== "queued") append(operation.id, stageDetail());
      stageStarted = Date.now();
      stage = next;
      running.set(operation.id, { operation, stage, controller });
      append(operation.id, { type: "stage", stage });
    };
    try {
      const repository = configuredRepository(config, operation.repo);
      if (!repository) throw new Error(`Repository ${operation.repo} is not configured on this runner`);
      setStage("fetching");
      if (!await stat(checkout).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) {
        await mkdir(dirname(checkout), { recursive: true });
        await jj(dirname(checkout), ["git", "clone", repository.url, checkout]);
      }
      let context = await workspaceContext(checkout);
      if (!context || context.current.name !== "default") throw new Error("Runner checkout must be the default jj workspace");
      for (const [key, value] of Object.entries({ ...RUNNER_JJ_DEFAULTS, ...config.jj })) await jj(checkout, ["config", "set", "--repo", key, value]);
      integrationBranch = context.integrationBranch;
      remote = context.configuration.remote ?? "origin";
      const branch = context.integrationBranch;
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch, ...operation.kind === "landing" ? ["--branch", operation.bookmark] : []]);
      // jj's default trunk() names only main, master or trunk: published integration history on any
      // other branch would be mutable, and the candidate cleanup below would abandon it.
      await jj(checkout, ["config", "set", "--repo", 'revset-aliases."trunk()"', `${branch}@${remote}`]);
      const recordedHold = log.snapshot(executor.host).held.find((entry) => entry.repo === operation.repo);
      if (recordedHold && await revisionExists(checkout, `${recordedHold.commitId} & ::${branch}@${remote}`))
        append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId: recordedHold.commitId });
      // A commit integrated by an earlier turn but never published (a failed push, or
      // a restart after finalization) may already be applied to the external target.
      // Finish it before anything moves the bookmark: dropping it would orphan that state.
      if (await jj(checkout, ["log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"])) {
        const held = (await revisionFacts(checkout, branch)).commitId;
        if (!log.snapshot(executor.host).held.some((entry) => entry.repo === operation.repo && entry.commitId === held))
          append(operation.id, { type: "integration_held", repo: operation.repo, commitId: held, reason: "An earlier integration is not yet published" });
        progress(`Finishing ${held.slice(0, 12)}, integrated by an earlier landing but not yet published`);
        await finishIntegration(context, held);
        setStage("fetching");
      }
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      // Read the freshly fetched integration policy, rather than an earlier warm tip.
      context = await workspaceContext(checkout);
      if (!context) throw new Error("Runner checkout context is unavailable");
      if (operation.kind === "reset") {
        verdict = await reset(branch);
        return;
      }
      if (operation.kind === "release") {
        await release(operation);
        return;
      }
      // A reland of a submission whose integration has since been published (by the
      // step above, or before a restart) is already landed: never integrate it twice.
      const published = await publishedIntegration(checkout, operation, branch, remote);
      if (published) {
        verdict = { type: "landed", ...published, branch, remote };
        return;
      }
      await jj(checkout, ["bookmark", "track", `${operation.bookmark}@${remote}`]);
      // Drop earlier candidates; never the published integration, which a candidate on an older base does not contain.
      await jj(checkout, ["abandon", "-r", `mutable() ~ ::${operation.bookmark} ~ ::${branch}@${remote}`]);
      const commits = await jj(checkout, ["log", "-r", operation.bookmark, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (commits !== operation.commitId) throw new Error(`Candidate bookmark ${operation.bookmark} does not resolve to submitted commit ${operation.commitId}`);
      const visible = await jj(checkout, ["log", "-r", `change_id(${operation.changeId})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (visible.split("\n").filter(Boolean).length !== 1 || visible !== operation.commitId)
        throw new Error(`Submitted change ${operation.changeId} must have exactly one visible commit matching ${operation.commitId}`);
      await jj(checkout, ["edit", operation.commitId]);
      const description = await jj(checkout, ["log", "-r", operation.commitId, "--no-graph", "-T", "description"]);
      const trailer = (name: string) => { const value = new RegExp(`^${name}:\\s*#?(\\d+)\\s*$`, "m").exec(description)?.[1]; return value ? Number(value) : undefined; };
      const identity = log.events({ operationId: operation.id }).findLast((row) => row.event.type === "identity")?.event;
      append(operation.id, { ...(identity?.type === "identity" ? identity : { type: "identity", submitterKind: "unknown", submitterId: operation.submittedBy, workspace: "unknown", machine: operation.submittedBy }), type: "identity", ticket: trailer("Ticket"), spec: trailer("Spec") });
      await recordShape(checkout, context.integrationBranch, operation.commitId, context.configuration.migrationFinalization);
      const candidateContext = context;
      const integrated = await integrateLandingCandidate(checkout, {
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
            if (verification.status === "passed") append(operation.id, { type: "verification_passed", base, candidate });
            return verification;
          },
        },
      }, {
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
        landingPreview: async () => ({ context: candidateContext, target: await revisionFacts(checkout, operation.commitId) }),
        ensureLandingDescription: async (_cwd, _context, target) => target,
        async prepareCandidateDependencies(cwd, candidate, target, onProgress) {
          await recordShape(cwd, candidate.integrationBranch, target.commitId, candidate.configuration.migrationFinalization);
          setStage("installing");
          installSource = await stat(join(cwd, "node_modules")).then(() => "existing" as const, () => "fresh" as const);
          await landingIO.prepareCandidateDependencies(cwd, candidate, target, onProgress);
        },
      });
      const { base, artifact } = integrated;
      append(operation.id, { type: "integrated", base, commitId: artifact.commitId });
      await finishIntegration(candidateContext, artifact.commitId);
      verdict = { type: "landed", base, commitId: artifact.commitId, branch, remote };
    } catch (error) {
      // A failed reset after a publication failure must not append a second verdict.
      if (log.operation(operation.id)?.result) progress(message(error));
      else if (controller.signal.aborted) verdict = { type: "cancelled", reason: OWNER_KILL_REASON };
      else if (error instanceof HeldIntegration) {
        append(operation.id, { type: "integration_held", repo: operation.repo, commitId: error.commitId, reason: error.message });
        verdict = { type: "failed", stage: error.stage, reason: error.message, ...(error.output ? { output: error.output } : {}) };
      }
      else if (error instanceof RequiredVerificationError) verdict = {
        type: "failed", stage: "verifying", reason: error.message,
        command: error.evidence.command, output: error.evidence.stdoutTail + error.evidence.stderrTail,
      };
      else verdict = { type: "failed", stage, reason: message(error) };
    } finally {
      if (stage !== "queued") append(operation.id, stageDetail());
      running.delete(operation.id);
      // Delete the candidate bookmark before the verdict: an author's repository that fetches
      // every bookmark after that would otherwise import it and pin the submitted commit.
      if (remote && operation.kind === "landing") await cleanup(operation, checkout, remote);
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
     */
    async function release(operation: ReleaseOperation): Promise<void> {
      const { configuration } = await readExactExecutionPolicy(join(checkout, ".git"), operation.commitId);
      const promotes = Boolean(configuration?.deployments?.environments.production);
      if (promotes && !log.deployments(operation.repo, "staging").some((entry) => entry.commitId === operation.commitId && entry.result?.type === "deployed")) {
        append(operation.id, { type: "failed", stage, reason: `Staging is not green on ${operation.commitId.slice(0, 12)}: production promotes only a commit staging deployed` });
        return;
      }
      const result = await confirmRelease(checkout, { candidate: operation.commitId, migrationsReady: operation.migrationsReady,
        onProgress: progress, onStage: setStage, run, ...(environment ? { environment } : {}) });
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
            const held = await jj(checkout, ["log", "-r", `${branch} & change_id(${operation.changeId}) ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
            // Another operation's integration of the same change (an earlier submission) is not this one's.
            const claimed = log.operationsForChange(operation.repo, operation.changeId).some((other) =>
              log.events({ operationId: other.id }).some((stored) => stored.event.type === "integrated" && stored.event.commitId === held));
            if (held && !claimed) {
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
  /** Run `work` in the repository's lane, after whatever holds it. A failure of earlier work does not stop it. */
  function inLane(repo: string, work: () => Promise<void>): Promise<void> {
    const lane = laneOf(repo);
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
      recovering = Promise.allSettled([...lanes.values()]).then(async () => { await recoverRunning(); await reconcileHeld(); })
        .finally(() => { recovering = undefined; });
      await recovering;
      for (const repo of Object.keys(config.repos).map(repositoryKey)) await scheduleLatest(repo);
    },
    cancelled(operation) {
      if (operation.kind !== "landing") return;
      // A submission that woke the queue while this cleanup held the lane is admitted after it.
      void inLane(operation.repo, async () => {
        const checkout = checkoutPath(operation);
        const context = await workspaceContext(checkout).catch(() => null);
        if (context) await cleanup(operation, checkout, context.configuration.remote ?? "origin");
      }).finally(wakeMain);
    },
    async idle() {
      for (;;) {
        if (recovering) await recovering;
        await Promise.allSettled([...lanes.values()]);
        const lane = deploying;
        await lane;
        if (!recovering && !lanes.size && lane === deploying) return;
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
