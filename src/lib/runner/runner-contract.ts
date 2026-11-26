import type { DeployOperation, DeployProjectOutcome, DeployRecord, LandingSubmission, Operation, OperationEvent, RunnerConfig, RunnerLimits, RunnerStage, StoredEvent } from "./runner-types.ts";

/**
 * The runner's contract: one long-lived control plane that owns the landing queue
 * and an append-only operation log, executors that only run commands, and clients
 * (the CLI, agents, a future web UI) that reach it over HTTP. Everything a client
 * sees is a projection of the log.
 *
 * Declarations live in `runner-types.ts`; this module holds the contract's values.
 */

/** A running screen can still be replaced; authoritative admission fences that permission. */
export function isScreeningLanding(operation: Operation, history: readonly StoredEvent[]): boolean {
  const started = history.findLast(({ event }) => event.type === "screen_started");
  const admitted = history.findLast(({ event }) => event.type === "screen_admitted");
  return operation.kind === "landing" && operation.status === "running" && Boolean(started && (!admitted || started.seq > admitted.seq));
}

/** API version prefix; every route below sits under it. */
export const RUNNER_API = "/v1";

/** The most one page of `GET /v1/operations/:id/artifacts/:runId` returns. */
export const COMMAND_ARTIFACT_PAGE_BYTES = 1024 * 1024;
/** The largest serialised command artifact: a failed command's (see `command-artifact.ts`). */
export const COMMAND_ARTIFACT_LIMIT_BYTES = 12 * 1024 * 1024;

/** The candidate bookmark a client pushes for the runner to fetch: `slipjay/changes/<changeId>`. */
export const candidateBookmark = (changeId: string): string => `slipjay/changes/${changeId}`;

/**
 * Stages the owner's kill may stop. Up to the end of verification nothing has moved
 * the integration or release branch; from `integrating` on, a kill could leave the
 * external target ahead of the remote, so it is refused. Verification's commands are
 * killed at once; an earlier stage finishes its step (a fetch, an install) and the
 * operation stops before verification starts. A reset moves no branch, and the
 * target's own script is built to survive a kill, so `resetting` is killed at once
 * too. Deploys run in their own lane and are never killed: each project's command
 * ends at its declared deadline.
 */
export const KILLABLE_STAGES: readonly RunnerStage[] = ["fetching", "rebasing", "installing", "screening", "verifying", "waiting-for-budget", "waiting-for-predecessor", "resetting"];

/** The reason a killed operation carries; it is never reported as a pass. */
export const OWNER_KILL_REASON = "killed by the owner, not run to completion";

/** The reason an audit carries when a runner restart stopped it mid-run: it is recorded as interrupted, never as a verdict, and runs again. */
export const AUDIT_INTERRUPTED_REASON = "interrupted by a runner restart, not run to completion";

/** The log's operation id for runner-wide control events (pause, resume). */
export const RUNNER_CONTROL_ID = "runner";

/** Proven serving outcome, excluding unconfirmed activation or recovery as a future restore target. */
export const servedDeploy = (project: DeployProjectOutcome): boolean => project.ok && project.activated !== false && project.activated !== "unknown";

/** What a finished deploy put in its environment: every project, or the ones a failed deploy reached. */
export const recordOf = (operation: DeployOperation): DeployRecord | undefined =>
  operation.result?.type === "deployed" ? operation.result.record : operation.result?.type === "failed" ? operation.result.deployment : undefined;

/** The commit an environment serves: the newest deploy any of whose projects served it, from deploys listed newest first. */
export const servedCommit = (deploys: readonly DeployOperation[]): string | null =>
  deploys.find((operation) => recordOf(operation)?.projects.some(servedDeploy))?.commitId ?? null;

export const isLandingSubmission = (event: OperationEvent | undefined): event is LandingSubmission =>
  event?.type === "submitted" && (event.kind === undefined || event.kind === "landing");

/** Event types that close an operation. */
export const TERMINAL_EVENT_TYPES = ["landed", "released", "verified", "deployed", "reset", "audited", "failed", "declined", "superseded", "cancelled"] as const;

/**
 * The event types whose `seq` keys a receipt for the operation that owns the event: `build-receipts.ts` builds one receipt
 * per such event it owes, and settles it with a `build_receipt` naming that sequence. A type added to those keys belongs here.
 */
export const RECEIPT_KEY_EVENT_TYPES = ["landed", "failed", "cancelled", "superseded", "declined", "integration_held", "run_started", "verification_skipped"] as const;

/**
 * The settlement events a later reconciliation receipt is keyed by: a failed attempt's integration, once some other record
 * confirms it published or released it. The receipt belongs to the failed attempt, not to the operation that settled it, so
 * `build-receipts.ts` keys it by the settlement's sequence and records it against the attempt.
 */
export const RECEIPT_SETTLEMENT_EVENT_TYPES = ["integration_recovered", "integration_released"] as const;

/** Names one repository's integrated commit: the same commit may exist in several configured repositories. */
export const recoveryKey = (repo: string, commitId: string) => `${repo}\n${commitId}`;

/** How many landings, releases and resets of different repositories run at once, unless the config sets `workers`. */
export const RUNNER_DEFAULT_WORKERS = 2;

/** Deploys have a separate runner-wide budget and always serialize within a repository. */
export const RUNNER_DEFAULT_DEPLOY_WORKERS = 1;

/**
 * The worker admission rule (deploys use their own budget): at most `workers` operations other than short landings run at once, and with the short place
 * (enforced combined limits) at most `workers + 1` in all, so a short landing may start while long operations hold
 * every worker. Whether an operation, short or not, may start beside `running`, each marked short or not.
 */
export const admits = (short: boolean, running: readonly { short: boolean }[], workers: number, shortPlace: boolean): boolean =>
  running.length < workers + (shortPlace ? 1 : 0) && (short || running.filter((entry) => !entry.short).length < workers);

/** The verify-stage p90 at or below which a repository's landings are short, unless the config sets `shortLandingP90Seconds`. */
export const RUNNER_DEFAULT_SHORT_LANDING_SECONDS = 180;

/** The systemd slice every run's scope joins, so one set of limits covers every gate, deploy and their children. */
export const RUNNER_SLICE = "slipjay.slice";

/** The slice's share of a full CPU against its siblings, which default to 100: it only matters when the host has no spare. */
export const RUNNER_CPU_WEIGHT = 400;

/**
 * The systemd user slice a runner command and its processes belong to, set in its environment. A
 * command that starts a systemd user scope of its own passes it as `--slice` (or a child slice of
 * it), so that work stays within the run's limits and is stopped with it.
 */
export const SYSTEMD_SLICE_ENV = "SLIPJAY_SYSTEMD_SLICE";

/** The slice's limits unless the config sets `limits`: systemd resource-control values. */
export const RUNNER_DEFAULT_LIMITS: Readonly<Required<RunnerLimits>> = { memoryHigh: "40G", memoryMax: "48G", cpuQuota: "1400%", tasksMax: 4096 };

/**
 * jj settings the runner sets unless its config overrides them: YardSmith checks in files over jj's 1MiB default, and
 * the runner's checkout is shared, so another operation on its repository can move past its working copy. JJ then
 * refuses the next command that snapshots it unless it is told to update: a stale working copy must never fail a read,
 * and no one is there to run `jj workspace update-stale` for the runner.
 */
export const RUNNER_JJ_DEFAULTS: Readonly<Record<string, string>> = { "snapshot.max-new-file-size": "64MiB", "snapshot.auto-update-stale": "true" };

/** The serial lane a repository's landings, resets and release publications take turns in. */
export const repositoryLane = (config: Pick<RunnerConfig, "repos">, repo: string): string =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1].lane?.trim() ?? repositoryKey(repo);

/**
 * The lane an operation of `kind` in `repo` is admitted to, given the repository's `lane`. A
 * release of a repository with a lane of its own verifies in a release lane beside it and
 * joins the repository lane only to publish. A shared lane declares external state its
 * repositories' gates share, so a release there verifies in the shared lane itself.
 */
export const admissionLane = (lane: string, repo: string, kind: Operation["kind"]): string =>
  (kind === "release" || kind === "verification") && lane === repositoryKey(repo) ? `${lane}\0release` : lane;

/**
 * Whether a queued landing must wait because a newer candidate of its change awaits Build admission: Build may admit
 * that one in its place, so it neither starts nor is superseded until Build answers.
 */
export const awaitingReplacement = (operation: Operation, open: readonly Operation[]): boolean =>
  operation.kind === "landing" && operation.status === "queued" && operation.admission !== "pending" && open.some((other) =>
    other.kind === "landing" && other.id !== operation.id && other.status === "queued" && other.admission === "pending"
    && repositoryKey(other.repo) === repositoryKey(operation.repo) && other.changeId === operation.changeId);

/** A repository's `owner/name` as the runner keys it: GitHub names are case-insensitive. */
export const repositoryKey = (name: string): string => name.toLowerCase();
