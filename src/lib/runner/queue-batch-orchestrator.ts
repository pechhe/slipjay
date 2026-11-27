import { join } from "node:path";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import { jj } from "../infra/workspace-jj.ts";
import { RequiredVerificationError, runRequiredVerification } from "../landing/required-verification.ts";
import type { BatchVerification } from "../policy/batch-verification.ts";
import type { ExecutionPolicy } from "../policy/execution-policy.ts";
import { nextPromotionAt } from "../policy/promotion-schedule.ts";
import type { BuildRouteAnswer } from "../build/build-admission.ts";
import { boundedKeys, boundedOutput, boundedTests, flakyVerifies, PREBUILD_KEY, runBatchCheck, type BatchCheckRecord, type BatchLanding, type BatchRun, type BatchRunRecord, type BatchScope, type SuiteState } from "../release/batch-check.ts";
import type { PrebuildResult } from "../release/deploy.ts";
import { readExactExecutionPolicy } from "../release/post-integration-source.ts";
import { prepareWorkspaceDependencies } from "../workspace/workspace-dependencies.ts";
import { checkFailureBlock, isHostResourceExhaustion } from "./failure-classification.ts";
import type { HostBudgetClass } from "./host-budget.ts";
import { repositoryKey } from "./runner-contract.ts";
import type { DeployCapability, ReleaseCapability } from "./runner-queue-capabilities.ts";
import type { Executor, GatePlacement, LeaseBuildMachine, MachineVerification, Operation, OperationEvent, OperationLog, ReleaseAlertDetails, RemoteAttempt, RemoteOpenFailure, RemoteVerification, RunnerConfig, RunnerStage, RuntimeIdentity, RunPurpose, VerificationOperation, VerificationResponse } from "./runner-types.ts";

/** How many complete checks of one head a flaky or infrastructure failure may cost before the runner stops asking again. */
const BATCH_ATTEMPTS = 3;

const configuredRepository = (config: RunnerConfig, repo: string) =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1];

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
}

/** A build that has started: `done` settles when it ends. */
export type BatchPrebuildHandle = { done: Promise<PrebuildResult> };

export type BatchGateAttempt = { attempt: RemoteAttempt; started: number; placement: GatePlacement; place?: number };

export type BatchVerifyRunContext = {
  operation: VerificationOperation;
  checkout: string;
  integrationBranch?: string;
  stage: () => RunnerStage;
  setStage: (next: RunnerStage) => void;
  progress: (line: string) => void;
  controller: AbortController;
  authorityError: () => Error;
  run: (request: BoundedProcessRequest, purpose?: RunPurpose, via?: Pick<Executor, "host" | "run"> & { runtime?: RuntimeIdentity; reportRoot?: string }) => Promise<BoundedProcessResult & { runId?: string }>;
  closeRemote: (gate: BatchGateAttempt, options?: { discard?: boolean; wait?: boolean }) => Promise<void>;
  buildCheckEnvironment: () => Promise<Record<string, string>>;
  capacityProgress: (placement: GatePlacement) => (line: string, waitedMs: number, finished: boolean) => void;
  waitForHostBudget: (placement: GatePlacement | undefined, jobClass: HostBudgetClass, signal: AbortSignal) => Promise<void>;
  takeCheckPlace: (name: string, fallback: string) => Promise<{ machine: string; place: MachineVerification } | null>;
  releaseCheckPlace: (name: string) => void;
};

export type BatchOrchestratorHost = {
  log: OperationLog;
  config: RunnerConfig;
  executor: Executor;
  environment?: () => NodeJS.ProcessEnv;
  now: () => number;
  isClosed: () => boolean;
  repoCheckout: (repo: string) => string;
  machineBuilds: Readonly<Record<string, { machine: string; lease: LeaseBuildMachine }>>;
  machineGatesQueued: (machine: string) => boolean;
  remoteVerification?: RemoteVerification;
  running: ReadonlyMap<string, { operation: Operation; stage: RunnerStage; controller: AbortController; stopDiagnosis?: (reason: string) => void }>;
  stopping: Map<string, string>;
  append: (id: string, event: OperationEvent) => void;
  releasePolicy: (repo: string, commitId: string, ranAgainst?: string) => Promise<ExecutionPolicy | null>;
  releasePolicySnapshot: (repo: string, commitId: string, ranAgainst?: string) => Promise<{ base: string | null; policy: ExecutionPolicy | null }>;
  servedBase: (repo: string, directory: string) => Promise<string | null>;
  missingPromotion: (base: ExecutionPolicy) => string | null;
  standsFor: (repo: string, commitId: string) => string | null;
  currentChecks: (repo: string) => VerificationOperation[];
  automaticVerification: (entry: Operation) => boolean;
  ownerVerification: (entry: Operation) => boolean;
  queueVerification: (repo: string, commitId: string, by: "staging" | "batch" | "background" | "confirm") => string;
  promoteAutomatically: (repo: string) => Promise<void>;
  waitForSlot: (repo: string, due: number) => void;
  releaseEnvironment: (base: string | null, head: string, suites?: readonly string[]) => () => NodeJS.ProcessEnv;
  releaseAlert: (operation: { repo: string; id: string }, headCommitId: string, suites: string[], details: ReleaseAlertDetails) => void;
  recordBatchCheck?: (input: BatchCheckRecord) => Promise<BuildRouteAnswer>;
  batchRouteRetryMs: number;
  prebuildRelease: DeployCapability["prebuildRelease"];
  planRelease: ReleaseCapability["planRelease"];
  gateDrift: (reason: string) => Error;
  isGateDrift: (error: unknown) => boolean;
};

export type BatchOrchestrator = {
  prebuild(repo: string, commitId: string, why: string, note: (line: string) => void, diagnosisSignal?: AbortSignal): Promise<BatchPrebuildHandle | null>;
  requestBatchCheck(repo: string, commitId: string): Promise<VerificationResponse | null>;
  considerBackgroundCheck(repo: string): Promise<void>;
  considerBatch(repo: string, head: string, base: ExecutionPolicy): Promise<void>;
  batchVerify(ctx: BatchVerifyRunContext, spec: BatchVerification, base: string): Promise<OperationEvent>;
  recoverRouting(repo: string): void;
  clearCachesForRepo(repo: string): void;
  stopScheduling(): void;
  drain(): Promise<void>;
  idle(): Promise<void>;
  hasPendingRoutes(): boolean;
};

/**
 * Batch-verification, diagnosis, prebuild, background-check and culprit-routing orchestration (SJ-192 / SJ-202),
 * kept outside `runner-queue.ts` so edits to batch-check logic re-run only the batch-check suite.
 */
export function createBatchOrchestrator(host: BatchOrchestratorHost): BatchOrchestrator {
  const { log, config, executor, environment, now, append, running, stopping, machineBuilds, remoteVerification } = host;

  /**
   * Builds of a commit's production images, by repository and commit: a release check's, or one ahead of a scheduled
   * promotion. They outlive what started them, and a runner shutting down stops them.
   */
  const prebuilds = new Map<string, Promise<PrebuildResult>>();
  type CachedBuild = Exclude<PrebuildResult, { status: "inconclusive" }>;
  type CachedVerdict = { state: "passed" } | { state: "failed"; failure: Pick<Extract<BatchRun, { status: "failed" }>, "failedChecks" | "command" | "failingTests" | "output"> };
  const prebuildCache = new Map<string, CachedBuild>();
  const diagnosisSuiteCache = new Map<string, Map<string, CachedVerdict>>();
  const stopPrebuilds = new AbortController();
  /** The next look at each repository's background check (SJ-202). */
  const backgroundChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /** Culprits whose record is on its way to Forge, so two passes never send one twice at once. */
  const routing = new Set<string>();
  /** Routing in flight, which `idle` waits for. */
  const routes = new Set<Promise<void>>();

  /** How a batch check ended, from its own record; undefined while it has none (it never ran, or predates SJ-192). */
  const batchOutcomeOf = (operationId: string) => log.events({ operationId }).map((row) => row.event)
    .findLast((event): event is Extract<OperationEvent, { type: "batch_outcome" }> => event.type === "batch_outcome");

  /**
   * Production's `prebuild` of `commitId` in `repo`, when its policy declares one and a fixed machine serves its pool;
   * null when nothing can build it ahead of its deploy. A build of that commit already running is shared; one that
   * finished is run again, which the command answers at once when what it built is still there. The build is wrapped, so
   * awaiting this waits for it to start, never to finish.
   */
  async function prebuild(repo: string, commitId: string, why: string, note: (line: string) => void, diagnosisSignal?: AbortSignal): Promise<BatchPrebuildHandle | null> {
    const cacheKey = `${repo}\0${commitId}`;
    // Diagnosis owns its build and can stop it without cancelling a build shared by a head check or scheduled promotion.
    const key = diagnosisSignal ? `${cacheKey}\0diagnosis` : cacheKey;
    const signal = diagnosisSignal ? AbortSignal.any([stopPrebuilds.signal, diagnosisSignal]) : stopPrebuilds.signal;
    const runningBuild = prebuilds.get(key);
    if (runningBuild) return { done: runningBuild };
    const gitDirectory = join(host.repoCheckout(repo), ".git");
    const policy = await readExactExecutionPolicy(gitDirectory, commitId).then((exact) => exact.configuration?.deployments?.environments.production, () => undefined);
    const served = policy?.machine ? machineBuilds[policy.machine] : undefined;
    if (signal.aborted || !policy?.prebuild || !policy.machine || !served) return null;
    const raced = prebuilds.get(key);
    if (raced) return { done: raced };
    const label = `[prebuild] ${repo} ${commitId.slice(0, 12)}`;
    note(`[prebuild] building ${commitId.slice(0, 12)} on ${served.machine} ${why}`);
    const pool = policy.machine;
    const building: Promise<PrebuildResult> = host.prebuildRelease({ gitDirectory, commitId, policy: { ...policy, prebuild: policy.prebuild },
      readEnvironment: environment ?? (() => process.env), abortSignal: signal, run: (request) => executor.run(request),
      lease: () => served.lease({ repo, pool, gitDirectory, commitId, lifetimeS: 2 * Math.ceil(policy.timeoutMs / 1000), signal }) })
      .then((result) => {
        if (!signal.aborted && result.status !== "inconclusive") remember(prebuildCache, cacheKey, result);
        console.error(result.status === "built" ? `${label} finished` : `${label} ${result.status === "failed" ? "failed" : "could not build"}: ${result.reason}`);
        return result;
      })
      .finally(() => { prebuilds.delete(key); });
    prebuilds.set(key, building);
    return { done: building };
  }

  /**
   * A confirm's batch check of `commitId` (SJ-192): the open one stands, and so does a passed or red one measured from
   * the base Production still serves with no promotion since; otherwise one is queued now, whatever the schedule. Null when the release base does not batch.
   */
  async function requestBatchCheck(repo: string, commitId: string): Promise<VerificationResponse | null> {
    const base = await host.releasePolicy(repo, commitId);
    if (base?.process !== "development" || !base.batchVerification) return null;
    const latest = log.verifications(repo, commitId).find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
    // An ended check stands only against the base it measured: a promotion since, or Production serving another commit, makes it stale.
    const current = async (check: VerificationOperation): Promise<boolean> => {
      if (log.releases(repo).some((release) => release.result?.type === "released" && release.submittedAt > check.submittedAt)) return false;
      const started = log.events({ operationId: check.id }).map((row) => row.event).find((event) => event.type === "batch_started");
      return started?.type === "batch_started" && started.base === await host.servedBase(repo, host.repoCheckout(repo));
    };
    if (latest?.status === "running") return { operation: latest, requested: false };
    if (latest && (latest.status === "verified" || batchOutcomeOf(latest.id)?.outcome === "red") && await current(latest)) return { operation: latest, requested: false };
    const id = latest?.status === "queued" ? latest.id : host.queueVerification(repo, commitId, "confirm");
    // The owner's release goes first: keep a red batch's evidence, but stop its diagnosis; automatic checks not yet diagnosing stop outright.
    for (const entry of running.values()) {
      if (entry.operation.kind !== "verification" || entry.operation.repo !== repo || entry.operation.id === id) continue;
      if (entry.stopDiagnosis) {
        entry.stopDiagnosis(`diagnosis stopped for the release of ${commitId.slice(0, 12)} the owner pushed (${id})`);
      } else if (host.automaticVerification(entry.operation)) {
        stopping.set(entry.operation.id, `stopped for the release of ${commitId.slice(0, 12)} the owner pushed (${id}); checked again later`);
        entry.controller.abort();
      }
    }
    return { operation: log.operation(id) as VerificationOperation, requested: latest?.status !== "queued" };
  }

  /**
   * `batchVerification.everyMinutes` (SJ-202): check the newest landing in the background, so a promotion finds an
   * already-checked tip and a red check names its culprit soon after it lands. A check starts when the newest landing
   * has no current coverage (a red head waits for a new landing), no other check, release or production deploy is
   * open, the cadence or recovery interval has passed, and no landing gate is queued or waiting for a place.
   * Asked whenever promotion is, and by its own timer.
   */
  async function considerBackgroundCheck(repo: string): Promise<void> {
    const newest = log.lastLanded(repo);
    if (!newest) return;
    const { base: releaseBase, policy } = await host.releasePolicySnapshot(repo, newest.commitId);
    const batch = policy?.process === "development" && !host.missingPromotion(policy) ? policy.batchVerification : undefined;
    const every = batch?.everyMinutes;
    if (!every) return;
    const later = (ms: number) => {
      clearTimeout(backgroundChecks.get(repo));
      const timer = setTimeout(() => { backgroundChecks.delete(repo); void host.promoteAutomatically(repo); }, Math.max(1_000, ms));
      timer.unref?.();
      backgroundChecks.set(repo, timer);
    };
    if (host.standsFor(repo, newest.commitId)) return;
    const checks = host.currentChecks(repo);
    const own = checks.filter((entry) => entry.commitId === newest.commitId);
    const latestOwn = own[0];
    // A pass from before the release branch moved no longer covers this head. A red head still waits for a new landing.
    if (latestOwn && !(latestOwn.result?.type === "verified" && releaseBase && latestOwn.result.base !== releaseBase)) {
      const outcome = latestOwn.status === "failed" ? batchOutcomeOf(latestOwn.id)?.outcome : undefined;
      if ((outcome !== "flaky" && outcome !== "infrastructure") || own.filter((entry) => entry.status === "failed").length >= BATCH_ATTEMPTS) return;
    }
    if (checks.some((entry) => entry.status === "queued" || entry.status === "running")) return;
    if (log.openOperations(repo).some((entry) => entry.kind === "release" || (entry.kind === "deploy" && entry.environment === "production"))) return later(60_000);
    const last = checks[0];
    const outcome = last?.status === "failed" ? batchOutcomeOf(last.id)?.outcome : undefined;
    const recovering = outcome === "red" || outcome === "flaky" || outcome === "infrastructure";
    const due = last ? (recovering
      ? Date.parse(last.finishedAt ?? last.submittedAt) + (batch?.retryMinutes ?? Math.min(every, 10)) * 60_000
      : Date.parse(last.submittedAt) + every * 60_000) : now();
    if (due > now()) return later(due - now());
    // Landing gates go first: a check waits while one is queued for the lane or for a place on its machine.
    const gateMachine = configuredRepository(config, repo)?.gateMachine;
    if (log.openOperations(repo).some((entry) => entry.kind === "landing" && entry.status === "queued") || (gateMachine && host.machineGatesQueued(gateMachine))) return later(60_000);
    console.error(`[runner] ${repo}: background-checking ${newest.commitId.slice(0, 12)}`);
    host.queueVerification(repo, newest.commitId, "background");
  }

  /**
   * `batchVerification` (SJ-192): the newest landing has no passing batch check. When the scheduled promotion is due,
   * freeze it as the batch head and queue its batch check; before then, ask again at the due time. A red batch waits
   * for a new landing; a flaky or infrastructure failure checks the same head again, a bounded number of times.
   */
  async function considerBatch(repo: string, head: string, base: ExecutionPolicy): Promise<void> {
    if (host.standsFor(repo, head)) return;
    if (log.openOperations(repo).some((entry) => entry.kind === "release" || (entry.kind === "deploy" && entry.environment === "production"))) return;
    if (log.verifications(repo).some((entry) => entry.status === "queued" || entry.status === "running")) return;
    const checks = log.verifications(repo, head);
    const failed = checks.filter((entry) => entry.status === "failed");
    const latest = checks.find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
    if (latest?.status === "failed") {
      const outcome = batchOutcomeOf(latest.id)?.outcome;
      // A red batch (or a failure before the check could run) is answered by a new landing, not by checking it again.
      if (outcome !== "flaky" && outcome !== "infrastructure") return;
      if (failed.length >= BATCH_ATTEMPTS) {
        const line = `Not checking ${head.slice(0, 12)} again: ${failed.length} batch checks of it ended flaky or by infrastructure`;
        if (!log.events({ operationId: latest.id }).some((row) => row.event.type === "progress" && row.event.line === line)) append(latest.id, { type: "progress", line });
        return;
      }
    }
    if (base.promotionSchedule) {
      const last = log.releases(repo).find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
      const due = nextPromotionAt(base.promotionSchedule, last ? Date.parse(last.submittedAt) : undefined, now());
      if (due > now()) {
        host.waitForSlot(repo, due);
        return;
      }
    }
    console.error(`[runner] ${repo}: the scheduled promotion is due; batch-checking ${head.slice(0, 12)}`);
    host.queueVerification(repo, head, "batch");
  }

  /**
   * Record each culprit of a red batch on its own Forge work, once: Forge keys the record by batch and culprit, and
   * the ledger says which it already answered. A culprit Forge has no association for stays reported here only; one
   * Forge could not be reached for is sent again later, and at startup.
   */
  async function routeBatch(operationId: string): Promise<void> {
    const operation = log.operation(operationId);
    const events = log.events({ operationId });
    const outcome = events.map((row) => row.event).findLast((event) => event.type === "batch_outcome");
    const started = events.find((row) => row.event.type === "batch_started");
    const ended = events.findLast((row) => row.event.type === "batch_outcome");
    if (!operation || outcome?.type !== "batch_outcome" || outcome.outcome !== "red" || !started || !ended) return;
    const answered = new Set(events.flatMap((row) => row.event.type === "batch_routed" || row.event.type === "batch_unrouted" ? [row.event.commitId] : []));
    // A culprit's suites an earlier check already routed are not routed again (SJ-202): a later red check of a newer
    // tip names the culprit again until it is repaired, and only a suite it newly breaks is sent.
    const routedBefore = (culprit: NonNullable<typeof outcome.culprits>[number]) => {
      const keys = new Set<string>();
      const by: string[] = [];
      const unassociated: string[] = [];
      for (const other of log.verifications(operation.repo)) {
        if (other.id === operationId) continue;
        const rows = log.events({ operationId: other.id });
        const prior = rows.findLast(({ event }) => event.type === "batch_outcome");
        const earlier = prior?.event;
        const named = earlier?.type === "batch_outcome" ? earlier.culprits?.find((entry) => entry.commitId === culprit.commitId) : undefined;
        if (!named) continue;
        for (const { event } of rows) {
          if ((event.type !== "batch_routed" && event.type !== "batch_unrouted") || event.commitId !== culprit.commitId) continue;
          if (event.type === "batch_routed") {
            for (const key of named.keys) keys.add(key);
            by.push(other.id);
          } else if (prior!.seq < ended.seq && event.operationId === culprit.operationId && /^batch_culprit_unassociated(?::|$)/.test(event.reason)
            && culprit.keys.every((key) => (event.keys ?? named.keys).includes(key))) unassociated.push(other.id);
        }
      }
      return { keys, by, unassociated };
    };
    let retry = false;
    for (const culprit of outcome.culprits ?? []) {
      const key = `${operationId}\0${culprit.commitId}`;
      if (answered.has(culprit.commitId) || routing.has(key)) continue;
      routing.add(key);
      try {
        const reference = { commitId: culprit.commitId, operationId: culprit.operationId };
        const earlier = routedBefore(culprit);
        if (earlier.unassociated.length) {
          append(operationId, { type: "batch_unrouted", ...reference, reason: `already unassociated in batch check ${earlier.unassociated.join(", ")} for ${culprit.keys.join(", ")}` });
          continue;
        }
        const fresh = culprit.keys.filter((key) => !earlier.keys.has(key));
        if (!fresh.length) { append(operationId, { type: "batch_unrouted", ...reference, reason: `already routed by batch check ${earlier.by.join(", ")} for ${culprit.keys.join(", ")}` }); continue; }
        if (!host.recordBatchCheck) { append(operationId, { type: "batch_unrouted", ...reference, reason: "this runner has no Forge route" }); continue; }
        const answer = await host.recordBatchCheck({ repository: operation.repo, batchId: operationId, occurredAt: ended.at, startedAt: started.at, endedAt: ended.at,
          base: outcome.base, head: outcome.head, culprit: reference, failingTests: culprit.failingTests, failedSuites: fresh, command: culprit.command, output: culprit.output });
        if (answer.kind === "accepted") {
          const value = (answer.value ?? {}) as { runId?: unknown; specId?: unknown; number?: unknown; noteId?: unknown };
          append(operationId, { type: "batch_routed", ...reference, specId: String(value.specId ?? ""), number: typeof value.number === "number" ? value.number : null,
            runId: String(value.runId ?? ""), noteId: typeof value.noteId === "string" ? value.noteId : null });
        } else if (answer.kind === "refused") {
          const unassociated = answer.code === "batch_culprit_unassociated";
          append(operationId, { type: "batch_unrouted", ...reference, ...unassociated ? { keys: fresh } : {}, reason: `${answer.code}${answer.message ? `: ${answer.message}` : ""}` });
          if (unassociated) host.releaseAlert(operation, outcome.head, fresh, { event: "batch_culprit_unassociated",
            culprit: reference, failingTests: boundedTests(culprit.failingTests).slice(0, 30), command: culprit.command, output: culprit.output.slice(-4_000) });
        } else retry = true;
      } catch (error) {
        retry = true;
        console.error(`[runner] ${operation.repo}: batch culprit ${culprit.commitId.slice(0, 12)} could not be routed: ${message(error)}`);
      } finally { routing.delete(key); }
    }
    if (retry && !host.isClosed()) setTimeout(() => { if (!host.isClosed()) trackRoute(operationId); }, host.batchRouteRetryMs).unref?.();
  }

  function trackRoute(operationId: string): void {
    const pending = routeBatch(operationId).catch((error: unknown) => console.error(`[runner] batch ${operationId} could not be routed: ${message(error)}`))
      .finally(() => routes.delete(pending));
    routes.add(pending);
  }

  /**
   * The batch check of `operation.commitId`, the frozen head, measured from `base`, the commit Production serves
   * (SJ-192, `release/batch-check.ts`). Each commit it runs at gets a fresh attempt on the held `machine` (the runner
   * host when it has no remote verifier); the complete check and its rerun share the head's. Only a complete green
   * check of the exact head verifies it; anything else fails it, saying how, and a red batch routes its culprits.
   */
  async function batchVerify(ctx: BatchVerifyRunContext, { machine, promoteFlaky }: BatchVerification, base: string): Promise<OperationEvent> {
    const { operation, checkout, controller, progress, setStage, run, authorityError, closeRemote } = ctx;
    const plan = await host.planRelease(checkout, { candidate: operation.commitId }).catch((error: unknown) => error as Error);
    if (plan instanceof Error) return { type: "failed", stage: ctx.stage(), reason: message(plan) };
    if (!plan.commits.length) return { type: "failed", stage: ctx.stage(), reason: `${plan.candidate.slice(0, 12)} is already on ${plan.releaseBranch}` };
    const head = plan.candidate;
    const between = new Set((await jj(checkout, ["log", "--no-graph", "-r", `::${head} ~ ::${base}`, "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean));
    const batch: BatchLanding[] = log.landings(operation.repo).filter((entry) => between.has(entry.commitId)).map((entry) => ({ commitId: entry.commitId, operationId: entry.operationId }));
    // A landing in the batch whose own complete check passed proves every suite there (SJ-202): only the landings after
    // the newest such one can have started a failure, so diagnosis starts after it.
    // A green check whose head could not build (`unproven`) proves nothing about the build, so it bounds no diagnosis.
    const greenChecked = new Set(log.verifications(operation.repo).filter((entry) => {
      const outcome = entry.result?.type === "verified" ? batchOutcomeOf(entry.id) : undefined;
      return outcome?.outcome === "green" && !outcome.unproven?.length;
    }).map((entry) => entry.commitId));
    const after = batch.findLast((entry) => entry.commitId !== head && greenChecked.has(entry.commitId));
    const landings = after ? batch.slice(batch.indexOf(after) + 1) : batch;
    // A machine's release-check place when `machine` names one (SJ-202), otherwise the boat pool `machine`, or the host.
    const held = await ctx.takeCheckPlace(machine, remoteVerification ? `check runs on a ${machine} boat VM` : "check runs on the runner host");
    const checkPlace = held?.place;
    const placed = held ? `machine:${held.machine}` : remoteVerification ? machine : "host";
    const diagnosis = new AbortController();
    const diagnosisSignal = AbortSignal.any([controller.signal, diagnosis.signal]);
    const active = running.get(operation.id)!;
    try {
      append(operation.id, { type: "batch_started", base, head, machine: placed, scheduled: operation.submittedBy.endsWith(":batch"),
        ...operation.submittedBy.endsWith(":background") ? { background: true } : {}, ...after ? { after: after.commitId } : {}, landings });
      progress(`[batch] checking ${batch.length} landing(s) from ${base.slice(0, 12)} to ${head.slice(0, 12)} on ${placed}`
        + (after ? `; ${after.commitId.slice(0, 12)} already passed, so diagnosis considers the ${landings.length} after it` : ""));
      // What the head's deploy will ship builds beside its checks: the build is one of the check's suites (PREBUILD_KEY), so
      // a head whose images cannot build never passes. Only a fixed machine builds it, never boat. A release waiting on this
      // check starts it now; a background check starts it only once the host admits its checks, so a busy host is not
      // handed a build that the check's own admission would have held back.
      const background = operation.submittedBy.endsWith(":background");
      let headBuild = background ? null : await prebuild(operation.repo, head, "beside this check", progress);
      /** Whether the head's build ran in this check, so a green check without a passing build is recorded `unproven`. */
      let builds = headBuild !== null;
      let headSuites: Record<string, SuiteState> = {};
      /** A build, or the operation's kill: a killed or preempted check never waits out a build, and never passes on one. */
      const awaitBuild = async (building: BatchPrebuildHandle | null, signal: AbortSignal): Promise<PrebuildResult | null> => {
        if (!building) return null;
        let onAbort = () => {};
        const aborted = new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          if (signal.aborted) resolve("aborted");
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const result = await Promise.race([building.done, aborted]);
          if (controller.signal.aborted) throw authorityError();
          signal.throwIfAborted();
          return result === "aborted" ? null : result;
        } finally { signal.removeEventListener("abort", onAbort); }
      };
      /** Whether a started build is still running: one that has ended answers before the next turn of the event loop. */
      const stillBuilding = async (building: BatchPrebuildHandle | null) => building !== null
        && await Promise.race([building.done.then(() => false, () => false), new Promise<true>((resolve) => { setImmediate(() => resolve(true)); })]);
      let open: { commit: string; probing: boolean; gate?: BatchGateAttempt; cache?: () => void } | undefined;
      const probeBuilds = new Set<BatchPrebuildHandle>();
      const checksKey = JSON.stringify(plan.checks);
      let budgetTaken = false;
      const releaseMachine = async () => {
        const previous = open;
        open = undefined;
        const discard = previous?.probing && diagnosis.signal.aborted;
        if (previous?.gate) await closeRemote(previous.gate, { discard, wait: true });
        if (!discard) previous?.cache?.();
      };
      /** What `commit`'s build adds to a run: its suite, and its failure when the source did not build. */
      const buildOutcome = (built: PrebuildResult | null): { suites: Record<string, SuiteState>; failed?: Extract<PrebuildResult, { status: "failed" }> } => {
        if (!built) return { suites: {} };
        if (built.status === "inconclusive") {
          progress(`[batch] ${PREBUILD_KEY} could not build, which says nothing about the source: ${built.reason.slice(0, 600)}`);
          return { suites: {} };
        }
        return built.status === "built" ? { suites: { [PREBUILD_KEY]: "passed" } } : { suites: { [PREBUILD_KEY]: "failed" }, failed: built };
      };
      const withBuild = (checks: Exclude<BatchRun, { status: "infrastructure" }>, built: PrebuildResult | null): BatchRun => {
        const { suites: buildSuites, failed } = buildOutcome(built);
        const suites = { ...checks.suites, ...buildSuites };
        if (!failed) return { ...checks, suites };
        const prebuildOutput = boundedOutput(failed.reason);
        return checks.status === "failed"
          ? { ...checks, suites, prebuildOutput, output: boundedOutput(`${checks.output}\n\n${PREBUILD_KEY} (${failed.command}) failed too: ${prebuildOutput}`) }
          : { ...checks, status: "failed", suites, failedChecks: [], failingTests: [], command: failed.command, output: prebuildOutput };
      };
      const runAt = async (commit: string, scope: BatchScope | null, phase: BatchRunRecord["phase"]): Promise<BatchRun> => {
        const probing = phase === "diagnosis";
        const signal = probing ? diagnosisSignal : controller.signal;
        const cacheKey = `${operation.repo}\0${base}\0${checksKey}\0${commit}`;
        const cachedBuild = probing && scope?.suites.includes(PREBUILD_KEY) ? prebuildCache.get(`${operation.repo}\0${commit}`) : undefined;
        if (probing && scope && (!scope.suites.includes(PREBUILD_KEY) || cachedBuild)) {
          const suiteKeys = scope.suites.filter((key) => key !== PREBUILD_KEY);
          const keys = suiteKeys.length ? suiteKeys : scope.checks.map((index) => `check ${index + 1}`);
          const cached = diagnosisSuiteCache.get(cacheKey);
          if (keys.every((key) => cached?.has(key))) {
            const verdicts = keys.map((key) => [key, cached!.get(key)!] as const);
            const suites = Object.fromEntries(verdicts.map(([key, verdict]) => [key, verdict.state]));
            const failures = verdicts.flatMap(([, verdict]) => verdict.state === "failed" ? [verdict.failure] : []);
            const first = failures[0];
            const checks: BatchRun = first ? { status: "failed", ...first, suites,
              failedChecks: [...new Set(failures.flatMap((entry) => entry.failedChecks))],
              failingTests: boundedTests(failures.flatMap((entry) => entry.failingTests)),
              output: boundedOutput([...new Set(failures.map((entry) => entry.output))].join("\n")) } : { status: "passed", suites };
            progress(`[batch] reusing cached diagnosis result for ${commit.slice(0, 12)}`);
            return withBuild(checks, cachedBuild ?? null);
          }
        }
        const startBuild = async () => {
          if (scope && !scope.suites.includes(PREBUILD_KEY)) return null;
          if (commit === head && headBuild) { const started = headBuild; headBuild = null; return started; }
          if (cachedBuild) return { done: Promise.resolve(cachedBuild) };
          const started = await prebuild(operation.repo, commit, commit === head ? "beside this check" : "for this check", progress, probing ? signal : undefined);
          if (probing && started) {
            probeBuilds.add(started);
            void started.done.then(() => probeBuilds.delete(started));
          }
          if (started && commit === head && !scope) builds = true;
          return started;
        };
        // A background check's complete run builds after its admission below; everything else starts building now.
        const deferred = background && !scope;
        let building = deferred ? null : await startBuild();
        // A rerun or diagnosis of the build alone needs no checkout: it frees the check machine and waits on the build.
        if (scope && !scope.checks.length) {
          await releaseMachine();
          return withBuild({ status: "passed", suites: {} }, await awaitBuild(building, signal));
        }
        let setupMs: number | undefined;
        try {
          if (open?.commit !== commit) {
            await releaseMachine();
            const started = Date.now();
            await jj(checkout, ["new", commit]);
            signal.throwIfAborted();
            open = { commit, probing };
            if (checkPlace) {
              open.gate = { attempt: await checkPlace.open({ repo: operation.repo, slot: 0, screening: false, checkout, base, candidate: commit, integrationBranch: ctx.integrationBranch ?? plan.integrationBranch, environment: await ctx.buildCheckEnvironment(), signal,
                onCapacityWait: ctx.capacityProgress(placed as GatePlacement) }), started, placement: placed as GatePlacement };
              append(operation.id, { type: "remote_verification", phase: "ready", machine: open.gate.attempt.machine, placement: placed as GatePlacement, slot: 0, candidate: commit, tree: open.gate.attempt.tree, setupMs: Date.now() - started, usage: null });
            } else if (remoteVerification) open.gate = { attempt: await remoteVerification.open({ repo: operation.repo, slot: 0, pool: machine, checkout, base, candidate: commit, integrationBranch: ctx.integrationBranch ?? plan.integrationBranch, signal })
              .catch((error: RemoteOpenFailure) => {
                if (error?.remote) append(operation.id, { type: "remote_verification", phase: "failed", ...error.remote, reason: error.message.slice(0, 2000) });
                throw error;
              }), started, placement: "boat" };
            if (open.gate && !checkPlace) append(operation.id, { type: "remote_verification", phase: "ready", machine: open.gate.attempt.machine, placement: "boat", slot: 0, pool: machine, candidate: commit, tree: open.gate.attempt.tree, setupMs: Date.now() - started, usage: open.gate.attempt.usage });
            setStage("installing");
            const via = open.gate?.attempt.executor;
            await prepareWorkspaceDependencies(checkout, { quiet: true, runCommand: (request) => run({ ...request, abortSignal: signal }, "dependencies", via), env: host.releaseEnvironment(base, commit)() });
            setupMs = Date.now() - started;
          }
        } catch (error) {
          if (controller.signal.aborted) throw authorityError();
          // The previous commit's checks changed its source: none of this batch's results is evidence.
          if (host.isGateDrift(error)) throw error;
          await releaseMachine().catch(() => undefined);
          return { status: "infrastructure", reason: `setup at ${commit.slice(0, 12)} failed: ${message(error).slice(0, 1000)}` };
        }
        setStage("verifying");
        const via = open!.gate?.attempt.executor;
        const indexes = scope ? scope.checks : plan.checks.map((_, index) => index);
        const runIds: string[] = [];
        let failure: RequiredVerificationError | undefined;
        // Once per check: a later run bisecting its failure waits for nothing but this check's own load to fade. A release
        // waiting on this check goes first, as a landing's gate does, and so does any check on a release-check place, whose
        // slice the machine ranks above agent work: waiting for that work's load to fade only delayed it, by the whole
        // 30 min limit on a busy machine. Only a background check on the runner host leaves room.
        const budgetClass = background && !checkPlace ? "background" : "gate";
        if (!budgetTaken) { budgetTaken = true; await ctx.waitForHostBudget(open!.gate?.placement, budgetClass, signal); }
        // The budget wait returns on an abort rather than throwing: a check stopped while it waited builds nothing.
        if (controller.signal.aborted) throw authorityError();
        signal.throwIfAborted();
        if (deferred) building = await startBuild();
        try {
          await runRequiredVerification({ root: checkout, checks: indexes.map((index) => plan.checks[index]), environment: host.releaseEnvironment(base, commit, scope?.suites.filter((suite) => suite !== PREBUILD_KEY)),
            onProgress: progress, abortSignal: signal,
            run: async (request) => { const result = await run(request, "gate", via); if (result.runId) runIds.push(result.runId); return result; } })
            .then((evidence) => { if (evidence.gaps.length) throw new Error(`release checks did not run in full: ${evidence.gaps.map((gap) => gap.command).join("; ")}`); });
        } catch (error) {
          if (controller.signal.aborted) throw authorityError();
          if (!(error instanceof RequiredVerificationError) || error.evidence.outcome === "spawn_failure")
            return { status: "infrastructure", reason: `release checks at ${commit.slice(0, 12)} could not run: ${message(error).slice(0, 1000)}`, ...setupMs === undefined ? {} : { setupMs } };
          failure = error;
        }
        signal.throwIfAborted();
        // On the host, the checkout must still hold the commit's tree (a boat machine is compared when it is released).
        if (!open!.gate) {
          const drift = await jj(checkout, ["diff", "--from", commit, "--to", "@", "--summary"]);
          if (drift) {
            await jj(checkout, ["restore", "--from", commit, "--into", "@"]);
            throw host.gateDrift(`The release checks changed the source of ${commit.slice(0, 12)}; their results are not evidence for it:\n${drift}`);
          }
        }
        const ran = new Set(runIds);
        const events = log.events({ operationId: operation.id }).map((row) => row.event);
        const setup = setupMs === undefined ? {} : { setupMs };
        if (failure && failure.evidence.failures.length > 0) {
          const finished = new Map(events.flatMap((event) =>
            event.type === "run_finished" && ran.has(event.runId) ? [[event.runId, event] as const] : []));
          if (failure.evidence.failures.every((entry) => {
            if (entry.outcome === "spawn_failure") return true;
            const ownBlock = checkFailureBlock(failure.message, entry.checkIndex);
            const ownText = ownBlock || (failure.evidence.failures.length === 1 ? failure.message : "");
            return isHostResourceExhaustion(ownText, entry.runId ? finished.get(entry.runId) : undefined);
          })) {
            return { status: "infrastructure", reason: `release checks at ${commit.slice(0, 12)} hit host resource limits: ${message(failure).slice(0, 1000)}`, ...setup };
          }
        }
        const suites: Record<string, SuiteState> = {};
        for (const event of events) if (event.type === "test_report" && ran.has(event.runId) && event.status === "recorded")
          for (const entry of event.outcomes ?? []) if (suites[entry.suite] !== "failed") suites[entry.suite] = entry.outcome;
        // A build can run for minutes after the checks end. The check machine is freed before waiting on it, so its memory
        // claim cannot keep out the build it waits for (peach-box, 16 Nov 2026: an idle check held 16 GiB while its build
        // queued for memory). A build that has already ended keeps the machine, which a rerun of this commit reuses.
        if (await stillBuilding(building)) {
          try { await releaseMachine(); } catch (error) {
            if (host.isGateDrift(error)) throw error;
            return { status: "infrastructure", reason: `the check machine at ${commit.slice(0, 12)} could not be released: ${message(error).slice(0, 1000)}`, ...setupMs === undefined ? {} : { setupMs } };
          }
        }
        const built = await awaitBuild(building, signal);
        const checks: Exclude<BatchRun, { status: "infrastructure" }> = failure
          ? { status: "failed", failedChecks: failure.evidence.failures.map((entry) => indexes[entry.checkIndex]!), command: failure.evidence.command,
              suites, failingTests: boundedTests(events.flatMap((event) => event.type === "run_finished" && ran.has(event.runId) ? event.failingTests ?? [] : [])),
              output: boundedOutput(failure.message), ...setup }
          : { status: "passed", suites, ...setup };
        if (phase !== "rerun" && !signal.aborted && !failure?.evidence.failures.some((entry) => entry.outcome !== "nonzero_exit")) {
          const save = () => {
            const cached = diagnosisSuiteCache.get(cacheKey) ?? new Map<string, CachedVerdict>();
            const states = { ...suites };
            // A suite-narrowed run does not prove the verdict of a whole command.
            if (!scope?.suites.some((key) => key !== PREBUILD_KEY)) {
              if (failure) {
                for (const entry of failure.evidence.checks) if (entry.outcome === "passed" || entry.outcome === "failed")
                  states[`check ${indexes[entry.checkIndex]! + 1}`] = entry.outcome;
              } else for (const index of indexes) states[`check ${index + 1}`] = "passed";
            }
            for (const [key, state] of Object.entries(states)) {
              if (key === PREBUILD_KEY) continue;
              if (state === "passed") cached.set(key, { state });
              else if (state === "failed" && checks.status === "failed") {
                const { failedChecks, command, failingTests, output } = checks;
                cached.set(key, { state, failure: { failedChecks, command, failingTests, output } });
              }
            }
            if (cached.size) remember(diagnosisSuiteCache, cacheKey, cached);
          };
          // On a remote place only publish cached verdicts after its final source comparison.
          if (open?.gate) open.cache = save;
          else save();
        }
        return withBuild(checks, built);
      };
      let outcome: Awaited<ReturnType<typeof runBatchCheck>>;
      const notEvidence = (error: unknown): OperationEvent => {
        append(operation.id, { type: "batch_outcome", outcome: "infrastructure", base, head, machine: placed, reason: message(error).slice(0, 2000) });
        return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} is not evidence for it: ${message(error)}` };
      };
      try {
        outcome = await runBatchCheck({ head, landings, diagnosisSignal: diagnosis.signal,
          diagnosisStopReason: () => diagnosis.signal.reason as string | undefined ?? null,
          onDiagnosisStart: () => {
            active.stopDiagnosis = (reason) => diagnosis.abort(reason);
            const waiting = log.verifications(operation.repo).find((entry) => entry.status === "queued" && host.ownerVerification(entry));
            if (waiting) active.stopDiagnosis(`diagnosis stopped for the release of ${waiting.commitId.slice(0, 12)} the owner pushed (${waiting.id})`);
          },
          run: async (commit, scope, phase) => {
            try {
              return await runAt(commit, scope, phase);
            } catch (error) {
              if (!diagnosis.signal.aborted || controller.signal.aborted || host.isGateDrift(error)) throw error;
              return { status: "infrastructure", reason: String(diagnosis.signal.reason) };
            } finally {
              // A cancelled probe owns its build lease; wait for its cleanup before giving up the place.
              if (diagnosis.signal.aborted) await Promise.all([...probeBuilds].map(({ done }) => done));
            }
          },
          onRun: ({ phase, commit, run: result, durationMs }) => {
            if (phase === "complete" && result.status !== "infrastructure") headSuites = result.suites;
            append(operation.id, { type: "batch_run", phase, commit, status: result.status, durationMs,
            ...result.setupMs === undefined ? {} : { setupMs: result.setupMs },
            ...result.status === "failed" ? { keys: boundedKeys(Object.entries(result.suites).filter(([, state]) => state === "failed").map(([suite]) => suite)), failingTests: result.failingTests } : {},
            ...result.status === "infrastructure" ? { reason: result.reason } : {} });
          } }).finally(() => { delete active.stopDiagnosis; });
      } catch (error) {
        await releaseMachine().catch((closing: unknown) => progress(`[batch] the batch machine could not be released: ${message(closing)}`));
        if (host.isGateDrift(error)) return notEvidence(error);
        throw error;
      }
      // Releasing the last machine compares its tree: a check that changed the source, or a machine whose tree cannot be read, proves nothing.
      try { await releaseMachine(); } catch (error) { return notEvidence(error); }
      const recorded = { base, head, machine: placed };
      if (outcome.outcome === "green") {
        append(operation.id, { type: "batch_outcome", outcome: "green", ...recorded, ...builds && headSuites[PREBUILD_KEY] !== "passed" ? { unproven: [PREBUILD_KEY] } : {} });
        return { type: "verified", base: plan.base, candidate: head, checks: plan.checks, nonAdditiveMigrations: plan.nonAdditiveMigrations };
      }
      if (outcome.outcome === "infrastructure") {
        append(operation.id, { type: "batch_outcome", outcome: "infrastructure", ...recorded, reason: outcome.reason });
        return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} did not run (infrastructure, not a regression): ${outcome.reason}` };
      }
      if (outcome.outcome === "flaky") {
        // `promoteFlaky`: a rerun that passed every failed key shows no regression, so it verifies a head whose images built.
        if (promoteFlaky && flakyVerifies(outcome, { ran: builds, complete: headSuites[PREBUILD_KEY] })) {
          append(operation.id, { type: "batch_outcome", outcome: "flaky", ...recorded, keys: boundedKeys(outcome.keys), verified: true });
          progress(`[batch] ${head.slice(0, 12)} was flaky (${outcome.keys.join(", ")} failed once and passed on its rerun); promoteFlaky verifies it`);
          return { type: "verified", base: plan.base, candidate: head, checks: plan.checks, nonAdditiveMigrations: plan.nonAdditiveMigrations };
        }
        append(operation.id, { type: "batch_outcome", outcome: "flaky", ...recorded, keys: boundedKeys(outcome.keys) });
        return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} was flaky: ${outcome.keys.join(", ")} failed, and its rerun passed or failed only other tests; nothing is routed, and the head needs a complete green check before it deploys` };
      }
      const culprits = outcome.culprits.map((culprit) => ({ ...culprit, keys: boundedKeys(culprit.keys), workspace: log.operation(culprit.operationId)?.submittedBy ?? null }));
      const unattributed = outcome.unattributed.map((entry) => ({ ...entry, keys: boundedKeys(entry.keys) }));
      const alreadyRecorded = !culprits.length && unattributed.length > 0 && config.releaseAlertWebhook
        && log.events({ operationId: operation.id }).some(({ event }) => event.type === "batch_outcome" && event.outcome === "red"
          && !event.culprits?.length && Boolean(event.unattributed?.length));
      append(operation.id, { type: "batch_outcome", outcome: "red", ...recorded, keys: boundedKeys(outcome.keys), diagnosis: outcome.diagnosis,
        shorterCandidate: outcome.shorterCandidate, culprits, ...unattributed.length ? { unattributed } : {},
        ...outcome.reason ? { reason: outcome.reason } : {} });
      if (!culprits.length && unattributed.length && !alreadyRecorded) {
        host.releaseAlert(operation, head, boundedKeys(outcome.keys), { event: "batch_unattributed",
          unattributed: unattributed.slice(0, 30).map(({ after, firstFailing, keys }) => ({ after, firstFailing, keys: keys.slice(0, 30) })) });
      }
      // The part of the batch before the first culprit ships only after its own complete check passes.
      const shorter = outcome.shorterCandidate && !log.verifications(operation.repo).some((entry) => entry.status === "queued" && host.ownerVerification(entry))
        ? outcome.shorterCandidate : null;
      if (shorter) host.queueVerification(operation.repo, shorter, "batch");
      trackRoute(operation.id);
      const named = culprits.map((culprit) => `${culprit.commitId.slice(0, 12)} (${culprit.operationId}: ${culprit.keys.join(", ")})`).join("; ");
      const unnamed = outcome.unattributed.map((entry) => `${entry.keys.join(", ")} started failing between ${entry.after?.slice(0, 12) ?? base.slice(0, 12)} and ${entry.firstFailing.slice(0, 12)}, where diagnosis could not run`).join("; ");
      return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} failed: ${outcome.keys.join(", ")}; ${culprits.length ? `culprits ${named}` : "no culprit found"}`
        + (unnamed ? `; unattributed: ${unnamed}` : "")
        + (shorter ? `; ${shorter.slice(0, 12)}, before the first culprit, is checked next` : "") };
    } finally {
      if (checkPlace) ctx.releaseCheckPlace(machine);
    }
  }

  return {
    prebuild,
    requestBatchCheck,
    considerBackgroundCheck,
    considerBatch,
    batchVerify,
    recoverRouting(repo: string) {
      for (const verification of log.verifications(repo)) if (verification.status === "failed") trackRoute(verification.id);
    },
    clearCachesForRepo(repo: string) {
      for (const cache of [prebuildCache, diagnosisSuiteCache])
        for (const key of cache.keys()) if (key.startsWith(`${repo}\0`)) cache.delete(key);
    },
    stopScheduling() {
      for (const timer of backgroundChecks.values()) clearTimeout(timer);
      backgroundChecks.clear();
    },
    async drain() {
      stopPrebuilds.abort();
      await Promise.allSettled(prebuilds.values());
    },
    async idle() {
      await Promise.allSettled([...routes, ...prebuilds.values()]);
    },
    hasPendingRoutes() {
      return routes.size > 0;
    },
  };
}
