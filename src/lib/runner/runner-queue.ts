import { createHash, randomUUID } from "node:crypto";
import { stat, mkdir, realpath, rm } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { type CommandTiming, withCommandTimings, withWorkspaceCommandSignal } from "../infra/workspace-command.ts";
import { sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { candidateBun } from "./candidate-bun.ts";
import { integrateLandingCandidate, prepareLandingCandidate, rollbackFailure, verifyPreparedCandidate, integratePreparedCandidate } from "../landing/landing-candidate.ts";
import type { PreparedLandingCandidate } from "../landing/landing-candidate.ts";
import { importSubmissionSource } from "../landing/submission-source.ts";
import { duplicateLandingSource, retainLandingSource, retainLandingArtifact, importLandingArtifact, RETAINED_ARTIFACT_REVISIONS } from "../landing/landing-artifact.ts";
import type { LandingArtifact } from "../landing/landing-artifact.ts";
import { completeLanding, conflictedPaths, fetchIntegration, fetchIntegrationIfMoved, landingIO } from "../landing/landing-steps.ts";
import { createDeployScheduler } from "../release/deploy-scheduler.ts";
import { createResetScheduler } from "../release/reset-scheduler.ts";
import { auditInconclusive, auditSummary, promotionRefusal } from "../release/audit-ledger.ts";
import { createAuditScheduler } from "../release/audit-scheduler.ts";
import { runReset } from "../release/reset.ts";
import { ensureDeployCommit, ensureOnIntegrationBranch, prebuildRelease, runDeploy, schemaMayHaveChanged } from "../release/deploy.ts";
import { readExactExecutionPolicy } from "../release/post-integration-source.ts";
import { confirmRelease, passedVerification, planRelease, returnRelease, verifyRelease } from "../release/release.ts";
import { boundedKeys, boundedOutput, boundedTests, runBatchCheck, type BatchCheckRecord, type BatchLanding, type BatchRun, type BatchScope, type SuiteState } from "../release/batch-check.ts";
import { RELEASE_BASE_ENV, RELEASE_ENV_KEYS, RELEASE_HEAD_ENV, RELEASE_SUITES_ENV } from "../policy/batch-verification.ts";
import { prepareWorkspaceDependencies } from "../workspace/workspace-dependencies.ts";
import type { BuildRouteAnswer } from "../build/build-admission.ts";
import type { BuildReader } from "../build/tracker.ts";
import { BUILD_CONTEXT_ENV, BUILD_READ_TOKEN_ENV, buildCheckContext } from "../build/build-check-access.ts";
import type { BuildCheckAccess } from "../build/build-check-access.ts";
import { RequiredVerificationError, runRequiredVerification, type RequiredVerificationFailureEvidence } from "../landing/required-verification.ts";
import { readRetainedLogs, readTestReports, TEST_REPORT_DIR_ENV } from "./test-reports.ts";
import { postIntegrationPolicy } from "../policy/post-integration-policy.ts";
import { EXECUTION_POLICY_PATH, readPolicyTextAtCommit, parseExecutionPolicy } from "../policy/execution-policy.ts";
import { settingsLanding } from "../policy/policy-settings.ts";
import { verificationEvidence } from "../policy/verification-policy.ts";
import { describeSchedule, nextPromotionAt } from "../policy/promotion-schedule.ts";
import { admissionLane, admits, AUDIT_INTERRUPTED_REASON, awaitingReplacement, isLandingSubmission, KILLABLE_STAGES, OWNER_KILL_REASON, RUNNER_CONTROL_ID, RUNNER_DEFAULT_SHORT_LANDING_SECONDS, RUNNER_DEFAULT_WORKERS, RUNNER_DEFAULT_DEPLOY_WORKERS, repositoryKey, repositoryLane, RUNNER_JJ_DEFAULTS, recordOf, servedCommit, servedDeploy } from "./runner-contract.ts";
import { label, newOperationId } from "./runner-log.ts";
import type { OperationLogOptions } from "./runner-log.ts";
import { parseFailureOutput } from "./failure-classification.ts";
import { failureProvenance, provenanceSource } from "./failure-provenance.ts";
import { commandEvidence } from "./command-evidence.ts";
import { retainCommandArtifact } from "./command-artifact.ts";
import { redactVerificationOutput } from "../infra/verification-failure.ts";
import { redactMigrationOutput } from "../landing/migration-command-evidence.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import { machineBuildLease, machineVerification } from "./machine-verifier.ts";
import { machinePlaceHolds } from "./machine-place-holds.ts";
import { hostMachine, openHostAttempt } from "./host-verifier.ts";
import { awaitHostBudget, stampHostStart, type HostBudgetClass, type HostShell } from "./host-budget.ts";
import type { AuditOperation, CompletedRelease, DeployOperation, DeployRecord, Executor, KillOutcome, LeaseBuildMachine, MachineVerification, PromotionFacts, LandingOperation, Operation, OperationEvent, OperationLog, RemoteAttempt, RemoteOpenFailure, RemoteVerification, GatePlacement, RunnerConfig, RuntimeIdentity, RunnerHealth, RunnerStage, ReleaseOperation, RecoveryOperation, ResetOperation, RunPurpose, VerificationOperation, VerificationResponse } from "./runner-types.ts";

/** Whether a commit's policy promotes: production deploys from its release branch, which declares its checks. */
const promotesFrom = (configuration: Awaited<ReturnType<typeof readExactExecutionPolicy>>["configuration"] | null): boolean =>
  Boolean(configuration?.deployments?.environments.production && configuration.releaseBranch && configuration.requiredReleaseVerification);

/** Whether a commit's policy skips staging: `process: "development"` releases a verified landing straight to production. */
const skipsStaging = (configuration: { process?: string } | null | undefined): boolean => configuration?.process === "development";

/** How long after the remote could not be read to learn a repository's audit policy the runner tries again. */
const AUDIT_DISCOVERY_RETRY_MS = 600_000;
/**
 * How many times a landing returns to the queue because its remote executor was not ready before any of the candidate's
 * gate commands ran: a slot whose disk boat had not restored. That is infrastructure, not a verdict on the source, but a
 * landing failed it outright and an agent had to notice and resubmit (54 landings failed on boat in the seven days to
 * 3 Nov 2026, 31 of them screening or verifying). A retry waits again on the same VM and forks none, since boat starts
 * are rationed; the attempt past the bound fails the landing as before. An unanswered boat API holds the repository
 * instead (see `holdForBoat`), and a refusal such as a plan limit fails at once.
 */
const REMOTE_UNAVAILABLE_RETRIES = 2;
/** What such a landing yields to, and how the ledger counts the retries it already spent. */
const AWAITING_REMOTE_EXECUTOR = "a remote executor that was not ready";

/** A check changed the source it ran on, or its machine's tree could not be read back: its result is not evidence for that source. */
class GateDrift extends Error {}

/** How long after a recovery of a held integration fails the runner queues another, doubling per failure up to the cap. */
const RECOVERY_RETRY_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 900_000;

const configuredRepository = (config: RunnerConfig, repo: string) =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1];
import { ensureRepoConfig, integrationTrunkConfig, jj, jjGitExecutable, run as workspaceRun, revisionExists, revisionFacts, workspaceContext } from "../infra/workspace-jj.ts";

/**
 * An integration the runner could not finalize or publish. It stays on the runner's
 * integration branch, because the external target may already reflect it, and every
 * later turn retries it first; nothing else lands until it is published.
 */
class HeldIntegration extends Error {
  readonly commitId: string;
  readonly stage: "finalizing" | "publishing";
  readonly output?: string;
  readonly targetReached: boolean;
  constructor(commitId: string, stage: "finalizing" | "publishing", reason: string, output?: string, targetReached = true) {
    super(`${reason}\nThe runner holds ${commitId.slice(0, 12)}, integrated but not published, and retries it before the next landing.`);
    this.commitId = commitId;
    this.stage = stage;
    this.output = output;
    this.targetReached = targetReached;
  }
}

/** A committed candidate policy cannot be finalized; refuse it before running checks. */
class CandidatePolicyRefusal extends Error {}
async function validateCandidatePolicy(checkout: string, commit: string): Promise<void> {
  const text = await readPolicyTextAtCommit(checkout, commit);
  if (text === null) return;
  try { parseExecutionPolicy(text); }
  catch (error) { throw new CandidatePolicyRefusal(`Candidate slipjay.json refused: ${message(error)}`); }
}

/** The owner's kill reached the operation; it ends cancelled, never passed. */
class OwnerKill extends Error {
  constructor() { super(OWNER_KILL_REASON); }
}

/** A verified attempt lost its authoritative remote parent before integration. */
class PrefixInvalidated extends Error {}

/** A pause during remote admission returns the untouched landing to its queue. */
class BoatPaused extends Error {}

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

/** What the log projects waits by: the queue's workers, lanes, depths and short-landing threshold, from the same config. */
export function runnerLogOptions(config: RunnerConfig, executor: Pick<Executor, "combinedLimits">): OperationLogOptions {
  return { workers: runnerWorkers(config, executor), deployWorkers: config.deployWorkers ?? RUNNER_DEFAULT_DEPLOY_WORKERS, separateDeploys: Boolean(executor.combinedLimits), lane: (repo) => repositoryLane(config, repo),
    depth: (repo) => configuredRepository(config, repo)?.verificationDepth ?? 1,
    ...executor.combinedLimits ? { shortLandingP90Ms: (config.shortLandingP90Seconds ?? RUNNER_DEFAULT_SHORT_LANDING_SECONDS) * 1000 } : {} };
}

/**
 * Each repository has one serial lane that owns its warm checkout and every transition
 * of its integration and release branches: its landings, resets of the target landings
 * finalize against, and the publication of its releases take turns in arrival order.
 * A release verifies its pinned candidate first, in a release lane with a checkout of
 * its own, beside the repository's landings (but never beside its reset, nor in a shared
 * lane: see `admissionLane`), and joins the repository lane only to publish. Different repositories share no checkout, branch, target or environment, so
 * their lanes run at once. At most `workers` non-deploy operations run at once, a release counting
 * as one until it has published, besides one more short landing (`admits`); operations
 * that can start are admitted oldest first. Deploys take turns in a separate lane that only reads the warm store, so a
 * deploy that waits minutes on its build never holds a landing.
 *
 * A green staging deploy of a promoting repository queues a pre-verification of its
 * commit in the release lane. It is admitted like a release, oldest first, to one of the
 * same places and never beside a reset, so it neither waits for its repository's landings
 * nor is stopped by one that arrives. It is queued only once its own candidate's staging deploy
 * is green, so newer landings never hold it; a newer green candidate supersedes it while queued.
 */
/** The one file a narrowed landing slot keeps in its working copy (see narrowCheckout). */
const SPARSE_LANDING_PATH = "slipjay.json";

export function createRunnerQueue(input: {
  log: OperationLog; executor: Executor; home: string; config: RunnerConfig;
  environment?: () => NodeJS.ProcessEnv;
  /** Reads Build for a Build-tracked repository's landing check context; absent, those checks get none. */
  readBuild?: BuildReader;
  /** Read-only Build access for a Build-tracked repository's landing checks; absent, the runner has no Build. */
  buildChecks?: BuildCheckAccess;
  /** The first delay before a failed recovery of a held integration is queued again; each further failure doubles it. */
  recoveryRetryMs?: number;
  /** Runs the gate of each repository whose runner entry names a `verifier`; absent, such a repository cannot verify. */
  remoteVerification?: RemoteVerification;
  /** Reaches a host a gate, audit or release check is about to run on (null: this one), to keep its CPU budget (SJ-212); absent, no job waits for it. */
  hostShell?: (machine: string | null) => HostShell;
  /** How often a job waiting for its host's CPU budget reads it again, for embedded runners and tests. */
  hostBudgetPollMs?: number;
  machineVerifications?: Record<string, import("./runner-types.ts").MachineVerification | readonly import("./runner-types.ts").MachineVerification[]>;
  /** The release-check places by the boat pool each serves (SJ-202), for embedded runners and tests; absent, built from `checkPlace`. */
  machineCheckVerifications?: Record<string, import("./runner-types.ts").MachineVerification>;
  /** Stands in for the machines `config.machines` names as a `buildPool`, by pool. */
  machineBuilds?: Record<string, { machine: string; lease: LeaseBuildMachine }>;
  /** First availability probe after a boat outage; doubles up to one minute. */
  boatProbeMs?: number;
  /** Override pre-verification stage deadlines (milliseconds), for embedded runners and tests. */
  verificationStageTimeoutMs?: number;
  /** The clock a `promotionSchedule` is read against; `Date.now` when absent. */
  now?: () => number;
  /**
   * Records a batch-check culprit on its Forge work (Forge's `recordBatchCheck` runner action, SJ-192); absent, a
   * culprit is reported on the batch record only.
   */
  recordBatchCheck?: (input: BatchCheckRecord) => Promise<BuildRouteAnswer>;
  /** How long after Forge could not be reached a culprit is sent again. */
  batchRouteRetryMs?: number;
}): {
  wake(): void; recover(): Promise<void>; idle(): Promise<void>;
  /** A confirm's batch check of a commit under `batchVerification`; null for a repository that does not batch. */
  requestBatchCheck(repo: string, commitId: string): Promise<VerificationResponse | null>;
  /**
   * Start nothing more, now or later in this process: recovery could not stop the commands a previous process left, so
   * no checkout is safe to reuse. The runner still answers reads; a restart is what clears it.
   */
  hold(reason: string): void;
  /**
   * Queue the recovery of `repo`'s held integration, unless one is queued or running: that operation, or null when nothing is held.
   */
  recoverHeld(repo: string): Operation | null;
  releaseHeld(repo: string, by: string): Promise<{ ok: boolean; reason: string }>;
  /**
   * Stop admitting work and resolve once no operation is integrating, finalizing, publishing, deploying or recovering a held
   * integration. Work before integration is not waited for: a restart records it failed ("land again") with nothing published.
   */
  drain(): Promise<void>;
  /** Delete the remote candidate of a landing cancelled while queued, after the running turn. */
  cancelled(operation: Operation): void;
  /** Stop scheduling deploys and resets: clears timers that are waiting for an interval. */
  close(): void;
  /**
   * Kill a running landing, release or reset while it is in KILLABLE_STAGES, or a boat-held queued landing.
   * Without a name, kill the only running operation, or the only held landing when none runs. Ambiguity kills none.
   */
  kill(operationId?: string): KillOutcome;
  logPath(operationId: string): string; readLog(operationId: string): Promise<string | null>;
} {
  const { log, executor, home, config, environment, readBuild, buildChecks, recoveryRetryMs = RECOVERY_RETRY_MS, remoteVerification, boatProbeMs = 5000, verificationStageTimeoutMs } = input;
  if (Object.values(config.repos).some((repo) => repo.verifier) && !remoteVerification) throw new Error("A repository names a remote verifier, but the runner has none");
  if (Object.values(config.repos).some((repo) => repo.verificationDepth === 2 && !repo.verifier) && !executor.combinedLimits)
    throw new Error("Depth-two verification requires an executor with enforced combined resource limits");
  type BoatHold = { failures: number; timer?: ReturnType<typeof setTimeout>; controller?: AbortController };
  const boatHolds = new Map<string, BoatHold>();
  for (const { event } of log.events()) if (event.type === "boat_circuit") {
    if (event.state === "open") boatHolds.set(event.repo, { failures: 0 });
    else boatHolds.delete(event.repo);
  }
  for (const repo of boatHolds.keys()) if (configuredRepository(config, repo)?.verifier !== "boat") {
    boatHolds.delete(repo);
    log.append(RUNNER_CONTROL_ID, { type: "boat_circuit", repo, state: "closed", reason: "Repository no longer verifies on boat" });
  }
  let closed = false;
  function probeBoat(repo: string): void {
    const hold = boatHolds.get(repo);
    if (!hold || !remoteVerification?.probe || hold.timer || hold.controller || closed || draining || heldStart) return;
    hold.timer = setTimeout(() => {
      hold.timer = undefined;
      const controller = new AbortController();
      hold.controller = controller;
      void remoteVerification!.probe!(controller.signal).then(() => {
        if (controller.signal.aborted) return;
        boatHolds.delete(repo);
        append(RUNNER_CONTROL_ID, { type: "boat_circuit", repo, state: "closed", reason: "Boat API answers again" });
        wakeMain();
      }, () => { hold.failures += 1; }).finally(() => {
        hold.controller = undefined;
        probeBoat(repo);
      });
    }, Math.min(60_000, boatProbeMs * 2 ** Math.min(hold.failures, 16)));
    hold.timer.unref?.();
  }
  function holdForBoat(repo: string, reason: string): void {
    if (!boatHolds.has(repo)) {
      boatHolds.set(repo, { failures: 0 });
      append(RUNNER_CONTROL_ID, { type: "boat_circuit", repo, state: "open", reason, ...configuredRepository(config, repo)?.hostPlaces === 1 ? { hostPlace: true as const } : {} });
    }
    probeBoat(repo);
  }
  const workers = runnerWorkers(config, executor);
  const deployWorkers = config.deployWorkers ?? RUNNER_DEFAULT_DEPLOY_WORKERS;
  if (!executor.combinedLimits && deployWorkers > 1) throw new Error("Multiple deploy workers require an executor with enforced combined resource limits");
  const activeDeploys = new Map<string, { repo: string; pending: Promise<void> }>();
  /** Each lane's work holding its checkouts now, and any chained behind it, by `admissionLane`. */
  const lanes = new Map<string, Promise<void>>();
  const laneOf = (repo: string) => repositoryLane(config, repo);
  /** Worker reservations, including operations whose lane callback has not started yet. */
  const admitted = new Map<string, Operation>();
  /** The admitted landings that were short when admitted: they count toward `workers + 1` only, until they finish. */
  const shortAdmitted = new Set<string>();
  const shortPlace = Boolean(executor.combinedLimits);
  const places = () => [...[...admitted.keys()].map((id) => ({ short: shortAdmitted.has(id) })),
    ...(executor.combinedLimits ? [] : [...activeDeploys.values()].map(() => ({ short: false })))];
  /** Whether `operation`, not a depth-two successor, would be admitted as a short landing. */
  const isShort = (operation: Operation) => shortPlace && operation.kind === "landing" && log.shortRepository(operation.repo);
  // Queue-owned runtime attempts; their immutable evidence lives in the existing log.
  type PreparedPrefix = { artifact: LandingArtifact; checkout: string; overlap: boolean };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };
  type PrefixTurn = { operation: LandingOperation; slot: number; attempt: number; prepared: ReturnType<typeof deferred<PreparedPrefix | null>>;
    completed: ReturnType<typeof deferred<boolean>>; invalidation: AbortController; predecessor?: PrefixTurn; remoteRebuilt?: boolean; screenSlot?: number;
    overlap?: boolean;
    /** The exact base this attempt prepared on, once prepared. */
    base?: string;
    /** The landing whose publication moved the tip past this screen's base, ending this attempt now. */
    overtakenBy?: string;
    screen?: { phase: "preparing" | "screening" | "passed" | "authoritative"; ready: ReturnType<typeof deferred<void>>; passedAt?: number } };
  const prefixes = new Map<string, PrefixTurn[]>();
  const screens = new Map<string, PrefixTurn>();
  let screenPassOrder = 0;
  /** Named places are shared by every repository that names the same machine. */
  const machinePlaces: Record<string, readonly MachineVerification[]> = input.machineVerifications
    ? Object.fromEntries(Object.entries(input.machineVerifications).map(([name, places]) => [name, Array.isArray(places) ? places : [places]]))
    : Object.fromEntries(Object.entries(config.machines ?? {}).map(([name, entry]) =>
      [name, Array.from({ length: entry.places ?? 1 }, (_, place) => machineVerification(name, entry, { scratch: join(home, "scratch"), place }))]));
  const machineGates = machinePlaceHolds();
  /**
   * The release-check places (SJ-202), by the boat pool each serves, with the machine it is on: gates never use one, and
   * one release check or audit holds it at a time.
   */
  const machineChecks: Record<string, { machine: string; place: MachineVerification }> = input.machineCheckVerifications
    ? Object.fromEntries(Object.entries(input.machineCheckVerifications).map(([pool, place]) => [pool, { machine: pool, place }]))
    : Object.fromEntries(Object.entries(config.machines ?? {}).flatMap(([name, entry]) => entry.checkPlace
      ? [[entry.checkPlace, { machine: name, place: machineVerification(name, entry, { scratch: join(home, "scratch"), check: true }) }]] : []));
  const machineCheckHolds = machinePlaceHolds();
  /** The fixed machines that build for a pool, tried before boat (`buildPool`). */
  const machineBuilds = input.machineBuilds ?? Object.fromEntries(Object.entries(config.machines ?? {}).flatMap(([name, entry]) => entry.buildPool
    ? [[entry.buildPool, { machine: name, lease: machineBuildLease(name, entry, { scratch: join(home, "scratch") }) }]] : []));
  /** Builds started beside a release's check. They outlive the check, and a runner shutting down stops them. */
  const prebuilds = new Set<Promise<void>>();
  const stopPrebuilds = new AbortController();
  /** A down place is recorded on the runner's own record once per outage, and logged, so boat use is never silent. */
  const machinePlaceDown = (name: string, reason: string) => {
    const last = log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "machine_place" && row.event.name === name)?.event;
    if (last?.type === "machine_place" && last.state === "down") return;
    append(RUNNER_CONTROL_ID, { type: "machine_place", name, state: "down", reason });
    console.error(`[runner] machine place ${name} is down: ${reason}; YardSmith gates use boat until it recovers`);
  };
  const machinePlaceUp = (name: string) => {
    const last = log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "machine_place" && row.event.name === name)?.event;
    if (last?.type === "machine_place" && last.state === "down") append(RUNNER_CONTROL_ID, { type: "machine_place", name, state: "up", reason: "recovered" });
  };
  // Quarantine recovery is independent of admission: a boat hold must not prevent a machine reopening.
  const machineRecovery = Object.keys(machinePlaces).length || Object.keys(machineChecks).length ? setInterval(() => {
    if (closed || draining || heldStart) return;
    for (const [name, places] of Object.entries(machinePlaces)) places.forEach((place, index) => {
      if (!machineGates.holds(name, index) && !place.available())
        void place.recover?.([]).then(() => { if (place.available()) { machinePlaceUp(name); wakeMain(); } }).catch(() => undefined);
    });
    // A release-check place starts quarantined like a gate place, and reopens the same way (SJ-202).
    for (const [pool, { machine, place }] of Object.entries(machineChecks))
      if (!machineCheckHolds.anyHeld(pool) && !place.available())
        void place.recover?.([]).then(() => { if (place.available()) { machinePlaceUp(machine); wakeMain(); } }).catch(() => undefined);
  }, 5000) : undefined;
  machineRecovery?.unref?.();
  const machinePlaceFree = (repo: string) => {
    const name = configuredRepository(config, repo)?.gateMachine;
    return Boolean(name && machinePlaces[name]?.some((place, index) => !machineGates.holds(name, index) && place.available()));
  };
  /** Each repository's runner-host gate place (`hostPlaces`, SJ-189): the operation whose gate holds it. */
  const hostGates = new Map<string, string>();
  const hostPlaceFree = (repo: string) => configuredRepository(config, repo)?.hostPlaces === 1 && !hostGates.has(repositoryKey(repo));
  /**
   * Whether `repo`'s boat hold keeps its landings from starting. The hold applies to boat-placed gates only: while the
   * repository's host place is free and none of its landings is already in flight to take it first, one more may start,
   * and its gate takes that place.
   */
  const heldForBoat = (repo: string): boolean => boatHolds.has(repo) && !((hostPlaceFree(repo) || machinePlaceFree(repo))
    && ![...admitted.values(), ...[...screens.values()].map((turn) => turn.operation), ...prefixes.get(repo)?.map((turn) => turn.operation) ?? []]
      .some((entry) => entry.kind === "landing" && repositoryKey(entry.repo) === repositoryKey(repo)));
  /** Landings whose source conflicts with the prefix predicted for them: they screen on the tip alone. */
  const unpredicted = new Set<string>();
  /** Landings already sent back once because a publication moved past their screen's base: a later move costs a rebuild, as before. */
  const overtakenOnce = new Set<string>();
  /**
   * The predicted prefix a new screen of `repo` runs behind: the latest-started screen still
   * expected to publish, so a landing that lands as predicted publishes on its own screen's
   * evidence (Decision #6144). None for a landing that conflicted with its prediction, and none
   * behind a screen whose prefix a dependent cannot overlap (a migration or policy change).
   */
  function predictedPrefix(repo: string, operation: LandingOperation): PrefixTurn | undefined {
    if (unpredicted.has(operation.id)) return undefined;
    const alive = [...screens.values()].filter((turn) => turn.operation.repo === repo && turn.operation.id !== operation.id
      && !turn.invalidation.signal.aborted);
    const tail = alive.at(-1);
    return tail && tail.overlap !== false ? tail : undefined;
  }
  /**
   * A publication just moved `repo`'s integration tip to `tip`. A screen on the tip alone (no predicted
   * prefix) that prepared on an older base can no longer publish what it verifies: it would run to the
   * end and then rebuild. Stop it now: it returns to the queue and screens again on the new tip, taking a
   * place and a prediction like any new screen. Each landing is sent back this way at most once, so a busy
   * lane cannot keep restarting a slow screen.
   */
  function restartOvertakenScreens(repo: string, publishedBy: string, tip: string): void {
    for (const turn of screens.values()) {
      if (turn.operation.repo !== repo || turn.operation.id === publishedBy || turn.predecessor || overtakenOnce.has(turn.operation.id)
        || turn.invalidation.signal.aborted || !turn.base || turn.base === tip
        || (turn.screen?.phase !== "preparing" && turn.screen?.phase !== "screening")) continue;
      turn.overtakenBy = publishedBy;
      overtakenOnce.add(turn.operation.id);
      turn.invalidation.abort();
    }
  }
  const attempts = new Set<Promise<void>>();
  /** Running landings, releases and resets, by operation, in their current stage. */
  const running = new Map<string, { operation: Operation; stage: RunnerStage; controller: AbortController }>();
  /** Operations whose turn has ended and whose settlement is still writing: live to nothing, and not killable. */
  const ending = new Set<string>();
  const health = (): RunnerHealth => ({ load1: Math.round(loadavg()[0]! * 100) / 100, cpus: availableParallelism(),
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), running: running.size });
  /** Recovery holds every lane: nothing is admitted until it finishes. */
  let recovering: Promise<void> | undefined;
  /** Why nothing may start at all: a recovery that failed left commands of a previous process unaccounted for. */
  let heldStart: string | undefined;
  /** Set once the process was told to stop: nothing new is admitted, and the runner exits when no operation is past the point a kill may stop it. */
  let draining = false;
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
  const checkoutPath = (operation: Operation) => operation.kind === "release" || operation.kind === "verification" ? join(home, "releases", operation.repo) : repoCheckout(operation.repo);
  /**
   * The temporary directory of every gate command run in `checkout`, emptied at each turn.
   * It isolates a checkout's temporary state from other operations', including any lock a
   * gate keeps there: the runner's own limits bound concurrent runs together.
   */
  const scratchOf = (checkout: string) => join(tmpdir(), `slipjay-${createHash("sha256").update(checkout).digest("hex").slice(0, 12)}`);
  /** Keeps only slipjay.json in a landing slot's working copy; a no-op when it already holds just that. */
  async function narrowCheckout(checkout: string): Promise<void> {
    if ((await jj(checkout, ["sparse", "list"])).trim() !== SPARSE_LANDING_PATH) await jj(checkout, ["sparse", "set", "--clear", "--add", SPARSE_LANDING_PATH]);
  }
  /** Restores every file to a slot narrowed for a remote-verifier landing, for work that needs them here. */
  async function widenCheckout(checkout: string): Promise<void> {
    if ((await jj(checkout, ["sparse", "list"])).trim() !== ".") await jj(checkout, ["sparse", "reset"]);
  }
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
  // Each checkout's repository config, set once per process: the runner is its only writer, and reading it back on every
  // turn cost a jj process (SJ-200). A checkout cloned again starts unconfigured.
  const configured = new Map<string, string>();
  async function configureCheckout(checkout: string, settings: Readonly<Record<string, string>>): Promise<void> {
    const key = JSON.stringify(settings);
    if (configured.get(checkout) === key) return;
    await ensureRepoConfig(checkout, settings);
    configured.set(checkout, key);
    gits.delete(checkout);
  }
  // The Git jj runs in each checkout, read once with its config: Git run beside jj must reach the remotes jj reaches.
  const gits = new Map<string, Promise<string>>();
  const gitOf = (checkout: string): Promise<string> => {
    let git = gits.get(checkout);
    if (!git) gits.set(checkout, git = jjGitExecutable(checkout));
    return git;
  };
  async function cleanup(operation: LandingOperation, checkout: string, remote: string): Promise<void> {
    // A replacement of a running screen owns the same remote bookmark now.
    if (log.operationsForChange(operation.repo, operation.changeId).some((entry) => entry.id !== operation.id
      && entry.bookmark === operation.bookmark && (entry.status === "queued" || entry.status === "running"))) return;
    // One round trip deletes the candidate from the remote, whether or not this checkout ever fetched it; one already
    // gone is deleted. Through jj it was a fetch, a track, a delete and a push, about 5 s of a landing's tail (SJ-200).
    // The lease is the submitted commit, as jj's push leased the position it fetched: an author who has since pushed a
    // newer candidate to the bookmark keeps it.
    // jj's own Git repository: a checkout need not be colocated, and Git run in it would find whatever repository encloses it.
    const ref = `refs/heads/${operation.bookmark}`;
    const gitDirectory = await jj(checkout, ["--ignore-working-copy", "git", "root"]).catch(() => undefined);
    const deleted = gitDirectory
      ? await workspaceRun(await gitOf(checkout), ["--git-dir", gitDirectory, "push", "--quiet", `--force-with-lease=${ref}:${operation.commitId}`, remote, "--delete", ref], { cwd: checkout })
      : { code: 1, stdout: "", stderr: "the checkout's Git repository could not be found" };
    if (deleted.code !== 0 && !/remote ref does not exist/i.test(deleted.stderr))
      append(operation.id, { type: "progress", line: `Candidate bookmark cleanup failed: ${(deleted.stderr || deleted.stdout).trim()}` });
    // Leave no local copy behind either: a resubmission fetches the candidate afresh.
    await jj(checkout, ["bookmark", "forget", "--include-remotes", operation.bookmark]).catch(() => {});
  }
  /** The release branch's policy: at the base a pre-verification ran against, never the candidate's; else at the branch's head. */
  async function releasePolicy(repo: string, commitId: string, ranAgainst?: string) {
    const directory = repoCheckout(repo);
    const candidate = await readExactExecutionPolicy(join(directory, ".git"), commitId).then((exact) => exact.configuration, () => null);
    // The release checkout exists once a first pre-verification or release ran; before that the landing checkout holds the branch.
    const releases = join(home, "releases", repo);
    const checkout = await stat(releases).then(() => releases, () => directory);
    if (ranAgainst) return readExactExecutionPolicy(join(checkout, ".git"), ranAgainst).then((exact) => exact.configuration, () => null);
    let policy = candidate;
    if (!policy?.releaseBranch) {
      // A candidate removing the release branch must still use the release policy of the integration
      // parent it extended. Only a repository already without a release branch uses its own policy.
      // A read: it never snapshots the landing checkout, which a turn may be working in.
      const parents = (await jj(directory, ["--ignore-working-copy", "log", "-r", `${commitId}-`, "--no-graph", "-T", 'commit_id ++ "\\n"']).catch(() => "")).trim().split("\n").filter(Boolean);
      if (parents.length !== 1) return null;
      const previous = await readExactExecutionPolicy(join(directory, ".git"), parents[0]!).then((exact) => exact.configuration, () => null);
      if (!previous) return null;
      if (!previous.releaseBranch) return candidate;
      policy = previous;
    }
    // A read as well: background checks ask for the policy beside landings and recovery working in this checkout.
    const releaseBase = await jj(checkout, ["--ignore-working-copy", "log", "-r", `${policy.releaseBranch}@${policy.remote ?? "origin"}`, "--no-graph", "-T", "commit_id"]).catch(() => "");
    return releaseBase ? readExactExecutionPolicy(join(checkout, ".git"), releaseBase).then((exact) => exact.configuration, () => null) : null;
  }
  function reportPolicy(repo: string, configuration: Awaited<ReturnType<typeof releasePolicy>>, applied: Awaited<ReturnType<typeof releasePolicy>>): void {
    if (!configuration) return;
    const policy = { integrationBranch: configuration.integrationBranch ?? "main", releases: Boolean(configuration.releaseBranch && configuration.deployments?.environments.production),
      stagingSkipped: skipsStaging(applied), staging: Boolean(configuration.deployments?.environments.staging), promotionAudit: Boolean(applied?.audit), images: Boolean(configuration.deployments?.environments.images), audit: configuration.audit ? { timeOfDay: configuration.audit.timeOfDay, timeZone: configuration.audit.timeZone } : null };
    const previous = log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "repository_policy" && row.event.repo === repo)?.event;
    if (previous?.type !== "repository_policy" || JSON.stringify(previous.policy) !== JSON.stringify(policy)) append(RUNNER_CONTROL_ID, { type: "repository_policy", repo, policy });
  }
  /** Whether the release branch's policy skips staging for this commit: a candidate cannot switch the mode on for itself. */
  const stagingSkipped = async (repo: string, commitId: string): Promise<boolean> => skipsStaging(await releasePolicy(repo, commitId));
  /** What a landing records of the environments its commit declares; nothing when the policy cannot be read. */
  async function declaredEnvironments(repo: string, commitId: string, readPolicy = readExactExecutionPolicy): Promise<{ repo: string; declaredEnvironments: string[]; process?: "development" | "standard" } | Record<string, never>> {
    try {
      const { configuration } = await readPolicy(join(repoCheckout(repo), ".git"), commitId);
      if (!configuration) return {};
      const applied = await releasePolicy(repo, commitId);
      const skipped = skipsStaging(applied);
      reportPolicy(repo, configuration, applied);
      return { repo, ...applied ? { process: skipped ? "development" as const : "standard" as const } : {}, declaredEnvironments: Object.keys(configuration.deployments?.environments ?? {}).filter((name) => name !== "staging" || !skipped).sort() };
    } catch { return {}; }
  }
  /** Ask the schedulers about every environment and the reset the commit declares; they decide whether one is due. */
  async function schedule(repo: string, commitId: string, readPolicy = readExactExecutionPolicy): Promise<void> {
    const { configuration } = await readPolicy(join(repoCheckout(repo), ".git"), commitId);
    const applied = await releasePolicy(repo, commitId);
    const skipped = skipsStaging(applied);
    reportPolicy(repo, configuration, applied);
    if (configuration?.deployments) scheduler.consider(repo, skipped
      ? Object.fromEntries(Object.entries(configuration.deployments.environments).filter(([name]) => name !== "staging")) : configuration.deployments.environments);
    // Without a staging deploy to follow, the landing itself is what gets pre-verified, unless the release branch
    // batches its checks (SJ-192): then the next scheduled promotion checks the batch, and is armed now.
    const batched = skipped && Boolean(applied?.batchVerification);
    if (skipped && promotesFrom(configuration) && !batched && !log.verifications(repo, commitId).length) queueVerification(repo, commitId);
    if (batched && promotesFrom(configuration)) void promoteAutomatically(repo);
    resetScheduler.consider(repo, configuration?.reset ?? null);
    auditScheduler.consider(repo, configuration?.audit ?? null);
  }
  /**
   * Learn what the integration head on the remote declares for the audit and consider it, without any landing in the
   * ledger to name a commit: a repository this runner never landed in audits all the same. It runs in the repository's
   * lane, which it holds only to clone and fetch, so the warm checkout is never read while a landing moves it.
   */
  async function discoverAudit(repo: string): Promise<void> {
    const repository = configuredRepository(config, repo);
    if (!repository) return;
    await inLane(laneOf(repo), async () => {
      const checkout = repoCheckout(repo);
      if (!await stat(checkout).then(() => true, () => false)) {
        await mkdir(dirname(checkout), { recursive: true });
        await jj(dirname(checkout), ["git", "clone", repository.url, checkout]);
        configured.delete(checkout);
      }
      const context = await workspaceContext(checkout, undefined, { fetchMissingBookmarks: true });
      if (!context) throw new Error("Runner checkout is unavailable");
      const remote = context.configuration.remote ?? "origin";
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", context.integrationBranch]);
      const head = (await revisionFacts(checkout, `${context.integrationBranch}@${remote}`)).commitId;
      knownHeads.set(repo, head);
      const configuration = (await readExactExecutionPolicy(join(checkout, ".git"), head)).configuration;
      reportPolicy(repo, configuration, await releasePolicy(repo, head));
      auditScheduler.consider(repo, configuration?.audit ?? null);
    });
  }
  /** Discover each configured repository's audit; one the remote could not be read for is tried again later. */
  function discoverAudits(repos: readonly string[]): void {
    for (const repo of repos) {
      clearTimeout(auditDiscovery.get(repo));
      const pending: Promise<void> = discoverAudit(repo).then(() => wakeMain(), () => {
        const retry = setTimeout(() => { auditDiscovery.delete(repo); discoverAudits([repo]); }, AUDIT_DISCOVERY_RETRY_MS);
        retry.unref?.();
        auditDiscovery.set(repo, retry);
      }).finally(() => { discoveries.delete(pending); });
      discoveries.add(pending);
    }
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
  const auditScheduler = createAuditScheduler({
    log,
    submit(repo, slot) {
      const known = log.lastLanded(repo)?.commitId ?? knownHeads.get(repo) ?? log.audits(repo)[0]?.head ?? "";
      log.append(newOperationId(), { type: "submitted", kind: "audit", repo, commitId: known, slot: new Date(slot).toISOString(), submittedBy: `${executor.host}:schedule` });
      wakeMain();
    },
  });
  const auditDiscovery = new Map<string, ReturnType<typeof setTimeout>>();
  /** The integration head discovery last saw, which labels an audit of a repository that never landed here. */
  const knownHeads = new Map<string, string>();
  const discoveries = new Set<Promise<void>>();
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
    // Without a shared resource budget, deploys compete in the same arrival-ordered queue.
    if (!executor.combinedLimits) { wakeMain(); return; }
    if (deployPending) return;
    deployPending = true;
    deploying = deploying.then(() => { deployPending = false; return deployLoop(); });
  }
  /** Whether an audit runs on this host, which no deploy starts beside (see `startable`). */
  const auditRunning = (): boolean => [...admitted.values()].some((entry) => entry.kind === "audit");
  function deployLoop(): void {
    for (;;) {
      // Recovery settles the commands a previous process left, deploys included: they wait for it as landings do.
      if (log.paused() || draining || recovering || heldStart) return;
      const operation = activeDeploys.size < deployWorkers && !auditRunning()
        ? log.openOperations().find((entry): entry is DeployOperation => entry.kind === "deploy" && entry.status === "queued"
          && ![...activeDeploys.values()].some((active) => repositoryKey(active.repo) === repositoryKey(entry.repo))) : undefined;
      if (operation) {
        admitDeploy(operation);
        continue;
      }
      return;
    }
  }
  function admitDeploy(operation: DeployOperation): void {
    const pending = processDeploy(operation).catch((error: unknown) => {
      // Preserve an existing verdict if only its follow-up scheduling failed.
      try {
        append(operation.id, log.operation(operation.id)?.result
          ? { type: "progress", line: message(error) }
          : { type: "failed", stage: "deploying", reason: message(error) });
      } catch (reportError) {
        console.error(`[runner] deploy ${operation.id}: ${message(error)}; could not record failure: ${message(reportError)}`);
      }
    }).finally(() => { activeDeploys.delete(operation.id); wakeMain(); wakeDeploys(); });
    activeDeploys.set(operation.id, { repo: operation.repo, pending });
  }
  async function processDeploy(operation: DeployOperation): Promise<void> {
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    let verdict: OperationEvent;
    append(operation.id, { type: "stage", stage: "deploying" });
    let promotes = false;
    const deployStartedAt = new Date().toISOString(), deployStarted = performance.now();
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
      promotes = promotesFrom(exact.configuration);
      // The environment served a commit once any of its projects served it.
      const others = log.deployments(operation.repo, operation.environment).filter((entry) => entry.id !== operation.id);
      const earlier = others.map((entry) => ({ entry, record: recordOf(entry) }));
      const previous = servedCommit(others);
      // A production deploy no promotion carries is a redeploy (see /deploys): it deploys only what production serves when it starts.
      if (operation.environment === "production" && !operation.promotion && operation.commitId !== previous)
        throw new Error(`production serves ${previous ? previous.slice(0, 12) : "nothing"} now, not ${operation.commitId.slice(0, 12)}: nothing redeployed`);
      const previousUrls = Object.fromEntries(policy.projects.flatMap(({ name }) => {
        const url = earlier.flatMap(({ record }) => record?.projects ?? []).find((project) => project.name === name && servedDeploy(project))?.url;
        return url ? [[name, url]] : [];
      }));
      const manual = operation.promotion?.nonAdditiveMigrations ?? [];
      // A closed deploy of this commit with no record (a restart or crash cut it short) may have applied them too: nothing says it did not.
      const earlierSchemaChange = earlier.some(({ entry, record }) => entry.commitId === operation.commitId && entry.result
        && (!record || record.migrations?.status === "applied" || record.migrations?.status === "apply_failed"));
      const record = await runDeploy({
        gitDirectory: exact.gitDirectory, environment: operation.environment, commitId: operation.commitId, previous, policy, redeploy: !operation.promotion,
        previousUrls, nonAdditive: manual.length > 0, earlierSchemaChange, migrationArtifacts: operation.promotion?.migrationArtifacts ?? [],
        readEnvironment: environment ?? (() => process.env), onProgress: progress,
        // The deploy lane runs one deploy per repository, so a repository's machine serves one deploy at a time. Its
        // lifetime covers the steps before a build (migrations) and the build itself, each bounded by the timeout.
        ...remoteVerification?.lease || Object.keys(machineBuilds).length ? { lease: async (pool: string) => {
          const lease = { repo: operation.repo, pool, gitDirectory: exact.gitDirectory, commitId: operation.commitId, lifetimeS: 2 * Math.ceil(policy.timeoutMs / 1000) };
          const served = machineBuilds[pool];
          if (served) {
            try { return await served.lease(lease); } catch (error) {
              if (!remoteVerification?.lease) throw error;
              progress(`warning: ${served.machine} cannot build for this deploy (${message(error)}); it builds on boat instead`);
            }
          }
          if (!remoteVerification?.lease) throw new Error(`nothing on this runner can build for the pool ${pool}`);
          return remoteVerification.lease(lease);
        } } : {},
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
      const failed = record.migrations?.reason ? [{ name: "migrations", reason: record.migrations.reason }]
        : record.projects.filter((project) => !project.ok);
      if (failed.length && operation.promotion) record.rollback = await rollBack(operation, operation.promotion, record, policy.migrations !== undefined, earlierSchemaChange);
      record.startedAt = deployStartedAt;
      record.durationMs = Math.max(0, performance.now() - deployStarted);
      verdict = failed.length
        ? { type: "failed", stage: "deploying", deployment: record,
          reason: `deploy failed: ${failed.map((project) => `${project.name} (${project.reason})`).join(", ")}${record.rollback ? `; ${record.rollback.reason}` : ""}` }
        : { type: "deployed", record };
    } catch (error) {
      verdict = { type: "failed", stage: "deploying", reason: message(error) };
    }
    append(operation.id, verdict);
    // Promotion reads staging: what it deployed green is the next candidate, so verify it ahead of the approval.
    if (verdict.type === "deployed" && operation.environment === "staging" && promotes) {
      queueVerification(operation.repo, operation.commitId);
    }
    // A newer green candidate may have waited for this production deploy.
    if (operation.environment === "production") void promoteAutomatically(operation.repo);
    // A deploy that never reached its projects is retried once the interval passes.
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
  /**
   * After a restart: the newest green staging deploy may have been recorded without the
   * pre-verification it queues (the runner stopped between the two). Queue it when that commit
   * has no pre-verification at all; one the owner killed or that was superseded stays as it is.
   */
  async function reconcileVerification(repo: string): Promise<void> {
    const green = log.deployments(repo, "staging").find((entry) => entry.result?.type === "deployed");
    if (!green || log.verifications(repo, green.commitId).length) return;
    const configuration = await readExactExecutionPolicy(join(repoCheckout(repo), ".git"), green.commitId).then((exact) => exact.configuration, () => null);
    if (promotesFrom(configuration)) queueVerification(repo, green.commitId);
  }
  /**
   * Queue a pre-verification of `commitId`, superseding queued ones of older commits, unless one
   * of it is already queued or running. A running one finishes. One that passed is verified
   * again: the release branch may have moved since, which a confirm would not reuse it across.
   */
  function queueVerification(repo: string, commitId: string, by: "staging" | "batch" | "background" | "confirm" = "staging"): string {
    const existing = log.verifications(repo);
    const open = existing.find((entry) => entry.commitId === commitId && (entry.status === "queued" || entry.status === "running"));
    if (open) return open.id;
    const id = newOperationId();
    for (const stale of existing.filter((entry) => entry.status === "queued")) append(stale.id, { type: "superseded", by: id });
    append(id, { type: "submitted", kind: "verification", repo, commitId, submittedBy: `${executor.host}:${by}` });
    wakeMain();
    return id;
  }
  /**
   * A confirm's batch check of `commitId` (SJ-192): the open one stands, and so does a passed or red one measured from
   * the base Production still serves with no promotion since; otherwise one is queued now, whatever the schedule. Null when the release base does not batch.
   */
  async function requestBatchCheck(repo: string, commitId: string): Promise<VerificationResponse | null> {
    const base = await releasePolicy(repo, commitId);
    if (base?.process !== "development" || !base.batchVerification) return null;
    const latest = log.verifications(repo, commitId).find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
    // An ended check stands only against the base it measured: a promotion since, or Production serving another commit, makes it stale.
    const current = async (check: VerificationOperation): Promise<boolean> => {
      if (log.releases(repo).some((release) => release.result?.type === "released" && release.submittedAt > check.submittedAt)) return false;
      const started = log.events({ operationId: check.id }).map((row) => row.event).find((event) => event.type === "batch_started");
      return started?.type === "batch_started" && started.base === await servedBase(repo, repoCheckout(repo));
    };
    if (latest && (latest.status === "queued" || latest.status === "running")) return { operation: latest, requested: false };
    if (latest && (latest.status === "verified" || batchOutcomeOf(latest.id)?.outcome === "red") && await current(latest)) return { operation: latest, requested: false };
    const id = queueVerification(repo, commitId, "confirm");
    // The owner's release goes first (SJ-202): a background check of another commit stops, freeing the check place.
    for (const entry of running.values())
      if (entry.operation.kind === "verification" && entry.operation.repo === repo && entry.operation.id !== id && entry.operation.submittedBy.endsWith(":background")) {
        stopping.set(entry.operation.id, `stopped for the release of ${commitId.slice(0, 12)} the owner pushed (${id}); checked again later`);
        entry.controller.abort();
      }
    return { operation: log.operation(id) as VerificationOperation, requested: true };
  }
  /** Background checks stopped for a release the owner pushed, and why: they end `stopped`, never as the owner's kill. */
  const stopping = new Map<string, string>();
  const automaticPromotions = new Map<string, Promise<void>>();
  /** Per repository, the timer that asks again when its `promotionSchedule` next lets a promotion start. */
  const scheduledPromotions = new Map<string, ReturnType<typeof setTimeout>>();
  const now = input.now ?? Date.now;
  /**
   * The commit `process: "development"` promotes: the newest landed commit whose pre-verification passed,
   * looking back no further than the newest commit already released or tried (`except` names a release that does not
   * count, the one asking). A newer landing that is still verifying, or whose verification failed, does not hold it
   * back, so a stream of landings cannot keep every verified commit from being promoted.
   */
  function promotionCandidate(repo: string, except?: string): { commitId: string; verification: ReturnType<typeof log.verifications>[number] } | undefined {
    const verifications = log.verifications(repo);
    // Read once: each projects every one of the repository's releases or deploys.
    const tried = new Set([...log.releases(repo).filter((release) => release.id !== except), ...log.deployments(repo, "production")].map((entry) => entry.commitId));
    for (const entry of log.landings(repo).reverse()) {
      if (tried.has(entry.commitId)) return undefined;
      const verification = verifications.find((other) => other.commitId === entry.commitId && other.result?.type === "verified");
      if (verification) return { commitId: entry.commitId, verification };
    }
    return undefined;
  }
  /**
   * `process: "development"`: promote the newest verified green staging commit (`promotionCandidate`) the way
   * `slipjay promote --confirm` would, by queueing the same release, once its pre-verification passed. The setting
   * is read from the release branch's policy at the base the pre-verification ran against, never from the candidate.
   * A candidate the safeguards refuse (non-additive migrations, an audit refusal) or whose verification failed stays
   * unpromoted, with the reason on its pre-verification's log; a newer verified candidate is asked again. A
   * pre-verification that just passed for a commit this consideration does not promote says why on its own log too.
   * Asked after a pre-verification passes (`after`, that operation), a release or a production deploy ends, and at startup.
   */
  function promoteAutomatically(repo: string, after?: string): Promise<void> {
    const next = (automaticPromotions.get(repo) ?? Promise.resolve()).then(() => considerAutomaticPromotion(repo, after))
      .catch((error: unknown) => { console.error(`[runner] automatic promotion of ${repo} could not be considered: ${message(error)}`); });
    automaticPromotions.set(repo, next);
    // The background check is considered after, on its own chain: nothing that asks for a promotion waits for it.
    void next.then(() => {
      const background = (backgroundConsiderations.get(repo) ?? Promise.resolve()).then(() => considerBackgroundCheck(repo))
        .catch((error: unknown) => { console.error(`[runner] a background check of ${repo} could not be considered: ${message(error)}`); });
      backgroundConsiderations.set(repo, background);
    });
    return next;
  }
  const backgroundConsiderations = new Map<string, Promise<void>>();
  /** Why a passed pre-verification cannot promote its commit, or null when it may: its migrations, which no one approved. */
  const migrationsWithheld = (verified: { nonAdditiveMigrations?: string[] }): string | null =>
    verified.nonAdditiveMigrations === undefined ? "its migrations were not assessed"
      : verified.nonAdditiveMigrations.length ? `it carries non-additive migrations (${verified.nonAdditiveMigrations.join(", ")}): the owner decides`
      : null;
  /**
   * What a development release base declares no value for, so nothing may promote from it: null when it may. A commit
   * cannot switch the mode on for itself, so this is the one place that decides what a promotion needs.
   */
  const missingPromotion = (base: NonNullable<Awaited<ReturnType<typeof releasePolicy>>>): string | null => {
    const missing = [
      ...(base.deployments?.environments.production ? [] : ["production environment"]),
      ...(base.releaseBranch ? [] : ["release branch"]),
      ...(base.requiredReleaseVerification ? [] : ["requiredReleaseVerification"]),
    ];
    return missing.length ? `the release base's policy does not promote: it declares no ${missing.join(", no ")}` : null;
  };
  /**
   * What already stands for a commit, so nothing promotes it again: the release or production deploy the ledger
   * holds for it and how each ended. Null when it holds neither. Phrased to follow a subject.
   */
  const standsFor = (repo: string, commitId: string): string | null => {
    const states: string[] = [];
    const release = log.releases(repo, commitId)[0];
    if (release) states.push(release.result?.type === "released" ? "is already released"
      : release.status === "queued" || release.status === "running" ? `has a release (${release.id}) still open`
      : `has a release that ended ${release.status}`);
    const deploy = log.deployments(repo, "production").find((entry) => entry.commitId === commitId);
    if (deploy) states.push(deploy.result?.type === "deployed" ? "is already live on production"
      : deploy.status === "queued" || deploy.status === "running" ? `has a production deploy (${deploy.id}) still open`
      : "has a production deploy that did not succeed");
    return states.length ? states.join(", and ") : null;
  };
  async function considerAutomaticPromotion(repo: string, after?: string): Promise<void> {
    const newest = log.lastLanded(repo);
    if (!newest) return;
    const note = (commitId: string, verificationId: string, reason: string): void => {
      const line = `Not promoting ${commitId.slice(0, 12)} automatically: ${reason}`;
      if (!log.events({ operationId: verificationId }).some((stored) => stored.event.type === "progress" && stored.event.line === line)) {
        append(verificationId, { type: "progress", line });
        console.error(`[runner] ${repo}: ${line}`);
      }
    };
    /**
     * The pre-verification that just ended passed, but this consideration promotes another commit (or none): it
     * leaves why on its own log, so a green landing that is not live always says so. Its reason is its own
     * safeguard when it has one, else what already stands for it or for the newer landing that stopped the walk.
     */
    const explain = async (operationId: string, chosen: string | undefined): Promise<void> => {
      const ended = log.verifications(repo).find((entry) => entry.id === operationId);
      const verified = ended?.result?.type === "verified" ? ended.result : undefined;
      if (!ended || !verified) return;
      const base = await releasePolicy(repo, ended.commitId, verified.base);
      if (!base || base.process !== "development") return;
      const own = standsFor(repo, ended.commitId);
      const ahead = newest.commitId === ended.commitId ? null : standsFor(repo, newest.commitId);
      const reason = migrationsWithheld(verified) ?? missingPromotion(base) ?? (chosen
        ? `a newer pre-verified candidate (${chosen.slice(0, 12)}) is ahead of it`
        : own ? `it ${own}`
        : ahead ? `the newest landing (${newest.commitId.slice(0, 12)}) ${ahead}`
        : null);
      // Nothing was withheld when nothing has been done with the commit: a verification of a commit that never
      // landed here, for one, says nothing.
      if (reason) note(ended.commitId, ended.id, reason);
    };
    const choice = promotionCandidate(repo);
    // The pre-verification that woke this consideration is answered whether or not it is the candidate.
    if (after && after !== choice?.verification.id) await explain(after, choice?.commitId);
    // A batching release branch checks its newest landing when the promotion falls due; a candidate that already passed promotes as before.
    if (!choice) {
      const releaseBase = await releasePolicy(repo, newest.commitId);
      if (releaseBase?.process === "development" && releaseBase.batchVerification && !missingPromotion(releaseBase)) return considerBatch(repo, newest.commitId, releaseBase);
    }
    // A newest landing whose verification failed is left behind, and says why.
    const failed = log.verifications(repo, newest.commitId).find((entry) => entry.status === "failed");
    if (failed && !log.releases(repo, failed.commitId).length && (await releasePolicy(repo, failed.commitId))?.process === "development")
      note(failed.commitId, failed.id, "its pre-verification failed");
    if (!choice) return;
    const { commitId, verification } = choice;
    const verified = verification.result?.type === "verified" ? verification.result : undefined;
    if (!verified) return;
    // Only the chosen candidate promotes: an older one still queued is replaced.
    const next = newOperationId();
    supersedeAutomaticReleases(repo, commitId, next);
    const withheld = (reason: string): void => note(commitId, verification.id, reason);
    // A release or a production deploy already in flight promotes what it holds; this one waits for it to end.
    const open = log.openOperations(repo).find((entry) => entry.kind === "release" || (entry.kind === "deploy" && entry.environment === "production"));
    if (open) return withheld(`a ${open.kind === "release" ? "release" : "production deploy"} (${open.id}) is already open`);
    const base = await releasePolicy(repo, commitId, verified.base);
    if (!base) return withheld("its release base's policy could not be read");
    if (base.process !== "development") return;
    const migrations = migrationsWithheld(verified);
    if (migrations) return withheld(migrations);
    // Every decision input is the release base's, never the candidate's.
    const refuses = missingPromotion(base);
    if (refuses) return withheld(refuses);
    const refusal = base.audit ? promotionRefusal(auditSummary({ audits: log.audits(repo), landings: log.landings(repo) }, new Date())) : null;
    if (refusal) return withheld(refusal);
    // Asked again after the reads above, which let a newer candidate pass and a release or a production deploy begin.
    const current = promotionCandidate(repo);
    if (current?.commitId !== commitId) return withheld(current
      ? `a newer candidate (${current.commitId.slice(0, 12)}) passed while it was decided`
      : "a release or production deploy now holds it");
    const opened = log.openOperations(repo).find((entry) => entry.kind === "release");
    if (opened) return withheld(`a release (${opened.id}) opened while it was decided`);
    if (base.promotionSchedule) {
      // The newest release that ran, automatic or confirmed by the owner, starts the interval.
      const last = log.releases(repo).find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
      const due = nextPromotionAt(base.promotionSchedule, last ? Date.parse(last.submittedAt) : undefined, now());
      if (due > now()) {
        clearTimeout(scheduledPromotions.get(repo));
        const timer = setTimeout(() => { scheduledPromotions.delete(repo); void promoteAutomatically(repo); }, due - now());
        timer.unref?.();
        scheduledPromotions.set(repo, timer);
        return withheld(`waiting for the next scheduled promotion: ${describeSchedule(base.promotionSchedule)}`);
      }
    }
    const automatic = { setting: "process", value: "development" } as const;
    append(next, { type: "submitted", kind: "release", repo, commitId, migrationsReady: false, submittedBy: `${executor.host}:automatic`, automatic });
    append(next, { type: "progress", line: `Promoting ${commitId.slice(0, 12)} automatically: process is "development" at ${verified.base.slice(0, 12)} on the release branch, and its pre-verification passed` });
    console.error(`[runner] ${repo}: promoting ${commitId.slice(0, 12)} automatically (process: "development")`);
    wakeMain();
  }
  /** The next look at each repository's background check (SJ-202). */
  const backgroundChecks = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * `batchVerification.everyMinutes` (SJ-202): check the newest landing in the background, so a promotion finds an
   * already-checked tip and a red check names its culprit soon after it lands. A check starts when the newest landing
   * has none of its own (so a red head waits for a new landing), no other check is open, no release or production
   * deploy is open, the interval has passed since the last check started, and no landing gate is queued or waiting for
   * a place; otherwise the runner looks again later. Asked whenever promotion is, and by its own timer.
   */
  async function considerBackgroundCheck(repo: string): Promise<void> {
    const newest = log.lastLanded(repo);
    if (!newest) return;
    const base = await releasePolicy(repo, newest.commitId);
    const every = base?.process === "development" && !missingPromotion(base) ? base.batchVerification?.everyMinutes : undefined;
    if (!every) return;
    const later = (ms: number) => {
      clearTimeout(backgroundChecks.get(repo));
      const timer = setTimeout(() => { backgroundChecks.delete(repo); void promoteAutomatically(repo); }, Math.max(1_000, ms));
      timer.unref?.();
      backgroundChecks.set(repo, timer);
    };
    if (standsFor(repo, newest.commitId)) return;
    const checks = log.verifications(repo).filter((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
    const own = checks.filter((entry) => entry.commitId === newest.commitId);
    // A head with a check waits for a new landing, unless that check ended flaky or by infrastructure: it is checked
    // again on the interval, within the same bound as a scheduled batch.
    if (own.length) {
      const outcome = own[0]!.status === "failed" ? batchOutcomeOf(own[0]!.id)?.outcome : undefined;
      if ((outcome !== "flaky" && outcome !== "infrastructure") || own.filter((entry) => entry.status === "failed").length >= BATCH_ATTEMPTS) return;
    }
    if (checks.some((entry) => entry.status === "queued" || entry.status === "running")) return;
    if (log.openOperations(repo).some((entry) => entry.kind === "release" || (entry.kind === "deploy" && entry.environment === "production"))) return later(60_000);
    const last = checks[0];
    const due = last ? Date.parse(last.submittedAt) + every * 60_000 : now();
    if (due > now()) return later(due - now());
    // Landing gates go first: a check waits while one is queued for the lane or for a place on its machine.
    const gateMachine = configuredRepository(config, repo)?.gateMachine;
    if (log.openOperations(repo).some((entry) => entry.kind === "landing" && entry.status === "queued") || (gateMachine && machineGates.queued(gateMachine))) return later(60_000);
    console.error(`[runner] ${repo}: background-checking ${newest.commitId.slice(0, 12)}`);
    queueVerification(repo, newest.commitId, "background");
  }
  /** How a batch check ended, from its own record; undefined while it has none (it never ran, or predates SJ-192). */
  const batchOutcomeOf = (operationId: string) => log.events({ operationId }).map((row) => row.event)
    .findLast((event): event is Extract<OperationEvent, { type: "batch_outcome" }> => event.type === "batch_outcome");
  /** How many complete checks of one head a flaky or infrastructure failure may cost before the runner stops asking again. */
  const BATCH_ATTEMPTS = 3;
  /**
   * `batchVerification` (SJ-192): the newest landing has no passing batch check. When the scheduled promotion is due,
   * freeze it as the batch head and queue its batch check; before then, ask again at the due time. A red batch waits
   * for a new landing; a flaky or infrastructure failure checks the same head again, a bounded number of times.
   */
  async function considerBatch(repo: string, head: string, base: NonNullable<Awaited<ReturnType<typeof releasePolicy>>>): Promise<void> {
    if (standsFor(repo, head)) return;
    if (log.openOperations(repo).some((entry) => entry.kind === "release" || (entry.kind === "deploy" && entry.environment === "production"))) return;
    const checks = log.verifications(repo, head);
    if (checks.some((entry) => entry.status === "queued" || entry.status === "running")) return;
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
        clearTimeout(scheduledPromotions.get(repo));
        const timer = setTimeout(() => { scheduledPromotions.delete(repo); void promoteAutomatically(repo); }, due - now());
        timer.unref?.();
        scheduledPromotions.set(repo, timer);
        return;
      }
    }
    console.error(`[runner] ${repo}: the scheduled promotion is due; batch-checking ${head.slice(0, 12)}`);
    queueVerification(repo, head, "batch");
  }
  /** Supersede the queued automatic releases of commits other than `keep`, which `by` replaces. */
  function supersedeAutomaticReleases(repo: string, keep: string, by: string): void {
    for (const stale of log.openOperations(repo))
      if (stale.kind === "release" && stale.automatic && stale.status === "queued" && stale.commitId !== keep) append(stale.id, { type: "superseded", by });
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
      submittedBy: `promotion:${promotion.id}`, promotion: { ...shipped ?? { merge: result.merge, nonAdditiveMigrations: result.nonAdditiveMigrations, migrationArtifacts: result.migrationArtifacts },
        ...promotion.automatic ? { automatic: promotion.automatic } : {} } });
    return id;
  }
  /**
   * Admit queued landings, releases and resets, oldest first, while the rule (`admits`) has
   * a place for them: each to its lane once that lane is idle, so a lane's operations keep
   * their order, and a short landing never passes an older operation of its repository lane
   * that waits for a place. A pause admits nothing new; running operations finish.
   */
  function wakeMain(): void {
    if (recovering || draining || log.paused() || heldStart) return;
    for (const repo of boatHolds.keys()) probeBoat(repo);
    const open = log.openOperations();
    // Completed screens compete in completion order; a slow screen owns no queue position.
    for (const turn of [...screens.values()].filter((turn) => turn.screen?.phase === "passed")
      .sort((a, b) => a.screen!.passedAt! - b.screen!.passedAt!)) {
      const operation = turn.operation;
      // A screen behind a predicted prefix publishes only once that prefix has.
      if (turn.predecessor && screens.get(turn.predecessor.operation.id) === turn.predecessor) continue;
      // Its gate has passed: what is left is seconds of publication, and the repository lane already takes those in turn.
      // Where a combined budget bounds what runs, it needs no worker place, so it never queues behind another gate.
      if ((!shortPlace && !admits(false, places(), workers, shortPlace)) || lanes.has(laneOf(operation.repo))
        || prefixes.get(operation.repo)?.length || awaitingReplacement({ ...operation, status: "queued" }, open) || screeningFence(operation, open)) continue;
      turn.screen!.phase = "authoritative";
      prefixes.set(operation.repo, [turn]);
      admitted.set(operation.id, operation);
      append(operation.id, { type: "screen_admitted", attempt: turn.attempt });
      turn.screen!.ready.resolve();
    }
    // Repository lanes whose oldest startable operation found no place: nothing later in them may pass it.
    const behind = new Set<string>();
    for (const operation of open) {
      if (!admits(true, places(), workers, shortPlace)) break;
      if (operation.kind === "deploy") {
        if (!executor.combinedLimits && operation.status === "queued" && !activeDeploys.has(operation.id) && !auditRunning()) admitDeploy(operation);
        continue;
      }
      if (behind.has(laneOf(operation.repo))) continue;
      const screenCount = configuredRepository(config, operation.repo)?.screeningLanes ?? 0;
      if (screenCount && operation.kind === "landing" && runnable(operation, open)
        && !admitted.has(operation.id) && !screens.has(operation.id) && !heldForBoat(operation.repo)) {
        const occupied = [...screens.values()].filter((turn) => turn.operation.repo === operation.repo);
        if (!admits(false, places(), workers, shortPlace) || occupied.length >= screenCount || screeningFence(operation, open)) continue;
        const slot = Array.from({ length: screenCount }, (_, i) => i).find((i) => !occupied.some((turn) => turn.screenSlot === i))!;
        const previous = log.events({ operationId: operation.id }).flatMap(({ event }) => event.type === "attempt_started" ? [event.attempt] : []);
        const predecessor = predictedPrefix(operation.repo, operation);
        const turn: PrefixTurn = { operation, slot: 0, screenSlot: slot, attempt: Math.max(0, ...previous) + 1,
          prepared: deferred(), completed: deferred(), invalidation: new AbortController(), screen: { phase: "preparing", ready: deferred() },
          ...predecessor ? { predecessor } : {} };
        screens.set(operation.id, turn);
        admitted.set(operation.id, operation);
        append(operation.id, { type: "screen_started", slot, ...predecessor ? { behind: predecessor.operation.id } : {} });
        const pending = processOperation(operation, turn).finally(() => {
          turn.prepared.resolve(null); turn.completed.resolve(log.operation(operation.id)?.status === "landed");
          screens.delete(operation.id);
          if (log.operation(operation.id)?.status !== "queued") { unpredicted.delete(operation.id); overtakenOnce.delete(operation.id); }
          prefixes.set(operation.repo, (prefixes.get(operation.repo) ?? []).filter((entry) => entry !== turn));
          admitted.delete(operation.id); attempts.delete(pending); wakeMain(); wakeDeploys();
        });
        attempts.add(pending);
        continue;
      }
      const start = startable(operation, open);
      if (!start) continue;
      // A pre-verification waits for its place without holding back the landings behind it.
      if (!admits(start.short, places(), workers, shortPlace)) { if (operation.kind !== "verification") behind.add(laneOf(operation.repo)); continue; }
      if (!start.prefix || operation.kind !== "landing") {
        admit(admissionLane(laneOf(operation.repo), operation.repo, operation.kind), operation, start.short);
        continue;
      }
      const active = prefixes.get(operation.repo) ?? [];
      const previousAttempts = log.events({ operationId: operation.id }).flatMap(({ event }) => event.type === "attempt_started" ? [event.attempt] : []);
      const turn: PrefixTurn = { operation, attempt: Math.max(0, ...previousAttempts) + 1, slot: active.some((entry) => entry.slot === 0) ? 1 : 0,
        prepared: deferred(), completed: deferred(), invalidation: new AbortController(), predecessor: active.at(-1) };
      prefixes.set(operation.repo, [...active, turn]);
      admitted.set(operation.id, operation);
      if (start.short) shortAdmitted.add(operation.id);
      const pending = processOperation(operation, turn).finally(() => {
        turn.prepared.resolve(null);
        turn.completed.resolve(log.operation(operation.id)?.status === "landed");
        prefixes.set(operation.repo, (prefixes.get(operation.repo) ?? []).filter((entry) => entry !== turn));
        admitted.delete(operation.id); shortAdmitted.delete(operation.id); attempts.delete(pending); wakeMain(); wakeDeploys();
      });
      attempts.add(pending);
    }
  }
  function screeningFence(operation: Operation, open: readonly Operation[]): boolean {
    const older = open.slice(0, open.findIndex((entry) => entry.id === operation.id));
    return older.some((entry) => laneOf(entry.repo) === laneOf(operation.repo)
      && entry.kind !== "landing" && entry.kind !== "deploy" && entry.kind !== "verification")
      || [...admitted.values()].some((entry) => laneOf(entry.repo) === laneOf(operation.repo) && entry.kind === "reset");
  }
  function admit(lane: string, operation: LandingOperation | ReleaseOperation | RecoveryOperation | ResetOperation | VerificationOperation | AuditOperation, short = false): void {
    admitted.set(operation.id, operation);
    if (short) shortAdmitted.add(operation.id);
    void inLane(lane, () => processOperation(operation))
      .finally(() => { admitted.delete(operation.id); shortAdmitted.delete(operation.id); wakeMain(); wakeDeploys(); });
  }
  /**
   * How queued `operation` would be admitted now, places aside: as a short or long place, and
   * as a turn in its repository's depth-two chain or in its lane. Undefined while anything else
   * keeps it waiting. A successor always counts as long; a head is short when its repository is.
   */
  function startable(operation: Operation, open: readonly Operation[]): { short: boolean; prefix: boolean } | undefined {
    if (operation.kind === "landing" && heldForBoat(operation.repo)) return undefined;
    // `open` is a snapshot: what this wake already admitted still reads as queued there.
    if (operation.kind === "deploy" || admitted.has(operation.id) || screens.has(operation.id) || !runnable(operation, open) || resetConflict(operation)) return undefined;
    // An audit's verdict gates promotion, so it and a deploy never run together on this host: a deploy's load fails
    // tests that fit their bounds on a quiet host, and that failure says nothing about the code. The audit starts once
    // the deploys end (which wakes the queue), and deploys wait for it (`auditRunning`).
    if (operation.kind === "audit" && (activeDeploys.size || open.some((entry) => entry.kind === "deploy" && entry.status === "running"))) return undefined;
    if (lanes.has(admissionLane(laneOf(operation.repo), operation.repo, operation.kind))) return undefined;
    // A pre-verification verifies its green staged commit in its release lane, outside the depth-two chain.
    if (operation.kind === "verification") return { short: false, prefix: false };
    const active = prefixes.get(operation.repo) ?? [];
    const depth = configuredRepository(config, operation.repo)?.verificationDepth ?? 1;
    if (operation.kind === "landing" && depth === 2 && laneOf(operation.repo) === operation.repo && (executor.combinedLimits || configuredRepository(config, operation.repo)?.verifier)) {
      if (active.length >= 2) return undefined;
      // A queued reset/release is an arrival-order fence, even while no lane is held.
      const repository = log.openOperations(operation.repo);
      if (repository.slice(0, repository.findIndex((entry) => entry.id === operation.id))
        .some((entry) => entry.kind !== "landing" && entry.kind !== "deploy" && entry.kind !== "verification")) return undefined;
      return { short: !active.length && isShort(operation), prefix: true };
    }
    return active.length ? undefined : { short: isShort(operation), prefix: false };
  }
  /** Whether `operation` is queued and free to start, as far as Build admission goes. */
  const runnable = (operation: Operation, open: readonly Operation[]): boolean => operation.status === "queued"
    && !(operation.kind === "landing" && operation.admission === "pending") && !awaitingReplacement(operation, open);
  /**
   * A reset rewrites the external state a release may verify against, so a release or
   * pre-verification beside its repository lane and a reset of that repository never overlap.
   */
  function resetConflict(operation: Operation): boolean {
    if (operation.kind === "reset" && ((prefixes.get(operation.repo)?.length ?? 0) > 0 || [...screens.values()].some((turn) => turn.operation.repo === operation.repo))) return true;
    if (operation.kind === "reset") return lanes.has(admissionLane(laneOf(operation.repo), operation.repo, "release"));
    return (operation.kind === "release" || operation.kind === "verification")
      && [...admitted.values()].some((entry) => entry.kind === "reset" && laneOf(entry.repo) === laneOf(operation.repo));
  }
  async function processOperation(operation: LandingOperation | ReleaseOperation | RecoveryOperation | ResetOperation | VerificationOperation | AuditOperation, prefix?: PrefixTurn): Promise<void> {
    let stage: RunnerStage = "queued";
    let stageStarted = Date.now();
    let provenancePolicy: Pick<import("../policy/execution-policy.ts").ExecutionPolicy, "migrationFinalization" | "provenance"> | undefined;
    let checkedCandidate: { candidate: string; base: string } | undefined;
    let installSource: "fresh" | "existing" | undefined;
    let rebaseConflict = false;
    let conflictFiles: string[] = [];
    // Every jj, git and gh command this operation runs on the runner, timed, so each stage names its slow steps (SJ-200).
    const commandTimings: CommandTiming[] = [];
    let stageTimingFrom = 0;
    const stageCommands = () => {
      const ran = commandTimings.slice(stageTimingFrom);
      stageTimingFrom = commandTimings.length;
      if (!ran.length) return {};
      return { commands: { count: ran.length, ms: ran.reduce((total, entry) => total + entry.ms, 0),
        slowest: [...ran].sort((left, right) => right.ms - left.ms).slice(0, 5) } };
    };
    const stageDetail = (): OperationEvent => ({ type: "stage_detail", stage, durationMs: Date.now() - stageStarted,
      ...(stage === "installing" ? { installSource } : {}), ...(stage === "rebasing" ? { conflict: rebaseConflict, files: conflictFiles } : {}),
      ...stageCommands() });
    const controller = new AbortController();
    const pendingCommands = new Set<Promise<unknown>>();
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    let verificationTimeout: string | undefined;
    const authorityError = () => verificationTimeout ? new Error(verificationTimeout) : new OwnerKill();
    running.set(operation.id, { operation, stage, controller });
    const stopSuperseded = prefix?.screen ? log.subscribe((row) => {
      if (row.operationId === operation.id && (row.event.type === "superseded" || row.event.type === "cancelled")) controller.abort();
    }) : undefined;
    let verdict: OperationEvent | undefined;
    let retryPrefix = false;
    // The audit policy the audited head declared; null when it declares none, undefined until read.
    let auditPolicy: import("../policy/audit-policy.ts").AuditPolicy | null | undefined;
    const checkout = prefix ? join(home, "verifiers", operation.repo, prefix.screenSlot === undefined ? String(prefix.slot) : `${prefix.screenSlot}-screen`) : checkoutPath(operation);
    // Only this attempt shares successful immutable observations. A failed read
    // is retried by the next caller, and a rebuilt prefix starts a fresh scope.
    let landedPolicy: { directory: string; commit: string; value: Awaited<ReturnType<typeof readExactExecutionPolicy>> } | undefined;
    const readLandedPolicy: typeof readExactExecutionPolicy = async (directory, commit) => {
      if (landedPolicy?.directory === directory && landedPolicy.commit === commit) return landedPolicy.value;
      const value = await readExactExecutionPolicy(directory, commit);
      landedPolicy = { directory, commit, value };
      return value;
    };
    const shapes = new Map<string, { shape: Extract<OperationEvent, { type: "change_shape" }>; touched: string[] }>();
    const scratch = scratchOf(checkout);
    let remote: string | undefined;
    let integrationBranch: string | undefined;
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    // Set once the integration policy is read: landing checks in a Build-tracked repository may read Build.
    let tracker: "github" | "build" | "forge" | undefined;
    let checkEnvironment: Promise<Record<string, string>> | undefined;
    /**
     * What a landing's verification and migration commands get from Build: the admitted binding, never commit text,
     * and read access scoped to this attempt, revoked when it ends.
     */
    function buildCheckEnvironment(): Promise<Record<string, string>> {
      return checkEnvironment ??= (async () => {
        if (operation.kind !== "landing") return {};
        const read = tracker === "build" || tracker === "forge" ? buildChecks?.grant() : null;
        const events = log.events({ operationId: operation.id }).map((row) => row.event);
        const submitted = events.find((event) => event.type === "submitted");
        const admitted = events.find((event) => event.type === "build_admitted");
        const binding = admitted && isLandingSubmission(submitted)
          ? submitted.admission?.binding : undefined;
        // Without Build on the runner its checks get nothing from Build, and a check that needs it refuses by name.
        if (!binding || !readBuild) return { ...read?.environment };
        // Unanswered, nothing runs with the grant: end it now, as the operation's end will not see it.
        const items = admitted?.type === "build_admitted" ? admitted.items : undefined;
        const context = await buildCheckContext(binding, items, readBuild).catch((error: unknown) => { if (read) buildChecks!.revoke(read.token); throw error; });
        return { ...read?.environment, [BUILD_CONTEXT_ENV]: context };
      })();
    }
    async function withAuthority<T>(pending: Promise<T>): Promise<T> {
      const signal = AbortSignal.any([controller.signal, ...prefix ? [prefix.invalidation.signal] : []]);
      const fail = () => controller.signal.aborted ? authorityError() : new Error("Exact predecessor invalidated this attempt");
      if (signal.aborted) throw fail();
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => { aborted = () => reject(fail()); signal.addEventListener("abort", aborted, { once: true }); });
      try { return await Promise.race([pending, cancellation]); }
      finally { signal.removeEventListener("abort", aborted); }
    }
    // Gate and migration commands both go through the executor, so each run records where it ran.
    async function run(request: BoundedProcessRequest, purpose?: RunPurpose, via: Pick<Executor, "host" | "run"> & { runtime?: RuntimeIdentity; reportRoot?: string } = executor): Promise<BoundedProcessResult> {
      if (controller.signal.aborted) throw authorityError();
      const runId = randomUUID();
      const started = Date.now();
      const runPurpose = purpose ?? (stage === "resetting" ? "reset" : stage === "finalizing" ? "finalization" : stage === "installing" ? "dependencies" : "gate");
      const selected = await candidateBun(checkout, request.env, home);
      request = { ...request, env: selected.environment };
      const build = ["gate", "migration_generate", "migration_verify"].includes(runPurpose) ? await buildCheckEnvironment() : {};
      const abortSignal = AbortSignal.any([controller.signal, ...prefix ? [prefix.invalidation.signal] : [], ...request.abortSignal ? [request.abortSignal] : []]);
      const privateRun = stage === "resetting" || stage === "finalizing";
      const runEnvironment = privateRun ? request.env : { ...sanitizedProcessEnv(request.env), TMPDIR: scratch };
      if ((purpose === "migration_generate" || purpose === "migration_verify") && request.env?.SLIPJAY_MIGRATION_CONTEXT)
        runEnvironment!.SLIPJAY_MIGRATION_CONTEXT = request.env.SLIPJAY_MIGRATION_CONTEXT;
      // A release check's base and head (and a rerun's suites) are the runner's own, never the host environment's.
      if (!privateRun) for (const key of RELEASE_ENV_KEYS) if (request.env?.[key]) runEnvironment![key] = request.env[key];
      // A gate command may report per-file test timings into its own directory (see test-reports.ts).
      const reports = runPurpose === "gate" && !privateRun ? join(scratch, "test-reports", runId) : undefined;
      if (reports) {
        await mkdir(reports, { recursive: true, mode: 0o700 });
        runEnvironment![TEST_REPORT_DIR_ENV] = reports;
      }
      const redact = privateRun ? request.redactOutput ?? ((value: string) => value) : (value: string) => redactVerificationOutput(value, checkout);
      const token = build[BUILD_READ_TOKEN_ENV];
      const redactOutput = token ? (value: string) => redact(value.split(token).join("[REDACTED]")) : redact;
      if (controller.signal.aborted) throw authorityError();
      // Evidence describes the final execution environment, including runner-provided variables.
      const executionRequest = { ...request, env: Object.keys(build).length ? { ...runEnvironment, ...build } : runEnvironment };
      // A remote verifier runs its own Bun; the evidence names the one that ran.
      const context = commandEvidence(executionRequest, checkout, via.runtime ?? selected.runtime);
      append(operation.id, { type: "run_started", runId, command: context.status === "recorded" ? [context.executable, ...context.args].join(" ") : "command context unavailable (capacity)", host: via.host, timeoutMs: request.timeoutMs,
        purpose: runPurpose, ...(prefix ? { attempt: prefix.attempt } : {}), commandEvidence: context });
      const execution = via.run({ ...executionRequest,
        redactOutput, abortSignal }).catch((error: unknown) => {
        append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started, artifact: { status: "unavailable", reason: "capture-failed" } });
        throw error;
      });
      pendingCommands.add(execution);
      let result;
      try { result = await execution; }
      finally { pendingCommands.delete(execution); }
      const finished = runFinished(runId, result, started, request, privateRun);
      if (controller.signal.aborted) {
        // Retain the command's stop before the verdict, without waiting on artifact I/O.
        finished.artifact = { status: "unavailable", reason: "capture-failed" };
        append(operation.id, finished);
        throw authorityError();
      }
      // Logs never passed through the executor's redaction, so the artifact applies the run's own to them.
      const logs = reports ? (await readRetainedLogs(reports)).map((log) => ({ ...log, content: redactOutput(log.content) })) : [];
      finished.artifact = await retainCommandArtifact({ home, operationId: operation.id, runId, request, result, privateOutput: privateRun, logs });
      if (controller.signal.aborted) throw authorityError();
      append(operation.id, finished);
      if (reports) {
        append(operation.id, { type: "test_report", runId, ...await readTestReports(reports, via.reportRoot ?? await realpath(checkout).catch(() => checkout)) });
        await rm(reports, { recursive: true, force: true });
      }
      return { ...result, runId };
    }
    /**
     * Why this attempt's remote executor was never available, when boat supplied no machine for it. None of the
     * candidate's gate commands ran, so that failure is infrastructure, not evidence about the source: see below.
     */
    let remoteUnavailable: string | undefined;
    /** How many attempts this landing has already returned to the queue for a remote executor that was not ready. */
    const remoteUnavailableRetries = (): number => log.events({ operationId: operation.id })
      .filter(({ event }) => event.type === "yielded" && event.to === AWAITING_REMOTE_EXECUTOR).length;
    type GateAttempt = { attempt: RemoteAttempt; started: number; placement: GatePlacement; place?: number };
    /**
     * Waits for the CPU budget of the host a job's commands are about to run on (SJ-212), in a stage of its own while it
     * is over budget, so the wait counts against neither its commands' timeouts, a stage's deadline nor the verify times
     * its budgets judge. A boat VM is its own host. A landing gate on a machine place does not wait: its slice already
     * wins that machine's CPU over Development, so it only says it has started, for background work to leave room after it.
     */
    async function waitForHostBudget(placement: GatePlacement | undefined, jobClass: HostBudgetClass, signal: AbortSignal): Promise<void> {
      if (!input.hostShell || placement === "boat") return;
      const machine = placement?.startsWith("machine:") ? placement.slice("machine:".length) : null;
      if (jobClass === "gate" && machine) {
        await stampHostStart(input.hostShell(machine), signal);
        return;
      }
      let waiting = false;
      const { waited, waitedMs } = await awaitHostBudget({ shell: input.hostShell(machine), job: `This ${operation.kind}`, host: machine ?? config.name ?? "the runner host", jobClass, signal,
        onWait: (line) => {
          if (!waiting) { waiting = true; setStage("waiting-for-budget"); }
          progress(`[verify] ${line}`);
        }, ...input.hostBudgetPollMs === undefined ? {} : { pollMs: input.hostBudgetPollMs } });
      if (waited) append(operation.id, { type: "host_budget_waited", placement: placement ?? "host", waitedMs });
      if (waiting) setStage("verifying");
    }
    /**
     * Where this attempt's gate runs, chosen as its commands are about to run (SJ-189): the repository's runner-host gate
     * place when it has one and it is free, otherwise the remote verifier. While boat is held, a gate that finds the host
     * place busy returns to the queue as any boat-held landing does, never opening boat.
     */
    async function openGate(base: string, candidate: string, integrationBranch: string, context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>, signal: AbortSignal): Promise<GateAttempt> {
      const key = repositoryKey(operation.repo);
      const name = configuredRepository(config, operation.repo)?.gateMachine;
      if (name) {
        const places = machinePlaces[name] ?? [];
        // Every place held means queue, never boat (SJ-200): a released place is handed to the gate that waited longest,
        // and a gate never overtakes those already queued.
        let place: number | null = null;
        let queuedMs: number | undefined;
        for (;;) {
          place = machineGates.queued(name) ? null : machineGates.take(name, places.length, (index) => places[index]!.available());
          if (place !== null || !machineGates.anyHeld(name)) break;
          if (queuedMs === undefined) {
            progress(`[verify] every ${name} gate place is busy; queued for one`);
            queuedMs = 0;
            // A screen waits off the runner's workers, as it would run there: its gate goes to the machine or boat.
            if (prefix?.screen && prefix.screen.phase !== "authoritative") { admitted.delete(operation.id); wakeMain(); wakeDeploys(); }
          }
          const waited = await machineGates.wait(name, signal);
          queuedMs += waited.waitedMs;
          // Cancelled or invalidated as a place was handed over: pass it on rather than hold it with no gate.
          if (signal.aborted && waited.place !== null) machineGates.release(name, waited.place);
          signal.throwIfAborted();
          if (waited.place === null) continue;
          if (places[waited.place]!.available()) { place = waited.place; break; }
          // Handed a place that went down: free it, so waiters look again rather than pass it between them.
          machineGates.free(name, waited.place);
        }
        if (queuedMs !== undefined) {
          progress(`[verify] waited ${Math.round(queuedMs / 1000)} s for a ${name} gate place`);
          append(operation.id, { type: "gate_waited", placement: `machine:${name}`, waitedMs: queuedMs });
        }
        let reason = places.find((entry) => !entry.available())?.reason() || "machine place unavailable";
        if (place !== null) {
          const started = Date.now();
          const screening = prefix?.screenSlot !== undefined && prefix.screen?.phase !== "authoritative";
          const slot = screening ? prefix!.screenSlot! : prefix?.slot ?? 0;
          try {
            const attempt = await places[place]!.open({ repo: operation.repo, slot, screening, checkout, base, candidate, integrationBranch, environment: await buildCheckEnvironment(), signal });
            const placement = `machine:${name}` as const;
            append(operation.id, { type: "remote_verification", phase: "ready", machine: attempt.machine, placement, slot, ...(screening ? { screening: true } : {}), candidate, tree: attempt.tree, setupMs: Date.now() - started, usage: null });
            progress(`[verify] gate runs on ${attempt.executor.host}`);
            machinePlaceUp(name);
            return { attempt, started, placement, place };
          } catch (error) {
            machineGates.release(name, place);
            signal.throwIfAborted();
            reason = message(error).slice(0, 2000);
            const remote = (error as RemoteOpenFailure)?.remote;
            if (remote) append(operation.id, { type: "remote_verification", phase: "failed", ...remote, placement: `machine:${name}`, setupMs: Date.now() - started, infrastructure: true, reason });
          }
        } else {
          // Recover in the background. This gate uses boat while health is unproven.
          for (const entry of places) void entry.recover?.([]).then(wakeMain).catch(() => undefined);
        }
        // Boat is only for a place that is down, and it is never quiet: the landing says so, and so does the runner.
        progress(`warning: ${name}'s gate place is down (${reason}); this gate runs on a boat VM instead`);
        machinePlaceDown(name, reason);
        const cause = "infrastructure" as const;
        append(operation.id, { type: "gate_fallback", placement: `machine:${name}`, cause, reason });
        if (boatHolds.has(operation.repo)) throw Object.assign(new Error(`Remote executor unavailable (boat): boat is held; ${reason}`), { boatUnavailable: true });
        return openRemote(base, candidate, integrationBranch, signal);
      }
      if (hostPlaceFree(operation.repo)) {
        hostGates.set(key, operation.id);
        try { return await openHost(candidate, context); }
        catch (error) { hostGates.delete(key); throw error; }
      }
      if (configuredRepository(config, operation.repo)?.hostPlaces === 1 && boatHolds.has(operation.repo))
        throw Object.assign(new Error(`Remote executor unavailable (boat): boat is held and the runner host's gate place is busy`), { boatUnavailable: true });
      return openRemote(base, candidate, integrationBranch, signal);
    }
    /** The runner host's gate place for this attempt: its own checkout, installed and holding exactly `candidate`. */
    async function openHost(candidate: string, context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>): Promise<GateAttempt> {
      const started = Date.now();
      const screening = prefix?.screenSlot !== undefined && prefix.screen?.phase !== "authoritative";
      const slot = screening ? prefix!.screenSlot! : prefix?.slot ?? 0;
      progress(`[verify] the runner host's gate place is free: the gate runs here, in ${checkout}`);
      const attempt = await openHostAttempt({ executor, checkout, candidate,
        install: async () => landingIO.prepareCandidateDependencies(checkout, context, await revisionFacts(checkout, candidate), progress,
          (request) => run(request, "dependencies")) })
        .catch((error: unknown) => {
          append(operation.id, { type: "remote_verification", phase: "failed", machine: hostMachine(executor.host),
            reason: message(error).slice(0, 2000), usageBefore: null, usage: null });
          throw error;
        });
      append(operation.id, { type: "remote_verification", phase: "ready", machine: attempt.machine, placement: "host", slot, ...(screening ? { screening: true } : {}), candidate, tree: attempt.tree, setupMs: Date.now() - started, usage: null });
      progress(`[verify] gate runs on ${attempt.executor.host}`);
      return { attempt, started, placement: "host" };
    }
    /** The remote verifier's machine for this attempt, holding exactly `candidate` on `base`. */
    async function openRemote(base: string, candidate: string, integrationBranch: string, signal: AbortSignal): Promise<GateAttempt> {
      const started = Date.now();
      const screening = prefix?.screenSlot !== undefined && prefix.screen?.phase !== "authoritative";
      const slot = screening ? prefix!.screenSlot! : prefix?.slot ?? 0;
      progress(`[verify] preparing a remote verifier for ${candidate.slice(0, 12)}`);
      const paused = new AbortController();
      const unsubscribe = log.subscribe(({ event }) => { if (event.type === "paused") paused.abort(); });
      if (log.paused()) paused.abort();
      // Only this open's own failure says no machine was supplied; an earlier one's verdict never carries over.
      remoteUnavailable = undefined;
      const attempt = await remoteVerification!.open({ repo: operation.repo, slot, screening, retrying: remoteUnavailableRetries() > 0, checkout, base, candidate, integrationBranch, signal: AbortSignal.any([signal, paused.signal]) }).catch((error: RemoteOpenFailure) => {
        if (paused.signal.aborted && !signal.aborted) throw new BoatPaused("Runner paused while waiting for boat");
        if (error?.remote) append(operation.id, { type: "remote_verification", phase: "failed", ...error.remote, reason: error.message.slice(0, 2000) });
        remoteUnavailable = error?.machineUnavailable ? message(error) : undefined;
        throw error;
      }).finally(unsubscribe);
      append(operation.id, { type: "remote_verification", phase: "ready", machine: attempt.machine, placement: "boat", slot, ...(screening ? { screening: true } : {}), candidate, tree: attempt.tree, setupMs: Date.now() - started, usage: attempt.usage });
      progress(`[verify] gate runs on ${attempt.executor.host}`);
      return { attempt, started, placement: "boat" };
    }
    /** Records what the machine's checkout held after the gate; a gate that changed the candidate's files is no evidence for it. */
    async function closeRemote({ attempt, started, placement, place }: GateAttempt): Promise<void> {
      try {
        const after = await attempt.finish();
        append(operation.id, { type: "remote_verification", phase: "finished", machine: attempt.machine, ...after, machineMs: Date.now() - started });
        if (after.memory?.oomKills)
          progress(`[verify] ${attempt.executor.host}'s memory limit killed ${after.memory.oomKills} process(es) in this gate (peak ${Math.round(after.memory.peakBytes / 1024 ** 3)} GB): a failing check may be the limit, not the candidate`);
        if (after.tree !== attempt.tree)
          throw new GateDrift(`The gate changed ${after.trackedChanges} file(s) of the candidate on ${attempt.executor.host}; its result is not evidence for the candidate`);
      } finally {
        // A machine place whose cleanup cannot be confirmed quarantines itself (machine-verifier.ts); that is the place's
        // problem, not the candidate's, so it neither fails a green gate nor hides a gate that changed the candidate.
        try {
          await attempt.close().catch((error: unknown) => {
            if (!placement.startsWith("machine:")) throw error;
            progress(`[verify] ${placement} quarantined after this gate: ${message(error).slice(0, 500)}`);
          });
        }
        finally {
          if (placement.startsWith("machine:") && place !== undefined) { machineGates.release(placement.slice("machine:".length), place); wakeMain(); }
          if (placement === "host" && hostGates.get(repositoryKey(operation.repo)) === operation.id) {
            hostGates.delete(repositoryKey(operation.repo));
            wakeMain();
          }
        }
      }
    }
    // Finalization, then publication, of an integrated commit (completeLanding).
    async function finishIntegration(context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>, commitId: string, publisher = checkout, expectedBase?: string): Promise<void> {
      setStage("finalizing");
      let targetReached = false;
      const tail = await completeLanding(publisher, context, commitId, { ...(environment ? { environment } : {}), expectedBase, runCommand: run, onTargetReached: () => { targetReached = true; }, onPublishing: () => setStage("publishing") })
        .catch((error: unknown) => { throw new HeldIntegration(commitId, stage === "publishing" ? "publishing" : "finalizing", message(error), undefined, targetReached); });
      if (tail.timings) {
        const { finalizingStartedAt, publishingStartedAt, finishedAt } = tail.timings;
        append(operation.id, { type: "stage_detail", stage: "finalizing", durationMs: 0, migrateDurationMs: Math.max(0, (publishingStartedAt ?? finishedAt) - finalizingStartedAt) });
        if (publishingStartedAt !== undefined) append(operation.id, { type: "stage_detail", stage: "publishing", durationMs: 0, pushDurationMs: Math.max(0, finishedAt - publishingStartedAt), remoteMoved: !tail.publication.ok && /remote.*(?:mov|chang|refus)|(?:mov|chang).*remote/i.test(tail.publication.reason ?? "") });
      }
      if (!tail.postIntegration.ok)
        throw new HeldIntegration(commitId, "finalizing", `Post-integration ${tail.postIntegration.status}: ${tail.postIntegration.reason ?? "no reason recorded"}`, tail.postIntegration.output, targetReached);
      if (!tail.publication.ok) throw new HeldIntegration(commitId, "publishing", tail.publication.reason ?? "Integration publication failed", undefined, targetReached);
      if (log.held().some((entry) => entry.repo === operation.repo && entry.commitId === commitId))
        append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId, retried: true });
    }
    const setStage = (next: RunnerStage) => {
      // A kill that landed between runs stops the operation before it moves a branch.
      if (controller.signal.aborted) throw authorityError();
      if (prefix?.invalidation.signal.aborted) throw new Error("Prepared prefix invalidated by its predecessor");
      const first = stage === "queued";
      if (!first) append(operation.id, stageDetail());
      stageStarted = Date.now();
      stage = next === "verifying" && prefix?.screen && prefix.screen.phase !== "authoritative" ? "screening" : next;
      if (operation.kind === "verification") {
        clearTimeout(verificationTimer);
        const timeoutMs = verificationStageTimeoutMs ?? (next === "fetching" ? 5 * 60_000 : next === "installing" ? 30 * 60_000 : 60 * 60_000);
        verificationTimer = setTimeout(() => {
          verificationTimeout = `Pre-verification timed out during ${next} after ${timeoutMs}ms; nothing was published`;
          controller.abort();
        }, timeoutMs);
        verificationTimer.unref?.();
      }
      running.set(operation.id, { operation, stage, controller });
      append(operation.id, { type: "stage", stage, health: health(), ...first && shortAdmitted.has(operation.id) ? { shortLanding: true as const } : {} });
    };
    const execute = async () => {
      if (prefix?.predecessor) {
        // This attempt's own authority: a rebuilt attempt gets a fresh controller.
        const invalidation = prefix.invalidation;
        const predecessor = prefix.predecessor;
        // A screen that leaves its predicted prefix (below) no longer depends on it.
        const invalidate = () => { if (prefix.predecessor === predecessor) invalidation.abort(); };
        predecessor.invalidation.signal.addEventListener("abort", invalidate, { once: true });
        if (predecessor.invalidation.signal.aborted) invalidate();
        void predecessor.completed.promise.then((published) => { if (!published) invalidate(); });
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
        configured.delete(checkout);
      }
      // Recover a committed rename while resolving policy, before requiring its
      // local bookmark. Fetch and track only the new target; never delete the old one.
      let context = await workspaceContext(checkout, undefined, { fetchMissingBookmarks: true });
      if (!context || context.current.name !== "default") throw new Error("Runner checkout must be the default jj workspace");
      integrationBranch = context.integrationBranch;
      remote = context.configuration.remote ?? "origin";
      const branch = context.integrationBranch;
      // Mutable integration history is what the candidate cleanup below would abandon.
      await configureCheckout(checkout, { ...RUNNER_JJ_DEFAULTS, ...config.jj, ...integrationTrunkConfig(branch, remote) });
      const retained = operation.kind === "landing" ? log.events({ operationId: operation.id }).find((row) => row.event.type === "source_retained")?.event : undefined;
      const retainedSource = retained?.type === "source_retained" ? retained : undefined;
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch, ...operation.kind === "landing" && !retainedSource ? ["--branch", operation.bookmark] : []]);
      // A landing gated on a machine place, which receives the candidate as a bundle, needs the candidate's files here
      // only to generate migrations, so its slot checkout holds just slipjay.json: each working-copy switch then takes
      // about 0.15 s on peach-live instead of 4 s (SJ-200). Installing for a migration widens it first. A host place
      // gates in this checkout, so it is never narrowed for one.
      if (operation.kind === "landing" && prefix && configuredRepository(config, operation.repo)?.gateMachine) await narrowCheckout(checkout);
      if (retainedSource) await importSubmissionSource(home, operation.repo, operation.id, retainedSource, checkout);
      const sourceRevision = retainedSource ? operation.commitId : operation.kind === "landing" ? operation.bookmark : operation.commitId;
      if (prefix) {
        if ((await revisionFacts(checkout, retainedSource ? operation.commitId : `${prefix.operation.bookmark}@${remote}`)).commitId !== operation.commitId)
          throw new Error("Fetched source differs from submitted commit");
        await retainLandingSource(checkout, operation.id, prefix.attempt, operation.commitId);
        append(operation.id, { type: "attempt_started", attempt: prefix.attempt, source: operation.commitId, checkout });
      }
      if (operation.kind === "audit") {
        verdict = await audit(branch, remote);
        return;
      }
      // The release checkout holds no integration: what the repository lane finishes is not its concern.
      if (operation.kind === "release" || operation.kind === "verification") {
        await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
        if (operation.kind === "release") await release(operation);
        else verdict = await verify();
        return;
      }
      const recordedHold = log.held().find((entry) => entry.repo === operation.repo);
      let settled = operation.commitId;
      if (!prefix && recordedHold && await revisionExists(checkout, `${recordedHold.commitId} & ::${branch}@${remote}`))
        append(operation.id, { type: "integration_recovered", repo: operation.repo, commitId: recordedHold.commitId });
      // A commit integrated by an earlier turn but never published (a failed push, or
      // a restart after finalization) may already be applied to the external target.
      // Finish it before anything moves the bookmark: dropping it would orphan that state.
      if (!prefix && await jj(checkout, ["--ignore-working-copy", "log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"])) {
        const held = (await revisionFacts(checkout, branch)).commitId;
        if (!log.held().some((entry) => entry.repo === operation.repo && entry.commitId === held))
          append(operation.id, { type: "integration_held", repo: operation.repo, commitId: held, reason: "An earlier integration is not yet published" });
        progress(`Finishing ${held.slice(0, 12)}, integrated by an earlier landing but not yet published`);
        await finishIntegration(context, held);
        settled = held;
        setStage("fetching");
      }
      if (operation.kind === "recovery") {
        // Nothing is held now, by this turn or by whoever published it first: the remote either has the commit or the hold is gone.
        if (!await revisionExists(checkout, `${settled} & ::${branch}@${remote}`)) {
          // The fetch above succeeded, so the remote does not have it: the integration was released or reconciled outside this recovery turn.
          // Release the hold, or every reland of the commit would be sent back to a recovery that finds nothing.
          const stale = `${settled.slice(0, 12)} is neither held nor on ${branch}@${remote}`;
          if (log.held().some((entry) => entry.repo === operation.repo && entry.commitId === settled))
            append(operation.id, { type: "integration_released", repo: operation.repo, commitId: settled, reason: stale });
          verdict = { type: "cancelled", reason: `${stale}; nothing to recover. Land the commit again if it is still wanted` };
          return;
        }
        const [base = ""] = (await jj(checkout, ["log", "-r", `${settled}-`, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n");
        verdict = { type: "landed", base, commitId: settled, branch, remote };
        return;
      }
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      let predecessor: PreparedPrefix | null = null;
      if (prefix?.predecessor) {
        progress(`[screen] waiting for ${prefix.predecessor.operation.id} ahead to prepare its candidate`);
        predecessor = await withAuthority(prefix.predecessor.prepared.promise);
        if (!predecessor) throw new Error("Predecessor did not prepare a valid prefix");
        if (!predecessor.overlap && prefix.screen) {
          // A migration or policy change publishes a commit no dependent can predict: screen on the tip.
          progress(`[screen] ${predecessor.artifact.operationId} ahead changes migrations or policy; screening on the integration tip instead`);
          prefix.predecessor = undefined;
          predecessor = null;
        }
        else if (!predecessor.overlap) {
          setStage("waiting-for-predecessor");
          if (!await withAuthority(prefix.predecessor.completed.promise)) throw new Error("Predecessor did not publish");
          await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch]);
        }
        if (predecessor) {
          progress(`[screen] importing the candidate of ${predecessor.artifact.operationId} ahead (${predecessor.artifact.candidate.slice(0, 12)} on ${predecessor.artifact.base.slice(0, 12)})`);
          await importLandingArtifact(checkout, predecessor.checkout, predecessor.artifact);
          await jj(checkout, ["bookmark", "set", branch, "-r", predecessor.artifact.candidate]);
        }
      }
      // A screen on the tip alone has fixed its base here; preparation rebases onto this same commit. Record it
      // now, so a publication during the install and generation below already overtakes it.
      if (prefix?.screen && !prefix.predecessor) prefix.base = (await revisionFacts(checkout, branch)).commitId;
      // Read the freshly fetched integration policy, rather than an earlier warm tip. It may rename the
      // integration branch, so this resolves the branch again rather than only reading its policy.
      context = await workspaceContext(checkout);
      if (!context) throw new Error("Runner checkout context is unavailable");
      provenancePolicy = context.configuration;
      tracker = context.configuration.tracker;
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
      const commits = await jj(checkout, ["--ignore-working-copy", "log", "-r", sourceRevision, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (commits !== operation.commitId) throw new Error(`Candidate bookmark ${operation.bookmark} does not resolve to submitted commit ${operation.commitId}`);
      const visible = await jj(checkout, ["--ignore-working-copy", "log", "-r", `change_id(${operation.changeId})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (!prefix && !retainedSource && (visible.split("\n").filter(Boolean).length !== 1 || visible !== operation.commitId))
        throw new Error(`Submitted change ${operation.changeId} must have exactly one visible commit matching ${operation.commitId}`);
      if (prefix || retainedSource) await duplicateLandingSource(checkout, operation.commitId, branch);
      else await jj(checkout, ["edit", operation.commitId]);
      const description = await jj(checkout, ["--ignore-working-copy", "log", "-r", operation.commitId, "--no-graph", "-T", "description"]);
      append(operation.id, { type: "landing_title", title: description.split("\n")[0] ?? "" });
      const trailer = (name: string) => { const value = new RegExp(`^${name}:\\s*#?(\\d+)\\s*$`, "m").exec(description)?.[1]; return value ? Number(value) : undefined; };
      const identity = log.events({ operationId: operation.id }).findLast((row) => row.event.type === "identity")?.event;
      append(operation.id, { ...(identity?.type === "identity" ? identity : { type: "identity", submitterKind: "unknown", submitterId: operation.submittedBy, workspace: "unknown", machine: operation.submittedBy }), type: "identity", ticket: trailer("Ticket"), spec: trailer("Spec") ?? (identity?.type === "identity" ? identity.spec : undefined) });
      await validateCandidatePolicy(checkout, operation.commitId);
      // The change's shape is recorded from the prepared candidate, by prepareCandidateDependencies and
      // verification: `branch..submitted source` also counts what other landings changed while the
      // submission waited, so it is neither the change's size nor a cheaper reading of it.
      const candidateContext = context;
      const candidateOptions = {
        onCandidate: (candidate: string, base: string) => { checkedCandidate = { candidate, base }; },
        originalSource: operation.commitId,
        pinnedSource: Boolean(prefix || retainedSource),
        environment, onProgress: progress,
        onStage: (next) => { if (next !== "cleaning") setStage(next); },
        runCommand: run,
        adapter: {
          verify: async ({ base, candidate }) => {
            await validateCandidatePolicy(checkout, candidate);
            const { budgets } = candidateContext.configuration;
            append(operation.id, { type: "verification_base", base, candidate, ...(budgets ? { budgets } : {}) });
            await recordShape(checkout, candidateContext.integrationBranch, candidate, candidateContext.configuration.migrationFinalization);
            // Decided for each prepared candidate, so again after any rebase or rebuilt attempt.
            const settings = await settingsLanding({
              changedPaths: async (from, to) => (await jj(checkout, ["diff", "--from", from, "--to", to, "--name-only"])).split("\n").filter(Boolean),
              policyText: async (commitId) => readPolicyTextAtCommit(checkout, commitId),
              description: async (commitId) => jj(checkout, ["log", "-r", commitId, "--no-graph", "-T", "description"]),
            }, base, candidate, (environment ?? (() => process.env))().PATH);
            if (settings) {
              progress(`[verify] skipped: ${settings.reason}`);
              append(operation.id, { type: "verification_skipped", base, candidate, fields: settings.fields, reason: settings.reason });
              append(operation.id, { type: "verification_passed", base, candidate });
              return verificationEvidence([], [], settings.checks);
            }
            const abortSignal = AbortSignal.any([controller.signal, ...prefix ? [prefix.invalidation.signal] : []]);
            const remote = configuredRepository(config, operation.repo)?.verifier
              ? await openGate(base, candidate, candidateContext.integrationBranch, candidateContext, abortSignal) : undefined;
            if (prefix?.screen && prefix.screen.phase !== "authoritative") {
              prefix.screen.phase = "screening";
              // A screen whose gate runs elsewhere hands back its worker; one in the host place keeps it, so the queue
              // admits no more host work beside it.
              if (remote?.placement !== "host") {
                admitted.delete(operation.id);
                wakeMain(); wakeDeploys();
              }
            }
            const verification = await (async () => {
              try {
                await waitForHostBudget(remote?.placement, "gate", abortSignal);
                return await runRequiredVerification({
                  root: checkout, checks: candidateContext.configuration.requiredLandingVerification,
                  environment, onProgress: progress, run: remote ? (request: BoundedProcessRequest, purpose?: RunPurpose) => run(request, purpose, remote.attempt.executor) : run, abortSignal,
                });
              } finally { if (remote) await closeRemote(remote); }
            })();
            if (prefix?.invalidation.signal.aborted) throw new Error("Exact predecessor invalidated this attempt; late verification success is not evidence");
            if (verification.status === "passed") append(operation.id, { type: "verification_passed", base, candidate });
            return verification;
          },
        },
      } satisfies import("../landing/landing-candidate.ts").CandidateOptions;
      const candidateIO = {
        ...landingIO,
        async assertStackConflictFree(cwd, branch, changeId) {
          try {
            await landingIO.assertStackConflictFree(cwd, branch, changeId);
          } catch (error) {
            rebaseConflict = true;
            conflictFiles = await conflictedPaths(cwd, changeId);
            throw error;
          }
        },
        landingPreview: async () => ({ context: candidateContext, target: await revisionFacts(checkout, prefix || retainedSource ? "@" : operation.commitId) }),
        ensureLandingDescription: async (_cwd, _context, target) => target,
        async prepareCandidateDependencies(cwd, candidate, target, onProgress, runCommand) {
          const paths = await recordShape(cwd, candidate.integrationBranch, target.commitId, candidate.configuration.migrationFinalization);
          // When the gate runs on a remote verifier, that VM installs the candidate itself and proves its tree unchanged, so
          // this checkout needs dependencies only to generate migrations here. Skipping it saves a frozen install (19 to
          // 80 s on YardSmith) on every other landing.
          const migration = candidate.configuration.migrationFinalization;
          const triggers = [...migration?.triggerPaths ?? [], ...migration?.artifactPaths ?? []];
          if (configuredRepository(config, operation.repo)?.verifier && !paths.some((path) => triggers.some((root) => path === root || path.startsWith(`${root}/`)))) {
            onProgress?.("[deps] not installed on the runner: the gate's VM installs the candidate, and it generates no migration");
            return;
          }
          await widenCheckout(cwd);
          setStage("installing");
          installSource = await stat(join(cwd, "node_modules")).then(() => "existing" as const, () => "fresh" as const);
          await landingIO.prepareCandidateDependencies(cwd, candidate, target, onProgress, runCommand);
        },
      } satisfies import("../landing/landing-candidate.ts").LandingIO;
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
      append(operation.id, { type: "integrated", base, commitId: artifact.commitId, process: (await declaredEnvironments(operation.repo, artifact.commitId, readLandedPolicy)).process });
      await finishIntegration(candidateContext, artifact.commitId);
      verdict = { type: "landed", base, commitId: artifact.commitId, branch, remote };
      async function integratePrefix(prepared: PreparedLandingCandidate) {
        const artifact: LandingArtifact = { operationId: operation.id, attempt: prefix!.attempt, source: operation.commitId,
          base: prepared.base, candidate: prepared.artifact.commitId };
        const policy = candidateContext.configuration;
        // Reuse verification's exact-base observation after rebase and generation.
        // Submitted paths can disappear or change when the prefix is prepared.
        // Diff against the exact prepared base, not the bookmark, so a move cannot change what decides overlap.
        const paths = await recordShape(checkout, artifact.base, artifact.candidate, policy.migrationFinalization);
        const triggersMigration = paths.some((path) => policy.migrationFinalization?.triggerPaths.some((root) => path === root || path.startsWith(`${root}/`)));
        const overlap = !paths.includes(EXECUTION_POLICY_PATH) && !triggersMigration
          && !postIntegrationPolicy(policy.postIntegration)?.readByGate;
        await retainLandingArtifact(checkout, artifact);
        append(operation.id, { type: "attempt_prepared", ...artifact, checkout, overlap,
          ...(predecessor ? { predecessor: { operationId: predecessor.artifact.operationId, attempt: predecessor.artifact.attempt, candidate: predecessor.artifact.candidate } } : {}) });
        prefix!.overlap = overlap;
        prefix!.base = artifact.base;
        prefix!.prepared.resolve({ artifact, checkout, overlap });
        // The screen's own evidence, as opposed to a rebuild that verifies on the authoritative lane.
        const screened = Boolean(prefix!.screen && prefix!.screen.phase !== "authoritative");
        const behind = prefix!.predecessor?.operation.id;
        const verified = await verifyPreparedCandidate(checkout, prepared, candidateOptions, candidateIO);
        if (prefix!.screen && prefix!.screen.phase !== "authoritative") {
          admitted.delete(operation.id);
          prefix!.screen.phase = "passed";
          prefix!.screen.passedAt = ++screenPassOrder;
          setStage("waiting-for-predecessor");
          wakeMain();
          await withAuthority(prefix!.screen.ready.promise);
        }
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
            configured.delete(publisher);
          }
          await configureCheckout(publisher, { ...RUNNER_JJ_DEFAULTS, ...config.jj });
          await fetchIntegrationIfMoved(publisher, remote!, branch, await gitOf(publisher));
          const canonical = await workspaceContext(publisher);
          if (!canonical) throw new Error("Canonical publisher is unavailable");
          // Bookmark reads: neither depends on the checkout's files, so neither snapshots them.
          const local = (await revisionFacts(publisher, branch, { ignoreWorkingCopy: true })).commitId;
          let tip = (await revisionFacts(publisher, `${branch}@${remote}`, { ignoreWorkingCopy: true })).commitId;
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
          append(operation.id, { type: "integrated", base: artifact.base, commitId: artifact.candidate, process: (await declaredEnvironments(operation.repo, artifact.candidate, readLandedPolicy)).process });
          await finishIntegration(canonical, artifact.candidate, publisher, artifact.base);
          restartOvertakenScreens(operation.repo, operation.id, artifact.candidate);
          // Recorded once published, so the ledger never claims a reuse for a publication that failed.
          if (screened) {
            const reason = behind
              ? `the integration tip was the candidate of ${behind}, the predicted prefix this screen ran behind, so the published tree is the one its gate passed`
              : "the integration tip was still the base this screen ran on, so the published tree is the one its gate passed";
            progress(`[screen] published on screen attempt ${artifact.attempt} with no second gate: ${reason}`);
            append(operation.id, { type: "screen_reused", attempt: artifact.attempt, base: artifact.base, candidate: artifact.candidate, ...behind ? { behind } : {}, reason });
          }
          return result;
        });
      }
    };
    try {
      // A pre-verification publishes nothing. Race all its awaits, including post-install
      // filesystem inspection, and fence late continuations with the same signal.
      if (operation.kind === "verification") await withAuthority(withWorkspaceCommandSignal(controller.signal, () => withCommandTimings(commandTimings, execute), pendingCommands));
      else await withCommandTimings(commandTimings, execute);
    } catch (error) {
      // A fresh attempt: once for a dependent whose predecessor's outcome invalidated it (it then
      // has no predecessor), and once for a head whose remote base moved. Its own failure, an
      // owner kill or a pause never rebuilds.
      // A screen that published nothing yet and whose predicted prefix fell away (it failed, was
      // stopped or rebuilt), or that conflicts with that prefix, returns to the queue and screens
      // again behind what is predicted then. Its result on a prefix that will not land diagnoses nothing.
      let leftPrediction = false;
      const ahead = prefix?.screen && !controller.signal.aborted && !log.operation(operation.id)?.result ? prefix.predecessor : undefined;
      if (ahead && rebaseConflict && !prefix!.invalidation.signal.aborted) {
        unpredicted.add(operation.id);
        leftPrediction = true;
      } else if (ahead) {
        // Any other failure stands only if the prefix it ran behind lands: wait for that, without a worker.
        if (!prefix!.invalidation.signal.aborted) {
          admitted.delete(operation.id);
          wakeMain();
          const stopped = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await Promise.race([ahead.completed.promise, stopped(controller.signal), stopped(prefix!.invalidation.signal)]);
        }
        leftPrediction = !controller.signal.aborted && (prefix!.invalidation.signal.aborted || !await ahead.completed.promise);
      }
      const overtaken = prefix?.overtakenBy;
      retryPrefix = Boolean(prefix && !leftPrediction && !controller.signal.aborted && !log.paused()
        && !overtaken && (prefix.predecessor && !prefix.screen ? prefix.invalidation.signal.aborted : error instanceof PrefixInvalidated && !prefix.remoteRebuilt));
      // A failed reset after a publication failure must not append a second verdict.
      if (log.operation(operation.id)?.result) progress(message(error));
      else if (verificationTimeout) verdict = { type: "failed", stage, reason: verificationTimeout };
      else if (controller.signal.aborted && stopping.has(operation.id)) {
        const reason = stopping.get(operation.id)!;
        stopping.delete(operation.id);
        const started = log.events({ operationId: operation.id }).map((row) => row.event).find((event) => event.type === "batch_started");
        if (started?.type === "batch_started") append(operation.id, { type: "batch_outcome", outcome: "stopped", base: started.base, head: started.head, machine: started.machine, reason });
        verdict = { type: "cancelled", reason };
      }
      else if (controller.signal.aborted) verdict = { type: "cancelled", reason: OWNER_KILL_REASON };
      else if (leftPrediction) {
        progress(`[screen] ${unpredicted.has(operation.id) ? `conflicts with ${ahead!.operation.id} ahead; screening again on the integration tip alone`
          : `${ahead!.operation.id} ahead will not publish as predicted; screening again`}`);
        verdict = { type: "yielded", to: "a new predicted prefix" };
      }
      else if (overtaken) verdict = { type: "yielded", to: log.paused() ? "the runner pause" : "the moved integration tip" };
      else if (prefix?.invalidation.signal.aborted) verdict = { type: "failed", stage: "waiting-for-predecessor", reason: "Exact predecessor invalidated this attempt; its verification does not diagnose the submitted source" };
      else if (operation.kind === "landing" && (error instanceof BoatPaused || (error as RemoteOpenFailure)?.boatUnavailable && remoteVerification?.probe)) {
        retryPrefix = false;
        if (!(error instanceof BoatPaused)) holdForBoat(operation.repo, message(error));
        verdict = { type: "yielded", to: error instanceof BoatPaused ? "the runner pause" : "boat availability" };
      }
      // A landing whose remote executor was never available ran nothing of the candidate, so it is no verdict on the
      // source: it returns to the queue a bounded number of times, and the attempt past that bound fails as it did
      // before. A pause that began meanwhile leaves it queued until the runner resumes.
      else if (operation.kind === "landing" && remoteUnavailable !== undefined && log.paused()) verdict = { type: "yielded", to: "the runner pause" };
      else if (operation.kind === "landing" && remoteUnavailable !== undefined && remoteUnavailableRetries() < REMOTE_UNAVAILABLE_RETRIES) {
        const retried = remoteUnavailableRetries() + 1;
        progress(`[verify] the remote executor was not ready before any gate command ran: ${remoteUnavailable}; returned to the queue to try again (${retried} of ${REMOTE_UNAVAILABLE_RETRIES})`);
        verdict = { type: "yielded", to: AWAITING_REMOTE_EXECUTOR };
      }
      else if (error instanceof CandidatePolicyRefusal) verdict = { type: "declined", reason: error.message, paths: [EXECUTION_POLICY_PATH] };
      else if (error instanceof HeldIntegration) {
        append(operation.id, { type: "integration_held", repo: operation.repo, commitId: error.commitId, reason: error.message, targetReached: error.targetReached, branch: integrationBranch, remote });
        verdict = { type: "failed", stage: error.stage, reason: error.message, ...(error.output ? { output: error.output } : {}) };
      }
      else if (error instanceof RequiredVerificationError) verdict = {
        type: "failed", stage: prefix?.screen && prefix.screen.phase !== "authoritative" ? "screening" : "verifying", reason: error.message,
        ...failedVerification(error.evidence),
      };
      else verdict = { type: "failed", stage, reason: message(error) };
      if (prefix && verdict?.type !== "landed") {
        const reason = overtaken ? `${overtaken} published past this screen's base ${prefix.base?.slice(0, 12)}, so it could not publish what it verified; screening again on the new tip` : message(error);
        append(operation.id, { type: "attempt_invalidated", attempt: prefix.attempt, reason });
        if (overtaken) progress(`[screen] ${reason}`);
        prefix.invalidation.abort();
        prefix.prepared.resolve(null);
        if (retryPrefix && prefix.screen) {
          // A screen whose exact base moved anyway rebuilds once on the authoritative lane, on the exact tip.
          prefix.predecessor = undefined;
          prefix.remoteRebuilt = true;
        }
        else if (retryPrefix && prefix.predecessor) {
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
        if (retryPrefix && boatHolds.has(operation.repo)) {
          retryPrefix = false;
          verdict = { type: "yielded", to: "boat availability" };
        }
        if (retryPrefix) {
          // Fence later admission onto the fresh attempt before dependent cleanup can wake it.
          prefix.attempt += 1;
          prefix.prepared = deferred();
          prefix.invalidation = new AbortController();
          prefix.base = undefined;
          verdict = undefined;
        }
        else prefix.completed.resolve(false);
      }
    } finally {
      stopSuperseded?.();
      clearTimeout(verificationTimer);
      // Cancellation has reached each subprocess; wait for containment to stop it before reusing the checkout.
      await Promise.allSettled([...pendingCommands]);
      const token = checkEnvironment && (await checkEnvironment.catch(() => ({} as Record<string, string>)))[BUILD_READ_TOKEN_ENV];
      if (token) buildChecks!.revoke(token);
      // This turn is over: nothing below is work the operation is still doing, so it is no longer
      // killable and a failing append cannot leave it running with no work behind it. Its settlement
      // is what ends it, and a kill may not cancel an operation that is already publishing its verdict.
      running.delete(operation.id);
      ending.add(operation.id);
      try {
        if (stage !== "queued") append(operation.id, stageDetail());
        // Delete the candidate bookmark before the verdict: an author's repository that fetches
        // every bookmark after that would otherwise import it and pin the submitted commit.
        if (!retryPrefix && verdict?.type !== "yielded" && remote && operation.kind === "landing") await cleanup(operation, checkout, remote);
        // This checkout belongs to the runner: leave failed candidates in history,
        // and start the next turn from the integration (including any held commit).
        const returnToIntegration = async () => {
          if (!integrationBranch) return;
          try { await jj(checkout, ["new", integrationBranch]); }
          catch (error) {
            const reason = `Runner checkout could not return to ${integrationBranch}: ${message(error)}`;
            progress(reason);
            if (verdict?.type === "failed") verdict = { ...verdict, reason: `${verdict.reason}\n${reason}` };
          }
        };
        // A published landing's verdict does not wait for it: nothing reads this checkout before the operation ends.
        if (verdict?.type !== "landed") await returnToIntegration();
        if (verdict?.type === "landed") {
          const publishedCommit = verdict.commitId;
          const integrated = log.events({ operationId: operation.id }).map((row) => row.event).findLast((event) => event.type === "integrated" && event.commitId === publishedCommit);
          verdict = { ...verdict, ...await declaredEnvironments(operation.repo, verdict.commitId, readLandedPolicy),
            ...integrated?.type === "integrated" && integrated.process ? { process: integrated.process } : {} };
        }
        if (verdict?.type === "failed" && operation.kind === "landing")
          await freezeProvenance(operation.id, checkout, verdict, checkedCandidate, provenancePolicy);
        if (verdict && (!prefix?.screen || !log.operation(operation.id)?.result)) append(operation.id, verdict);
        if (verdict?.type === "landed") await returnToIntegration();
        // A passed pre-verification may promote; a release that ended frees the queue for a newer candidate.
        if (operation.kind === "verification" || operation.kind === "release") await promoteAutomatically(operation.repo, operation.kind === "verification" ? operation.id : undefined);
        if (operation.kind === "recovery") retryFailedRecovery(operation.repo, verdict?.type === "failed");
        if (verdict?.type === "landed")
          await schedule(operation.repo, verdict.commitId, readLandedPolicy).catch((error: unknown) => progress(`Could not schedule deploys and resets: ${message(error)}`));
        // A reset, whatever its verdict, starts the next interval.
        if (operation.kind === "reset") await scheduleLatest(operation.repo, progress);
        // An audit with a verdict waits for the next scheduled time (an inconclusive audit ends `failed`, so it waits too); one without is due again now. What its head declared decides.
        if (operation.kind === "audit") {
          if (auditPolicy === undefined) auditScheduler.reconsider(operation.repo);
          else auditScheduler.consider(operation.repo, auditPolicy);
        }
      } catch (error) {
        // Ending an operation must never leave it open, but a published landing must not be recorded as
        // failed and a retry records its own verdict on the fresh attempt. Whatever is left here is
        // settled by restart recovery, which records a published landing as landed.
        const reason = `The runner could not finish ending ${operation.id}: ${message(error)}`;
        console.error(`[runner] ${operation.repo}: ${reason}`);
        try { progress(reason); } catch { /* the ledger is what failed */ }
        if (!retryPrefix && !log.operation(operation.id)?.result) {
          const recorded = verdict ?? { type: "failed" as const, stage, reason: `${reason}; land again` };
          try { append(operation.id, recorded); }
          catch {
            if (recorded.type !== "landed") {
              try { append(operation.id, { type: "failed", stage, reason: `${reason}; land again` }); }
              catch (again) { console.error(`[runner] ${operation.repo}: could not record the end of ${operation.id}: ${message(again)}`); }
            }
          }
        }
      } finally {
        ending.delete(operation.id);
      }
    }
    if (retryPrefix && prefix) {
      // A fresh immutable attempt, never an owner kill, hold, source replacement or paused rebuild.
      await processOperation(operation, prefix);
    }
    async function recordShape(cwd: string, revision: string, commit: string, migration: import("../policy/execution-policy.ts").MigrationFinalizationPolicy | null | undefined): Promise<string[]> {
      // Resolve the revision (a moving bookmark or an exact base) on every observation; only the diff between
      // exact objects is reusable, even if a gate changes the checkout or base.
      const base = await jj(cwd, ["--ignore-working-copy", "log", "-r", revision, "--no-graph", "-T", "commit_id"]);
      const migrationPaths = [...migration?.triggerPaths ?? [], ...migration?.artifactPaths ?? []];
      const key = JSON.stringify([cwd, base, commit, migrationPaths]);
      const cached = shapes.get(key);
      if (cached) { append(operation.id, cached.shape); return cached.touched; }
      const diff = await jj(cwd, ["diff", "--from", base, "--to", commit, "--git"]);
      const headers = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
      const paths = [...new Set(headers.map((match) => match[2]!))];
      // A rename touches both sides: moving a file out of a trigger path still changes that path.
      const touched = [...new Set(headers.flatMap((match) => [match[1]!, match[2]!]))];
      const insertions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      const roots = (prefix: string) => [...new Set(paths.flatMap((path) => path.startsWith(`${prefix}/`) ? [path.split("/")[1]!] : []))];
      const gitDirectory = await jj(cwd, ["git", "root"]);
      const tree = await workspaceRun("git", ["--git-dir", gitDirectory, "rev-parse", `${commit}^{tree}`], { cwd });
      if (tree.code !== 0) throw new Error("Could not observe candidate tree for change shape");
      const shape: Extract<OperationEvent, { type: "change_shape" }> = { type: "change_shape", files: paths.length, insertions, deletions, packages: roots("packages"), apps: roots("apps"),
        migrationBearing: paths.some((path) => migrationPaths.some((root) => path === root || path.startsWith(`${root}/`))),
        testFiles: paths.filter((path) => /(?:test|spec)\.[cm]?[jt]sx?$/.test(path)),
        fileSet: createHash("sha256").update(tree.stdout.trim()).digest("hex"),
        sizeBucket: insertions + deletions <= 100 ? "small" : insertions + deletions <= 1000 ? "medium" : "large" };
      shapes.set(key, { shape, touched });
      append(operation.id, shape);
      return touched;
    }
    /**
     * Audit the integration branch's published head: resolve its exact commit, record it, check it out and run the
     * audit its policy declares, in full. The branch itself is left alone, so a held integration stays held. An audit
     * is green only when every declared command ran and passed, with none skipped or reused; a command a missing
     * capability would skip makes it fail, never pass. A head that declares no audit ends it cancelled: nothing was run.
     */
    async function audit(branch: string, remote: string): Promise<OperationEvent> {
      const head = (await revisionFacts(checkout, `${branch}@${remote}`)).commitId;
      append(operation.id, { type: "audit_head", commit: head });
      const { configuration } = await readExactExecutionPolicy(join(checkout, ".git"), head);
      auditPolicy = configuration?.audit ?? null;
      if (!auditPolicy) return { type: "cancelled", reason: `${head.slice(0, 12)} declares no audit` };
      progress(`Auditing ${head.slice(0, 12)}`);
      await jj(checkout, ["new", head]);
      // The audit runs on the release-check place its head's batch machine names (SJ-202), so the runner's host does
      // not share it; with none, or with that place down (said and recorded), it runs here as before.
      const pool = configuration?.batchVerification?.machine;
      const held = pool ? await takeCheckPlace(pool, "audit runs on the runner host") : null;
      let gate: GateAttempt | undefined;
      try {
        if (held) {
          const started = Date.now();
          gate = { attempt: await held.place.open({ repo: operation.repo, slot: 0, screening: false, checkout, base: head, candidate: head, integrationBranch: branch, environment: await buildCheckEnvironment(), signal: controller.signal }),
            started, placement: `machine:${held.machine}` };
          append(operation.id, { type: "remote_verification", phase: "ready", machine: gate.attempt.machine, placement: gate.placement, slot: 0, candidate: head, tree: gate.attempt.tree, setupMs: Date.now() - started, usage: null });
          setStage("installing");
          const via = gate.attempt.executor;
          await prepareWorkspaceDependencies(checkout, { quiet: true, runCommand: (request) => run(request, "dependencies", via), env: (environment?.() ?? process.env) });
        }
        setStage("verifying");
        const via = gate?.attempt.executor;
        await waitForHostBudget(gate?.placement, "background", controller.signal);
        const commands = auditPolicy.commands.map((check) => [check.executable, ...check.args].join(" "));
        let verification;
        try {
          verification = await runRequiredVerification({ root: checkout, checks: auditPolicy.commands, environment, onProgress: progress, abortSignal: controller.signal,
            run: (request) => run(request, "gate", via) });
        } catch (error) {
          // Every failure a declared could-not-judge exit: the audit could not judge the suite, recorded as such on
          // its terminal event now, from the policy that ran. Anything else is an ordinary failure, as before, and a
          // kill stays a kill whatever its stopping commands exit with.
          if (!controller.signal.aborted && error instanceof RequiredVerificationError && auditInconclusive(error.evidence.failures, auditPolicy.commands))
            return { type: "failed", stage, reason: error.message, inconclusive: true, ...failedVerification(error.evidence) };
          throw error;
        }
        // A kill stops its commands, which then read as failures.
        if (controller.signal.aborted) throw new OwnerKill();
        if (verification.gaps.length) return { type: "failed", stage, reason: `The audit did not run in full, so it is not green: ${verification.gaps.map((gap) => `${gap.command} (${gap.reason || gap.capability})`).join("; ")}` };
        return { type: "audited", commit: head, commands, passed: verification.passed, skipped: [], reused: [] };
      } finally {
        try { if (gate) await closeRemote(gate); }
        finally { if (held) { machineCheckHolds.release(pool!, 0); wakeMain(); } }
      }
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
     * commit staging deployed (in process "development", one whose pre-verification passed
     * against the release base, since staging is skipped), and once the release branch holds it, production deploys
     * exactly that commit in the deploy lane, so a slow deploy never holds a landing.
     * Only publication takes the repository lane. The approval is this operation, which
     * only a kill ends once it runs, and staging evidence is never withdrawn, so neither
     * changes during verification; `confirmRelease` rechecks the planned release base.
     */
    async function release(operation: ReleaseOperation): Promise<void> {
      let { configuration } = await readExactExecutionPolicy(join(checkout, ".git"), operation.commitId);
      if (operation.automatic) {
        // No human approved it: it must still be the candidate to promote, and its decisions come from the release base's policy, not the candidate's.
        const newest = promotionCandidate(operation.repo, operation.id)?.commitId;
        if (newest !== operation.commitId) {
          append(operation.id, { type: "failed", stage, reason: `Not promoted automatically: superseded by ${newest?.slice(0, 12) ?? "a newer candidate"}` });
          return;
        }
        const base = log.verifications(operation.repo, operation.commitId).find((entry) => entry.result?.type === "verified")?.result;
        const baseConfiguration = base?.type === "verified"
          ? await readExactExecutionPolicy(join(checkout, ".git"), base.base).then((exact) => exact.configuration, () => null) : null;
        if (!baseConfiguration) {
          append(operation.id, { type: "failed", stage, reason: `Not promoted automatically: no pre-verification of ${operation.commitId.slice(0, 12)} passed against a readable release base` });
          return;
        }
        configuration = baseConfiguration;
      }
      // A repository that audits promotes only while its latest audit is not an unexplained failure.
      // Asked again under the publication lane: an audit can fail while the release verifies.
      const unexplainedAudit = () => configuration?.audit ? promotionRefusal(auditSummary({ audits: log.audits(operation.repo), landings: log.landings(operation.repo) }, new Date())) : null;
      const unexplained = unexplainedAudit();
      if (unexplained) {
        append(operation.id, { type: "failed", stage, reason: unexplained });
        return;
      }
      const promotes = Boolean(configuration?.deployments?.environments.production);
      // The release base's policy decides whether staging is skipped; a candidate cannot switch it on for itself.
      const development = operation.automatic ? skipsStaging(configuration) : await stagingSkipped(operation.repo, operation.commitId);
      if (promotes && !development && !log.deployments(operation.repo, "staging").some((entry) => entry.commitId === operation.commitId && entry.result?.type === "deployed")) {
        append(operation.id, { type: "failed", stage, reason: `Staging is not green on ${operation.commitId.slice(0, 12)}: production promotes only a commit staging deployed` });
        return;
      }
      const result = await confirmRelease(checkout, { candidate: operation.commitId, migrationsReady: operation.migrationsReady,
        onProgress: progress, onStage: setStage, run, environment: releaseEnvironment(await servedBase(operation.repo, checkout), operation.commitId), abortSignal: controller.signal,
        preverified: (plan) => {
          const passed = passedVerification(plan, log.verifications(operation.repo))?.id ?? null;
          // No human approved an automatic promotion: it publishes only what a pre-verification passed against this release base,
          // and never migrations that are not known to be additive.
          if (operation.automatic && !passed) throw new Error(`Not promoted automatically: no pre-verification of ${plan.candidate.slice(0, 12)} passed against ${plan.releaseBranch} ${plan.base.slice(0, 12)}`);
          // An owner-confirmed promotion in development mode skips staging, so a passed pre-verification stands in for it.
          if (development && !passed) throw new Error(`Not promoted: no pre-verification of ${plan.candidate.slice(0, 12)} passed against ${plan.releaseBranch} ${plan.base.slice(0, 12)}, which stands in for staging in process "development"`);
          if (operation.automatic && plan.nonAdditiveMigrations.length) throw new Error(`Not promoted automatically: it carries non-additive migrations (${plan.nonAdditiveMigrations.join(", ")}): the owner decides`);
          return passed;
        },
        publicationRefusal: unexplainedAudit,
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
        ...failedVerification(result.evidence),
      });
      else if (!result.ok && result.status === "refused") append(operation.id, { type: "failed", stage, reason: result.reason });
      else throw new Error(`Unexpected release result ${result.status}`);
    }
    /** Pre-verify the candidate as a confirm would, recording what passed against which release base. */
    async function verify(): Promise<OperationEvent> {
      const releaseBase = await releasePolicy(operation.repo, operation.commitId);
      const base = await servedBase(operation.repo, checkout);
      // A batching release branch checks the batch on its own machine and diagnoses a failure (SJ-192).
      if (releaseBase?.process === "development" && releaseBase.batchVerification && base) return batchVerify(releaseBase.batchVerification.machine, base);
      const result = await verifyRelease(checkout, { candidate: operation.commitId, onProgress: progress, onStage: setStage, run, environment: releaseEnvironment(base, operation.commitId), abortSignal: controller.signal });
      // A kill stops its commands, which then read as failures.
      if (controller.signal.aborted) throw new OwnerKill();
      if (result.ok) return { type: "verified", base: result.base, candidate: result.candidate, checks: result.checks, nonAdditiveMigrations: result.nonAdditiveMigrations };
      if (result.status === "verification_failed") return { type: "failed", stage: "verifying", reason: result.reason,
        ...failedVerification(result.evidence) };
      return { type: "failed", stage, reason: result.reason };
    }
    /**
     * The batch check of `operation.commitId`, the frozen head, measured from `base`, the commit Production serves
     * (SJ-192, `release/batch-check.ts`). Each commit it runs at gets a fresh attempt on the held `machine` (the runner
     * host when it has no remote verifier); the complete check and its rerun share the head's. Only a complete green
     * check of the exact head verifies it; anything else fails it, saying how, and a red batch routes its culprits.
     */
    async function batchVerify(machine: string, base: string): Promise<OperationEvent> {
      const plan = await planRelease(checkout, { candidate: operation.commitId }).catch((error: unknown) => error as Error);
      if (plan instanceof Error) return { type: "failed", stage, reason: message(plan) };
      if (!plan.commits.length) return { type: "failed", stage, reason: `${plan.candidate.slice(0, 12)} is already on ${plan.releaseBranch}` };
      const head = plan.candidate;
      const between = new Set((await jj(checkout, ["log", "--no-graph", "-r", `::${head} ~ ::${base}`, "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean));
      const batch: BatchLanding[] = log.landings(operation.repo).filter((entry) => between.has(entry.commitId)).map((entry) => ({ commitId: entry.commitId, operationId: entry.operationId }));
      // A landing in the batch whose own complete check passed proves every suite there (SJ-202): only the landings after
      // the newest such one can have started a failure, so diagnosis starts after it.
      const greenChecked = new Set(log.verifications(operation.repo).filter((entry) => entry.result?.type === "verified" && batchOutcomeOf(entry.id)?.outcome === "green").map((entry) => entry.commitId));
      const after = batch.findLast((entry) => entry.commitId !== head && greenChecked.has(entry.commitId));
      const landings = after ? batch.slice(batch.indexOf(after) + 1) : batch;
      // A machine's release-check place when `machine` names one (SJ-202), otherwise the boat pool `machine`, or the host.
      const held = await takeCheckPlace(machine, remoteVerification ? `check runs on a ${machine} boat VM` : "check runs on the runner host");
      const checkPlace = held?.place;
      const placed = held ? `machine:${held.machine}` : remoteVerification ? machine : "host";
      try {
        append(operation.id, { type: "batch_started", base, head, machine: placed, scheduled: operation.submittedBy.endsWith(":batch"),
          ...operation.submittedBy.endsWith(":background") ? { background: true } : {}, ...after ? { after: after.commitId } : {}, landings });
        progress(`[batch] checking ${batch.length} landing(s) from ${base.slice(0, 12)} to ${head.slice(0, 12)} on ${placed}`
          + (after ? `; ${after.commitId.slice(0, 12)} already passed, so diagnosis considers the ${landings.length} after it` : ""));
        // A release waits on this check, so what it will deploy starts building now. A background check starts nothing.
        if (!operation.submittedBy.endsWith(":background")) await startPrebuild(head, progress);
        let open: { commit: string; gate?: GateAttempt } | undefined;
        let budgetTaken = false;
        const releaseMachine = async () => {
          const held = open?.gate;
          open = undefined;
          if (held) await closeRemote(held);
        };
        const runAt = async (commit: string, scope: BatchScope | null): Promise<BatchRun> => {
          let setupMs: number | undefined;
          try {
            if (open?.commit !== commit) {
              await releaseMachine();
              const started = Date.now();
              await jj(checkout, ["new", commit]);
              open = { commit };
              if (checkPlace) {
                open.gate = { attempt: await checkPlace.open({ repo: operation.repo, slot: 0, screening: false, checkout, base, candidate: commit, integrationBranch: integrationBranch ?? plan.integrationBranch, environment: await buildCheckEnvironment(), signal: controller.signal }), started, placement: placed as GatePlacement };
                append(operation.id, { type: "remote_verification", phase: "ready", machine: open.gate.attempt.machine, placement: placed as GatePlacement, slot: 0, candidate: commit, tree: open.gate.attempt.tree, setupMs: Date.now() - started, usage: null });
              } else if (remoteVerification) open.gate = { attempt: await remoteVerification.open({ repo: operation.repo, slot: 0, pool: machine, checkout, base, candidate: commit, integrationBranch: integrationBranch ?? plan.integrationBranch, signal: controller.signal })
                .catch((error: RemoteOpenFailure) => {
                  if (error?.remote) append(operation.id, { type: "remote_verification", phase: "failed", ...error.remote, reason: error.message.slice(0, 2000) });
                  throw error;
                }), started, placement: "boat" };
              if (open.gate && !checkPlace) append(operation.id, { type: "remote_verification", phase: "ready", machine: open.gate.attempt.machine, placement: "boat", slot: 0, pool: machine, candidate: commit, tree: open.gate.attempt.tree, setupMs: Date.now() - started, usage: open.gate.attempt.usage });
              setStage("installing");
              const via = open.gate?.attempt.executor;
              await prepareWorkspaceDependencies(checkout, { quiet: true, runCommand: (request) => run(request, "dependencies", via), env: releaseEnvironment(base, commit)() });
              setupMs = Date.now() - started;
            }
          } catch (error) {
            if (controller.signal.aborted) throw authorityError();
            // The previous commit's checks changed its source: none of this batch's results is evidence.
            if (error instanceof GateDrift) throw error;
            await releaseMachine().catch(() => undefined);
            return { status: "infrastructure", reason: `setup at ${commit.slice(0, 12)} failed: ${message(error).slice(0, 1000)}` };
          }
          setStage("verifying");
          const via = open!.gate?.attempt.executor;
          const indexes = scope ? scope.checks : plan.checks.map((_, index) => index);
          const runIds: string[] = [];
          let failure: RequiredVerificationError | undefined;
          // Once per check: a later run bisecting its failure waits for nothing but this check's own load to fade. A release
          // waiting on this check goes first, as a landing's gate does; only a background look at the newest landing leaves room.
          if (!budgetTaken) { budgetTaken = true; await waitForHostBudget(open!.gate?.placement, operation.submittedBy.endsWith(":background") ? "background" : "gate", controller.signal); }
          try {
            await runRequiredVerification({ root: checkout, checks: indexes.map((index) => plan.checks[index]), environment: releaseEnvironment(base, commit, scope?.suites),
              onProgress: progress, abortSignal: controller.signal,
              run: async (request) => { const result = await run(request, "gate", via); if (result.runId) runIds.push(result.runId); return result; } })
              .then((evidence) => { if (evidence.gaps.length) throw new Error(`release checks did not run in full: ${evidence.gaps.map((gap) => gap.command).join("; ")}`); });
          } catch (error) {
            if (controller.signal.aborted) throw authorityError();
            if (!(error instanceof RequiredVerificationError) || error.evidence.outcome === "spawn_failure")
              return { status: "infrastructure", reason: `release checks at ${commit.slice(0, 12)} could not run: ${message(error).slice(0, 1000)}`, ...setupMs === undefined ? {} : { setupMs } };
            failure = error;
          }
          // On the host, the checkout must still hold the commit's tree (a boat machine is compared when it is released).
          if (!open!.gate) {
            const drift = await jj(checkout, ["diff", "--from", commit, "--to", "@", "--summary"]);
            if (drift) {
              await jj(checkout, ["restore", "--from", commit, "--into", "@"]);
              throw new GateDrift(`The release checks changed the source of ${commit.slice(0, 12)}; their results are not evidence for it:\n${drift}`);
            }
          }
          const ran = new Set(runIds);
          const events = log.events({ operationId: operation.id }).map((row) => row.event);
          const suites: Record<string, SuiteState> = {};
          for (const event of events) if (event.type === "test_report" && ran.has(event.runId) && event.status === "recorded")
            for (const entry of event.outcomes ?? []) if (suites[entry.suite] !== "failed") suites[entry.suite] = entry.outcome;
          if (!failure) return { status: "passed", suites, ...setupMs === undefined ? {} : { setupMs } };
          const failingTests = events.flatMap((event) => event.type === "run_finished" && ran.has(event.runId) ? event.failingTests ?? [] : []);
          return { status: "failed", failedChecks: failure.evidence.failures.map((entry) => indexes[entry.checkIndex]!), command: failure.evidence.command,
            suites, failingTests: boundedTests(failingTests), output: boundedOutput(failure.message), ...setupMs === undefined ? {} : { setupMs } };
        };
        let outcome: Awaited<ReturnType<typeof runBatchCheck>>;
        const notEvidence = (error: unknown): OperationEvent => {
          append(operation.id, { type: "batch_outcome", outcome: "infrastructure", base, head, machine: placed, reason: message(error).slice(0, 2000) });
          return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} is not evidence for it: ${message(error)}` };
        };
        try {
          outcome = await runBatchCheck({ head, landings, run: (commit, scope) => runAt(commit, scope),
            onRun: ({ phase, commit, run: result, durationMs }) => append(operation.id, { type: "batch_run", phase, commit, status: result.status, durationMs,
              ...result.setupMs === undefined ? {} : { setupMs: result.setupMs },
              ...result.status === "failed" ? { keys: boundedKeys(Object.entries(result.suites).filter(([, state]) => state === "failed").map(([suite]) => suite)), failingTests: result.failingTests } : {},
              ...result.status === "infrastructure" ? { reason: result.reason } : {} }) });
        } catch (error) {
          await releaseMachine().catch((closing: unknown) => progress(`[batch] the batch machine could not be released: ${message(closing)}`));
          if (error instanceof GateDrift) return notEvidence(error);
          throw error;
        }
        // Releasing the last machine compares its tree: a check that changed the source, or a machine whose tree cannot be read, proves nothing.
        try { await releaseMachine(); } catch (error) { return notEvidence(error); }
        const recorded = { base, head, machine: placed };
        if (outcome.outcome === "green") {
          append(operation.id, { type: "batch_outcome", outcome: "green", ...recorded });
          return { type: "verified", base: plan.base, candidate: head, checks: plan.checks, nonAdditiveMigrations: plan.nonAdditiveMigrations };
        }
        if (outcome.outcome === "infrastructure") {
          append(operation.id, { type: "batch_outcome", outcome: "infrastructure", ...recorded, reason: outcome.reason });
          return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} did not run (infrastructure, not a regression): ${outcome.reason}` };
        }
        if (outcome.outcome === "flaky") {
          append(operation.id, { type: "batch_outcome", outcome: "flaky", ...recorded, keys: boundedKeys(outcome.keys) });
          return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} was flaky: ${outcome.keys.join(", ")} failed and passed on its rerun; nothing is routed, and the head needs a complete green check before it deploys` };
        }
        const culprits = outcome.culprits.map((culprit) => ({ ...culprit, keys: boundedKeys(culprit.keys), workspace: log.operation(culprit.operationId)?.submittedBy ?? null }));
        append(operation.id, { type: "batch_outcome", outcome: "red", ...recorded, keys: boundedKeys(outcome.keys), diagnosis: outcome.diagnosis,
          shorterCandidate: outcome.shorterCandidate, culprits, ...outcome.unattributed.length ? { unattributed: outcome.unattributed.map((entry) => ({ ...entry, keys: boundedKeys(entry.keys) })) } : {},
          ...outcome.reason ? { reason: outcome.reason } : {} });
        // The part of the batch before the first culprit ships only after its own complete check passes.
        if (outcome.shorterCandidate) queueVerification(operation.repo, outcome.shorterCandidate, "batch");
        trackRoute(operation.id);
        const named = culprits.map((culprit) => `${culprit.commitId.slice(0, 12)} (${culprit.operationId}: ${culprit.keys.join(", ")})`).join("; ");
        const unnamed = outcome.unattributed.map((entry) => `${entry.keys.join(", ")} started failing between ${entry.after?.slice(0, 12) ?? base.slice(0, 12)} and ${entry.firstFailing.slice(0, 12)}, where diagnosis could not run`).join("; ");
        return { type: "failed", stage: "verifying", reason: `Batch check of ${head.slice(0, 12)} failed: ${outcome.keys.join(", ")}; ${culprits.length ? `culprits ${named}` : "no culprit found"}`
          + (unnamed ? `; unattributed: ${unnamed}` : "")
          + (outcome.shorterCandidate ? `; ${outcome.shorterCandidate.slice(0, 12)}, before the first culprit, is checked next` : "") };
      } finally {
        if (checkPlace) { machineCheckHolds.release(machine, 0); wakeMain(); }
      }
    }
    /**
     * The release-check place serving boat pool `name` (SJ-202), held for this check until it ends; null when no place
     * serves it, or when it is down, which is said and recorded: the check then uses the pool or the host, never quietly.
     */
    /** Starts `commitId`'s prebuild, when its policy declares one and a fixed machine serves its pool, and does not wait for it. */
    async function startPrebuild(commitId: string, note: (line: string) => void): Promise<void> {
      const gitDirectory = join(checkoutPath(operation), ".git");
      const policy = await readExactExecutionPolicy(gitDirectory, commitId).then((exact) => exact.configuration?.deployments?.environments.production, () => undefined);
      const served = policy?.machine ? machineBuilds[policy.machine] : undefined;
      if (!policy?.prebuild || !policy.machine || !served) return;
      const label = `[prebuild] ${operation.repo} ${commitId.slice(0, 12)}`;
      note(`[prebuild] building ${commitId.slice(0, 12)} on ${served.machine} beside this check`);
      const pool = policy.machine;
      const building: Promise<void> = prebuildRelease({ gitDirectory, commitId, policy: { ...policy, prebuild: policy.prebuild },
        readEnvironment: environment ?? (() => process.env), abortSignal: stopPrebuilds.signal, run: (request) => executor.run(request),
        lease: () => served.lease({ repo: operation.repo, pool, gitDirectory, commitId, lifetimeS: 2 * Math.ceil(policy.timeoutMs / 1000), signal: stopPrebuilds.signal }) })
        .then((failed) => { console.error(failed ? `${label} failed, so its deploy builds it: ${failed}` : `${label} finished`); },
          (error: unknown) => { console.error(`${label} could not run, so its deploy builds it: ${message(error)}`); })
        .finally(() => { prebuilds.delete(building); });
      prebuilds.add(building);
    }
    async function takeCheckPlace(name: string, fallback: string): Promise<{ machine: string; place: MachineVerification } | null> {
      const served = machineChecks[name];
      if (!served) return null;
      const { place } = served;
      // A quarantined place (as every place is after a restart) is recovered once before it counts as down.
      for (let recovered = false; ; recovered = true) {
        for (;;) {
          if (!machineCheckHolds.queued(name) && machineCheckHolds.take(name, 1, () => place.available()) !== null) return served;
          if (!machineCheckHolds.anyHeld(name)) break;
          progress(`[batch] ${served.machine}'s release-check place is busy; queued for it`);
          const waited = await machineCheckHolds.wait(name, controller.signal);
          if (controller.signal.aborted && waited.place !== null) machineCheckHolds.release(name, waited.place);
          controller.signal.throwIfAborted();
          if (waited.place === null) continue;
          if (place.available()) return served;
          machineCheckHolds.free(name, waited.place);
        }
        if (recovered || !place.recover) break;
        await place.recover([]).catch(() => undefined);
        if (place.available()) machinePlaceUp(served.machine);
      }
      const reason = place.reason() || "release-check place unavailable";
      progress(`warning: ${served.machine}'s release-check place is down (${reason}); this ${fallback} instead`);
      machinePlaceDown(served.machine, reason);
      return null;
    }
  }
  /** The base a release check is measured from: the commit Production serves, or the release branch while nothing is served. */
  async function servedBase(repo: string, directory: string): Promise<string | null> {
    const served = servedCommit(log.deployments(repo, "production"));
    if (served) return served;
    const context = await workspaceContext(directory).catch(() => null);
    const branch = context?.configuration.releaseBranch;
    if (!branch) return null;
    return (await revisionFacts(directory, `${branch}@${context.configuration.remote ?? "origin"}`).catch(() => null))?.commitId ?? null;
  }
  /** The environment of a release check of `head`: its base and head, and the suites a rerun narrows to (`batch-verification.ts`). */
  const releaseEnvironment = (base: string | null, head: string, suites?: readonly string[]) => (): NodeJS.ProcessEnv => ({
    ...(environment?.() ?? process.env), ...base ? { [RELEASE_BASE_ENV]: base } : {}, [RELEASE_HEAD_ENV]: head,
    ...suites?.length ? { [RELEASE_SUITES_ENV]: suites.join(",") } : {} });
  /** Culprits whose record is on its way to Forge, so two passes never send one twice at once. */
  const routing = new Set<string>();
  const batchRouteRetryMs = input.batchRouteRetryMs ?? 300_000;
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
    const routedBefore = (commitId: string): { keys: Set<string>; by: string[] } => {
      const keys = new Set<string>();
      const by: string[] = [];
      for (const other of log.verifications(operation.repo)) {
        if (other.id === operationId) continue;
        const rows = log.events({ operationId: other.id }).map((row) => row.event);
        if (!rows.some((event) => event.type === "batch_routed" && event.commitId === commitId)) continue;
        const earlier = rows.findLast((event) => event.type === "batch_outcome");
        const named = earlier?.type === "batch_outcome" ? earlier.culprits?.find((entry) => entry.commitId === commitId) : undefined;
        if (!named) continue;
        for (const key of named.keys) keys.add(key);
        by.push(other.id);
      }
      return { keys, by };
    };
    let retry = false;
    for (const culprit of outcome.culprits ?? []) {
      const key = `${operationId}\0${culprit.commitId}`;
      if (answered.has(culprit.commitId) || routing.has(key)) continue;
      routing.add(key);
      try {
        const reference = { commitId: culprit.commitId, operationId: culprit.operationId };
        const earlier = routedBefore(culprit.commitId);
        const fresh = culprit.keys.filter((key) => !earlier.keys.has(key));
        if (!fresh.length) { append(operationId, { type: "batch_unrouted", ...reference, reason: `already routed by batch check ${earlier.by.join(", ")} for ${culprit.keys.join(", ")}` }); continue; }
        if (!input.recordBatchCheck) { append(operationId, { type: "batch_unrouted", ...reference, reason: "this runner has no Forge route" }); continue; }
        const answer = await input.recordBatchCheck({ repository: operation.repo, batchId: operationId, occurredAt: ended.at, startedAt: started.at, endedAt: ended.at,
          base: outcome.base, head: outcome.head, culprit: reference, failingTests: culprit.failingTests, failedSuites: fresh, command: culprit.command, output: culprit.output });
        if (answer.kind === "accepted") {
          const value = (answer.value ?? {}) as { runId?: unknown; specId?: unknown; number?: unknown; noteId?: unknown };
          append(operationId, { type: "batch_routed", ...reference, specId: String(value.specId ?? ""), number: typeof value.number === "number" ? value.number : null,
            runId: String(value.runId ?? ""), noteId: typeof value.noteId === "string" ? value.noteId : null });
        } else if (answer.kind === "refused") append(operationId, { type: "batch_unrouted", ...reference, reason: `${answer.code}${answer.message ? `: ${answer.message}` : ""}` });
        else retry = true;
      } catch (error) {
        retry = true;
        console.error(`[runner] ${operation.repo}: batch culprit ${culprit.commitId.slice(0, 12)} could not be routed: ${message(error)}`);
      } finally { routing.delete(key); }
    }
    if (retry && !closed) setTimeout(() => { if (!closed) trackRoute(operationId); }, batchRouteRetryMs).unref?.();
  }
  /** Routing in flight, which `idle` waits for. */
  const routes = new Set<Promise<void>>();
  function trackRoute(operationId: string): void {
    const pending = routeBatch(operationId).catch((error: unknown) => console.error(`[runner] batch ${operationId} could not be routed: ${message(error)}`))
      .finally(() => routes.delete(pending));
    routes.add(pending);
  }
  async function freezeProvenance(id: string, checkout: string, failure: Extract<OperationEvent, { type: "failed" }>,
    checked?: { candidate: string; base: string }, policy?: Pick<import("../policy/execution-policy.ts").ExecutionPolicy, "migrationFinalization" | "provenance">): Promise<void> {
    const events = log.events({ operationId: id });
    if (events.some(row => row.event.type === "provenance")) return;
    const source = provenanceSource(events, failure);
    // Recovery has no live attempt context; read its committed integration policy once at failure.
    policy ??= (await workspaceContext(checkout).catch(() => null))?.configuration;
    append(id, { type: "provenance", value: await failureProvenance({ checkout, ...source, checked: checked ?? source.checked, policy }) });
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
      if (operation.kind === "audit") {
        // Recorded as interrupted, which is no verdict: the schedule submits the audit again at startup.
        append(operation.id, { type: "cancelled", reason: AUDIT_INTERRUPTED_REASON });
        continue;
      }
      if (operation.kind === "verification" || operation.kind === "recovery") {
        // A verification publishes nothing, and a recovery finishes whatever is held however far it got:
        // either queues again, behind whatever arrived meanwhile.
        append(operation.id, { type: "yielded", to: "a runner restart" });
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
        if (integrated && !log.held().some((entry) => entry.repo === operation.repo && entry.commitId === integrated!.commitId))
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
              verdict = { type: "landed", base: integrated.base, commitId: integrated.commitId, branch, remote, ...await declaredEnvironments(operation.repo, integrated.commitId) };
            }
          }
        }
      } catch (error) {
        append(operation.id, { type: "progress", line: `Recovery could not confirm publication: ${message(error)}` });
      }
      if (remote) await cleanup(operation, checkout, remote);
      if (verdict.type === "failed") await freezeProvenance(operation.id, checkout, verdict);
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
        let known = log.held().find((entry) => entry.repo === repo);
        // Local evidence survives even when a remote outage prevents confirmation.
        const ahead = await jj(checkout, ["log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
        if (ahead) {
          const commitId = (await revisionFacts(checkout, branch)).commitId;
          if (known?.commitId !== commitId)
            append(RUNNER_CONTROL_ID, { type: "integration_held", repo, commitId, reason: "Publication of the retained integration is unconfirmed after restart" });
        }
        const fetched = await fetchIntegration(checkout, remote, branch);
        if (fetched.code !== 0) continue;
        known = log.held().find((entry) => entry.repo === repo);
        if (known && await revisionExists(checkout, `${known.commitId} & ::${branch}@${remote}`))
          append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo, commitId: known.commitId });
      } catch { /* An unavailable checkout cannot prove recovery; retain recorded holds. */ }
    }
  }
  const recoveryRetries = new Map<string, { failures: number; timer?: ReturnType<typeof setTimeout> }>();
  /**
   * A recovery that fails (the remote was unreachable, say) leaves the hold in place with nothing else to retry it, so queue
   * another after a delay that doubles with each failure. Any other ending, or nothing left held, stops the retries.
   */
  function retryFailedRecovery(repo: string, failed: boolean): void {
    const state = recoveryRetries.get(repo) ?? { failures: 0 };
    clearTimeout(state.timer);
    if (!failed || draining) { recoveryRetries.delete(repo); return; }
    const delay = Math.min(Math.max(RECOVERY_RETRY_MAX_MS, recoveryRetryMs), recoveryRetryMs * 2 ** state.failures);
    state.failures += 1;
    state.timer = setTimeout(() => { recoverHeld(repo); }, delay);
    state.timer.unref?.();
    recoveryRetries.set(repo, state);
  }
  function recoverHeld(repo: string): Operation | null {
    if (!log.held().some((entry) => entry.repo === repo)) return null;
    const open = log.openOperations(repo).find((entry) => entry.kind === "recovery");
    if (open) return open;
    const id = newOperationId();
    append(id, { type: "submitted", kind: "recovery", repo, commitId: log.held().find((entry) => entry.repo === repo)!.commitId, submittedBy: `${executor.host}:recovery` });
    wakeMain();
    return log.operation(id);
  }
  async function releaseHeld(repo: string, by: string): Promise<{ ok: boolean; reason: string }> {
    if (recovering || heldStart || draining) return { ok: false, reason: "Runner recovery or shutdown is in progress; retry when it has finished" };
    return serially(repo, async () => {
      const hold = log.held().find((entry) => entry.repo === repo);
      if (!hold) return { ok: false, reason: `No held integration for ${repo}` };
      if (hold.targetReached !== false) return { ok: false, reason: `Finalization may have reached the target (including unknown earlier attempts): ${hold.reason}. Reconcile the target and recover the held integration` };
      if (prefixes.get(repo)?.length) return { ok: false, reason: "A landing is still running in this repository; retry after it finishes" };
      const checkout = repoCheckout(repo);
      // These identities were observed before finalization parsed the held policy.
      // Reading that invalid policy again would make precisely this recovery impossible.
      if (!hold.branch || !hold.remote) return { ok: false, reason: "Held integration has no recorded branch and remote; recovery must reconcile it" };
      const branch = hold.branch;
      const remote = hold.remote;
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch]);
      if (await revisionExists(checkout, `${hold.commitId} & ::${branch}@${remote}`))
        return { ok: false, reason: "Held integration is already on the remote; its recovery turn must confirm publication" };
      if ((await revisionFacts(checkout, branch)).commitId !== hold.commitId)
        return { ok: false, reason: "Runner integration bookmark differs from the hold; recovery must reconcile it" };
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      const reason = `Released unpublished by ${by}: finalization never started the target command`;
      append(RUNNER_CONTROL_ID, { type: "integration_released", repo, commitId: hold.commitId, reason, by });
      retryFailedRecovery(repo, false);
      return { ok: true, reason };
    });
  }
  /** Whether `operation` is past the stages an owner's kill may stop, or is finishing a held integration. Its verdict ends it. */
  const inTail = (operation: Operation) => operation.status === "running"
    && (operation.kind === "recovery" || operation.stage === "integrating" || operation.stage === "finalizing" || operation.stage === "publishing" || operation.stage === "deploying");
  /** Stop whatever would start work on its own: the interval schedulers that submit deploys, resets, audits and recoveries. */
  function stopScheduling(): void {
    clearInterval(machineRecovery);
    scheduler.close(); resetScheduler.close(); auditScheduler.close();
    for (const hold of boatHolds.values()) { clearTimeout(hold.timer); hold.controller?.abort(); }
    for (const retry of auditDiscovery.values()) clearTimeout(retry);
    auditDiscovery.clear();
    for (const timer of scheduledPromotions.values()) clearTimeout(timer);
    for (const timer of backgroundChecks.values()) clearTimeout(timer);
    scheduledPromotions.clear();
    for (const { timer } of recoveryRetries.values()) clearTimeout(timer);
    recoveryRetries.clear();
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
  function cancelled(operation: Operation): void {
    // A cancelled audit is no verdict: its slot is due again, or the next one gets its timer.
    if (operation.kind === "audit") auditScheduler.reconsider(operation.repo);
    if (operation.kind !== "landing") return;
    // A submission that woke the queue while this cleanup held the lane is admitted after it.
    void inLane(laneOf(operation.repo), async () => {
      // A yielded depth-two landing may have only a verifier checkout: its canonical publisher is created later.
      const attempt = log.events({ operationId: operation.id }).map(({ event }) => event).findLast((event) => event.type === "attempt_started");
      const checkout = attempt?.type === "attempt_started" ? attempt.checkout : checkoutPath(operation);
      const context = await workspaceContext(checkout).catch(() => null);
      if (context) await cleanup(operation, checkout, context.configuration.remote ?? "origin");
    }).finally(wakeMain);
  }
  return {
    requestBatchCheck,
    wake() {
      wakeMain();
      wakeDeploys();
    },
    hold(reason) {
      heldStart = reason;
      stopScheduling();
    },
    async recover() {
      // Every lane is idle at startup; recovery waits for any that is not, and holds them all.
      // Commands an earlier process left running stop before recovery touches their checkouts.
      recovering = Promise.allSettled([...lanes.values(), ...attempts]).then(async () => {
        await executor.recover?.();
        await Promise.all([...Object.values(machinePlaces).flat(), ...Object.values(machineChecks).map((entry) => entry.place)].map((place) => place.recover?.([])));
        // Every attempt cleans its machine first, so a recovery that fails here is reported, never a reason to stop.
        await remoteVerification?.recover?.(Object.entries(config.repos).flatMap(([repo, entry]) => entry.verifier ? [repo] : []))
          .catch((error: unknown) => console.error(`[runner] ${message(error)}`));
        await recoverRunning(); await reconcileHeld();
      })
        .finally(() => { recovering = undefined; });
      await recovering;
      for (const repo of Object.keys(config.repos).map(repositoryKey)) {
        // A hold nothing else will publish: the landing that held it ended, and Build refuses a reland while it is held.
        recoverHeld(repo);
        await reconcileVerification(repo);
        // A red batch whose culprits Forge never answered is sent again.
        for (const verification of log.verifications(repo)) if (verification.status === "failed") trackRoute(verification.id);
        await promoteAutomatically(repo);
        await scheduleLatest(repo);
      }
      // A repository that landed here is scheduled above, from the policy of its last landing; only one that never
      // did needs its policy read from the remote, which takes its lane for a fetch.
      discoverAudits(Object.keys(config.repos).map(repositoryKey).filter((repo) => !log.lastLanded(repo)));
    },
    cancelled,
    recoverHeld,
    releaseHeld,
    async drain() {
      draining = true;
      stopPrebuilds.abort();
      await Promise.allSettled(prebuilds);
      await deploying;
      await Promise.allSettled([...activeDeploys.values()].map((active) => active.pending));
      while (log.openOperations().some(inTail)) {
        await new Promise<void>((resolve) => { const stop = log.subscribe(() => { stop(); resolve(); }); });
      }
    },
    async idle() {
      for (;;) {
        if (recovering) await recovering;
        await Promise.allSettled([...lanes.values(), ...attempts, ...discoveries, ...automaticPromotions.values(), ...backgroundConsiderations.values(), ...routes, ...prebuilds]);
        const lane = deploying;
        await lane;
        await Promise.allSettled([...activeDeploys.values()].map((active) => active.pending));
        if (!recovering && !lanes.size && !attempts.size && !discoveries.size && !activeDeploys.size && !routes.size && lane === deploying) return;
      }
    },
    close() {
      closed = true;
      stopScheduling();
    },
    kill(operationId) {
      const held = log.openOperations().filter((operation) => operation.kind === "landing" && operation.status === "queued" && boatHolds.has(operation.repo));
      const queued = operationId ? held.find((operation) => operation.id === operationId) : running.size === 0 && held.length === 1 ? held[0] : undefined;
      if (queued) {
        append(queued.id, { type: "cancelled", reason: OWNER_KILL_REASON });
        cancelled(queued);
        return { status: "killed", operation: log.operation(queued.id)! };
      }
      if (!operationId && !running.size && held.length > 1) return { status: "ambiguous", operations: held };
      const target = operationId === undefined ? undefined : running.get(operationId);
      if (operationId !== undefined && !target) {
        const operation = log.operation(operationId);
        // A ledger that could not be written while an operation ended leaves it recorded as running
        // with no work behind it; the owner's kill still ends it, so it never blocks a relanding.
        // Not a deploy: `activeDeploys` holds those, not `running`, and a deploy is not killable. Not a
        // turn that is still settling its verdict, and not restart recovery, which are both already
        // ending it.
        if (operation?.status === "running" && operation.kind !== "deploy" && !recovering && !ending.has(operationId)) {
          if (!KILLABLE_STAGES.includes(operation.stage)) return { status: "refused", operation };
          append(operationId, { type: "cancelled", reason: OWNER_KILL_REASON });
          cancelled(operation);
          return { status: "killed", operation: log.operation(operationId)! };
        }
        return { status: "not_running", operation };
      }
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


/** The legacy fields keep the first failure; `failures` lists every failed check by index, command, outcome and run. */
function failedVerification(evidence: RequiredVerificationFailureEvidence): Pick<Extract<OperationEvent, { type: "failed" }>, "command" | "output" | "failures"> {
  return { command: evidence.command, output: evidence.stdoutTail + evidence.stderrTail,
    failures: (evidence.failures ?? [evidence]).map(({ checkIndex, command, outcome, runId }) => ({ checkIndex, command, outcome, ...runId ? { runId } : {} })) };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
