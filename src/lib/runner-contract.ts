import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { ReleaseResult } from "./release.ts";

/**
 * The runner's contract: one long-lived control plane that owns the landing queue
 * and an append-only operation log, executors that only run commands, and clients
 * (the CLI, agents, a future web UI) that reach it over HTTP. Everything a client
 * sees is a projection of the log.
 */

/** API version prefix; every route below sits under it. */
export const RUNNER_API = "/v1";
/** Environment variable holding the runner location (`http://host:port` or `ssh://host`). */
export const RUNNER_LOCATION_ENV = "SLIPJAY_RUNNER";
/** Environment variable, and Bitwarden secret key, holding the bearer token. */
export const RUNNER_TOKEN_ENV = "SLIPJAY_RUNNER_TOKEN";
/** Port the runner binds on 127.0.0.1, and the port an `ssh://` location forwards to. */
export const RUNNER_DEFAULT_PORT = 7787;
/** The candidate bookmark a client pushes for the runner to fetch: `slipjay/changes/<changeId>`. */
export const candidateBookmark = (changeId: string): string => `slipjay/changes/${changeId}`;

/**
 * Stages of one operation, in order; `queued` until the queue reaches it. `paused` is
 * never recorded: a queued operation shows it while the owner has paused the runner.
 */
export type RunnerStage = "queued" | "paused" | "fetching" | "rebasing" | "installing" | "verifying" | "waiting-for-predecessor" | "integrating" | "finalizing" | "publishing" | "deploying" | "resetting";

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
export const KILLABLE_STAGES: readonly RunnerStage[] = ["fetching", "rebasing", "installing", "verifying", "waiting-for-predecessor", "resetting"];
/** The reason a killed operation carries; it is never reported as a pass. */
export const OWNER_KILL_REASON = "killed by the owner, not run to completion";
/** The log's operation id for runner-wide control events (pause, resume). */
export const RUNNER_CONTROL_ID = "runner";

/** Terminal and live states of an operation, derived from its events. */
export type OperationStatus = "queued" | "running" | "landed" | "released" | "deployed" | "reset" | "failed" | "declined" | "superseded" | "cancelled";

/** A release the runner verified and published, or found already published. */
export type CompletedRelease = Extract<ReleaseResult, { status: "released" | "released_by" }>;

/**
 * One project's outcome in a deploy: `url` is the deployment its command reported, and
 * `ok` that it deployed and passed its health check. In an environment that activates,
 * `activated` says whether the project's traffic moved to it; `unknown` means an
 * activation or recovery command failed and the runner cannot establish what serves.
 * A project proved moved back after activation failed is `restored`.
 */
export type DeployProjectOutcome = { name: string; ok: boolean; url?: string; reason?: string; activated?: boolean | "unknown"; restored?: boolean };

/** Proven serving outcome, excluding unconfirmed activation or recovery as a future restore target. */
export const servedDeploy = (project: DeployProjectOutcome): boolean => project.ok && project.activated !== false && project.activated !== "unknown";

/**
 * What one deploy put in an environment: the commit, the commit the environment
 * served before (null for its first deploy), the commits between them, newest first,
 * and each project's outcome. A production problem narrows to one record.
 */
export type DeployRecord = {
  environment: string; commitId: string; previous: string | null;
  changes: { commitId: string; subject: string }[];
  projects: DeployProjectOutcome[];
  /**
   * A promotion that does not serve: `automatic` when production stays on what it served
   * before and the release branch returns to the commit before the release merge
   * (`releaseBranch`). False means restoration was prohibited or remained incomplete:
   * the reason names the unresolved outcome and the owner decides recovery.
   */
  rollback?: { automatic: boolean; releaseBranch?: string; reason: string };
  /** Present once an environment that declares migrations reached them: see `DeployMigrations`. */
  migrations?: DeployMigrations;
};

/**
 * What a deploy did to its database. `artifacts` are the promotion's migration files.
 * `current`: the database already matched the commit, so nothing was applied (a rerun);
 * `applied`: they were pending, applied, and verified; `verify_failed`: the first
 * verify refused, so nothing was applied; `apply_failed`: apply or the verify after it
 * failed, so the database may be partly migrated. Either failure activates nothing.
 */
export type DeployMigrations = { artifacts: string[]; status: "current" | "applied" | "verify_failed" | "apply_failed"; reason?: string };

/**
 * What a promotion's production deploy needs: the release merge to undo it, the
 * migrations that make undoing it manual, and the migration files it carries
 * (absent from deploys recorded before the runner applied them).
 */
export type PromotionFacts = { merge: string; nonAdditiveMigrations: string[]; migrationArtifacts?: string[] };

/** One fact appended to the log. Nothing is updated or deleted. */
export type CauseClass = "gate" | "conflict" | "infrastructure" | "policy" | "killed" | "paused_out" | "held" | "superseded" | "cancelled";
export type ClientFact =
  | { kind: "workspace_start"; workspace: string; machine: string; startedAt: string }
  | { kind: "pool_claim"; workspace: string; hit: boolean; spareCount: number; durationMs: number }
  | { kind: "land_follow"; reattached: boolean }
  | { kind: "ssh_forward_failure"; reason: string; observedAt: string }
  | { kind: "preview_start"; workspace: string; port: number };
export type ClassifiedFact = { type: "classified"; ruleVersion: number; cause: CauseClass; command?: string; failingTests: string[]; diagnostics: string[]; interaction?: { earlierOperation: string; fromBase: string; toBase: string } };
export type RunPurpose = "gate" | "dependencies" | "finalization" | "migration_generate" | "migration_verify" | "deploy" | "reset";
export type OperationEvent =
  | { type: "attempt_started"; attempt: number; source: string; checkout: string }
  | { type: "attempt_prepared"; attempt: number; source: string; base: string; candidate: string; predecessor?: { operationId: string; attempt: number; candidate: string }; overlap: boolean; checkout: string }
  | { type: "attempt_invalidated"; attempt: number; reason: string }
  | { type: "publication_intent"; attempt: number; base: string; candidate: string }
  | { type: "client_operation"; repo: string; workspace: string; machine: string }
  | { type: "identity"; ticket?: number; spec?: number; submitterKind: "person" | "agent" | "unknown"; submitterId: string; harness?: string; sessionId?: string; workspace: string; machine: string }
  | { type: "queue_snapshot"; position: number; depth: number; waitingFor: string | null; paused: boolean }
  | { type: "stage_detail"; stage: RunnerStage; durationMs: number; conflict?: boolean; files?: string[]; installSource?: "cloned" | "fresh" | "existing"; base?: string; remoteMoved?: boolean; migrateDurationMs?: number; pushDurationMs?: number }
  | { type: "change_shape"; files: number; insertions: number; deletions: number; packages: string[]; apps: string[]; migrationBearing: boolean; testFiles: string[]; fileSet: string; sizeBucket: "small" | "medium" | "large" }
  | ClassifiedFact
  | { type: "held"; repo: string; commitId: string; retries: number; durationMs: number; published: boolean }
  | { type: "client"; id: string; fact: ClientFact }
  | { type: "verification_base"; base: string }
  | { type: "verification_passed"; base: string; candidate: string }
  /** A landing of one change; rows from before releases existed carry no `kind`. */
  | { type: "submitted"; kind?: "landing"; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string }
  /** A release of `commitId`, the integration commit a human approved. */
  | { type: "submitted"; kind: "release"; repo: string; commitId: string; migrationsReady: boolean; submittedBy: string }
  /** A deploy of `commitId`, already on the integration branch, to a declared environment. */
  | { type: "submitted"; kind: "deploy"; repo: string; environment: string; commitId: string; submittedBy: string; promotion?: PromotionFacts }
  /** A reset of the repository's declared target; `commitId` is its last landed commit at submission, for reading only. */
  | { type: "submitted"; kind: "reset"; repo: string; commitId: string; submittedBy: string }
  | { type: "stage"; stage: RunnerStage }
  /** One line of landing progress, as the local landing printed it. */
  | { type: "progress"; line: string }
  /** An executor began a command; `host` is where it ran. */
  | { type: "run_started"; runId: string; command: string; host: string; timeoutMs?: number; purpose?: RunPurpose; attempt?: number }
  | { type: "run_finished"; runId: string; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; outputBytes?: number; killed?: boolean; failingTests?: string[]; diagnostics?: string[]; testBodyRan?: boolean; diagnosticCapture?: "selected" | "incomplete" | "unavailable" }
  /** The integration bookmark moved locally to `commitId`; publication is next. Recovery reads it. */
  | { type: "integrated"; base: string; commitId: string }
  | { type: "landed"; base: string; commitId: string; branch: string; remote: string }
  /** A release's outcome. A promotion names `deploy`, the production deploy of its candidate, which the deploy lane runs. */
  | { type: "released"; result: CompletedRelease; deploy?: string }
  /** Every project of the environment deployed. */
  | { type: "deployed"; record: DeployRecord }
  /** The declared reset step ran against `target` from the exact source of `source`, the integration tip. */
  | { type: "reset"; target: string; source: string }
  /** The change touches migration trigger or artifact paths; the author lands it locally (until #11). */
  | { type: "declined"; reason: string; paths: string[] }
  /** `output` is the failing command's output verbatim (bounded as the local gate bounds it). */
  | { type: "failed"; stage: RunnerStage; reason: string; command?: string; output?: string; deployment?: DeployRecord }
  /** A queued operation replaced by a newer submission of the same change. */
  | { type: "superseded"; by: string }
  | { type: "cancelled"; reason: string; by?: string }
  /** Runner-wide, under RUNNER_CONTROL_ID: the queue takes no next operation until resumed. */
  | { type: "paused"; by: string }
  | { type: "resumed"; by: string }
  | { type: "integration_held"; repo: string; commitId: string; reason: string }
  | { type: "integration_recovered"; repo: string; commitId: string; retried?: boolean };

/** A stored event: `seq` is global and strictly increasing across operations. */
export type StoredEvent = { seq: number; operationId: string; at: string; event: OperationEvent };

/** One executed command of an operation, projected from its run events. */
export type RunRecord = {
  runId: string; command: string; host: string; startedAt: string; timeoutMs?: number; purpose?: RunPurpose; attempt?: number;
  finishedAt?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number; outputBytes?: number; killed?: boolean; failingTests?: string[]; diagnostics?: string[]; testBodyRan?: boolean; diagnosticCapture?: "selected" | "incomplete" | "unavailable";
};

/** Event types that close an operation. */
export const TERMINAL_EVENT_TYPES = ["landed", "released", "deployed", "reset", "failed", "declined", "superseded", "cancelled"] as const;

type OperationFields = {
  id: string; repo: string; commitId: string; submittedBy: string;
  status: OperationStatus;
  /** Latest stage reached; `queued` until it starts. */
  stage: RunnerStage;
  /** 1-based place in its lane's serial queue, across repositories (1 = running or next); absent once closed. */
  position?: number;
  /** While queued, the running operation it waits behind, e.g. `release 1a2b3c4d5e6f`. */
  waitingFor?: string;
  submittedAt: string; finishedAt?: string;
  runs: RunRecord[];
  /** The terminal event, when closed. */
  result?: Extract<OperationEvent, { type: (typeof TERMINAL_EVENT_TYPES)[number] }>;
  /** Seq of the latest event, for resuming a stream after it. */
  lastSeq: number;
};
export type LandingOperation = OperationFields & { kind: "landing"; changeId: string; bookmark: string };
/** Releases share the serial queue with landings: a landing submitted behind a release waits for it. */
export type ReleaseOperation = OperationFields & { kind: "release"; migrationsReady: boolean };

/** Deploys take turns in their own lane, so a slow deploy never holds a landing. */
export type DeployOperation = OperationFields & { kind: "deploy"; environment: string; promotion?: PromotionFacts };

/**
 * Resets share the serial queue with landings and releases: a landing finalizes its
 * migrations against the same target, so the two never run together.
 */
export type ResetOperation = OperationFields & { kind: "reset" };

/** An operation as clients see it: a pure projection of its stored events plus queue order. */
export type Operation = LandingOperation | ReleaseOperation | DeployOperation | ResetOperation;

/** The append-only log and its projections. One implementation, on `node:sqlite`. */
export interface OperationLog {
  /** Append one event; returns it stored. Appends are serialized by the caller's single process. */
  append(operationId: string, event: OperationEvent): StoredEvent;
  subscribe(listener: (event: StoredEvent) => void): () => void;
  snapshot(runner: string, now?: Date): QueueSnapshot;
  latestSeq(): number;
  /** Events after `afterSeq` (exclusive), optionally for one operation, in seq order. */
  events(options?: { operationId?: string; afterSeq?: number; limit?: number }): StoredEvent[];
  operation(id: string): Operation | null;
  /** Every operation of a change, newest first. */
  operationsForChange(repo: string, changeId: string): LandingOperation[];
  /** Open (queued or running) operations of a repository, oldest first: the queue. */
  openOperations(repo?: string): Operation[];
  /** A repository's deploys, newest first, optionally of one environment. */
  deployments(repo: string, environment?: string): DeployOperation[];
  /** A repository's release operations, newest first. */
  releases(repo: string): ReleaseOperation[];
  /** A repository's reset operations, newest first. */
  resets(repo: string): ResetOperation[];
  /** The latest landing a repository published, if any. */
  lastLanded(repo: string): { commitId: string; at: string } | null;
  /** The owner's pause, while it holds. */
  paused(): { by: string; at: string } | null;
  close(): void;
}

/** POST /v1/operations body. The commit must already be on the remote as `bookmark`. */
export type SubmitRequest = { repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string; identity?: Extract<OperationEvent, { type: "identity" }> };

/**
 * POST /v1/releases body: the full id of a candidate already published on the
 * integration branch. An open release of the same candidate is returned instead
 * of a second (`reattached: true`), so a confirm rerun follows it.
 */
export type ReleaseRequest = { repo: string; candidate: string; migrationsReady: boolean; submittedBy: string };
export type ReleaseResponse = { operation: ReleaseOperation; reattached: boolean };

/**
 * POST /v1/deploys body: the full id of a commit already on the integration branch.
 * An open deploy of the same environment is returned instead of a second.
 */
export type DeployRequest = { repo: string; environment: string; commitId: string; submittedBy: string };
export type DeployResponse = { operation: DeployOperation; reattached: boolean };

/**
 * POST /v1/resets body: reset the repository's declared target now. An open reset of
 * the repository is returned instead of a second.
 */
export type ResetRequest = { repo: string; submittedBy: string };
export type ResetResponse = { operation: ResetOperation; reattached: boolean };

/**
 * POST /v1/operations response.
 * - No open operation for the change: a new one (`reattached: false`).
 * - An open one for the same commit: that one (`reattached: true`), never a second.
 * - A queued one for an older commit: superseded by a new one (`superseded` names it).
 * - A running one for a different commit: HTTP 409 with that operation, so the client
 *   follows it and tells the author to land again afterwards.
 */
export type SubmitResponse = { operation: Operation; reattached: boolean; superseded?: string };

/**
 * Routes (all require `Authorization: Bearer <token>`; anything else is 401):
 * - POST /v1/operations                         SubmitRequest → SubmitResponse (200, or 409 `{ operation }`)
 * - POST /v1/releases                           ReleaseRequest → ReleaseResponse
 * - POST /v1/deploys                            DeployRequest → DeployResponse
 * - POST /v1/resets                             ResetRequest → ResetResponse (400 until the repository has landed here)
 * - GET  /v1/resets?repo=<owner/name>           → `{ operations: ResetOperation[] }` newest first
 * - GET  /v1/deploys?repo=<owner/name>[&environment=<name>] → `{ operations: DeployOperation[] }` newest first
 * - GET  /v1/releases?repo=<owner/name>         → `{ operations: ReleaseOperation[] }` newest first
 * - GET  /v1/operations/:id                     → `{ operation }` (404 when unknown)
 * - GET  /v1/operations/:id/events?after=<seq>  → `text/event-stream`, one `data: <StoredEvent JSON>` per event,
 *                                                 replaying after `seq`, then live; ends after the terminal event
 * - GET  /v1/operations/:id/log                 → `text/plain` retained operation events (not complete process output)
 * - POST /v1/operations/:id/cancel              → `{ operation }`; only a queued operation can be cancelled (else 409)
 * - GET  /v1/changes/:changeId?repo=<owner/name> → `{ operations: Operation[] }` newest first
 * - POST /v1/runner/kill                         `{ by }` → `{ operation }`: the running operation as the kill
 *                                                 found it, or `null` when idle; its `cancelled` verdict
 *                                                 (OWNER_KILL_REASON) follows in its events once it stops;
 *                                                 409 `{ operation, reason }` once it is past KILLABLE_STAGES
 * - POST /v1/runner/pause, /v1/runner/resume     `{ by }` → `{ paused: boolean }`; the running operation finishes
 * - GET  /v1/health                             → `{ ok: true, runner: <name>, queued: number, paused: boolean }`
 */
export type RunnerHandler = (request: Request) => Promise<Response>;

/** Runs one command in a checkout and returns its output and exit status. Never touches the log or the queue. */
export interface Executor {
  /** Where commands run; recorded on each run. */
  readonly host: string;
  /** Every run and descendant joins the same enforced host budget; failure refuses execution. */
  readonly combinedLimits?: boolean;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

/** Runner-side configuration: `~/.slipjay/runner/config.json`. The token comes from `SLIPJAY_RUNNER_TOKEN`. */
/** `operation` names the operation a kill targets; pause and resume take none. */
export type RunnerControlRequest = { by: string; operation?: string };

/**
 * What a kill found. `refused`: the operation is past the killable stages. `not_running`: the named
 * operation is not running (it finished, or has not started); `operation` is it, when known.
 * `ambiguous`: an unnamed kill found several running, so it killed none.
 */
export type KillOutcome =
  | { status: "idle" }
  | { status: "killed"; operation: Operation }
  | { status: "refused"; operation: Operation }
  | { status: "not_running"; operation: Operation | null }
  | { status: "ambiguous"; operations: Operation[] };

/** How many landings, releases and resets of different repositories run at once, unless the config sets `workers`. */
export const RUNNER_DEFAULT_WORKERS = 2;
/** The systemd slice every run's scope joins, so one set of limits covers every gate, deploy and their children. */
export const RUNNER_SLICE = "slipjay.slice";
/** The slice's limits unless the config sets `limits`: systemd resource-control values. */
export const RUNNER_DEFAULT_LIMITS: Readonly<Required<RunnerLimits>> = { memoryHigh: "40G", memoryMax: "48G", cpuQuota: "1400%", tasksMax: 4096 };
export type RunnerLimits = { memoryHigh?: string; memoryMax?: string; cpuQuota?: string; tasksMax?: number };

export type RunnerConfig = {
  /** Shown in every client progress line; defaults to the host name. */
  name?: string;
  /** Always loopback; the port defaults to RUNNER_DEFAULT_PORT. */
  listen?: { host?: "127.0.0.1"; port?: number };
  /**
   * Repositories this runner lands, keyed `owner/name`, with the git URL its warm checkout clones.
   * Repositories with the same `lane` share one serial lane: give it to repositories whose gates
   * share external state (a database, a deploy environment, fixed ports). Each defaults to its own.
   */
  repos: Record<string, { url: string; lane?: string; verificationDepth?: 1 | 2 }>;
  /**
   * jj settings the runner sets as repository config in every warm checkout before it
   * touches one, over RUNNER_JJ_DEFAULTS, so nothing depends on the host's own jj config. The runner commits as
   * `user.name` and `user.email`, which it requires at startup.
   */
  jj?: Record<string, string>;
  /**
   * How many repositories' serial lanes run at once (RUNNER_DEFAULT_WORKERS); each repository
   * still runs one landing, release or reset at a time. 1 is the single serial lane.
   */
  workers?: number;
  /** Combined limits of every run on a systemd host (RUNNER_DEFAULT_LIMITS), deploys included. */
  limits?: RunnerLimits;
};

/** jj settings the runner sets unless its config overrides them: YardSmith checks in files over jj's 1MiB default. */
export const RUNNER_JJ_DEFAULTS: Readonly<Record<string, string>> = { "snapshot.max-new-file-size": "64MiB" };

/** Why the runner refuses to start with `config`; null when it can. */
export const runnerConfigProblem = (config: RunnerConfig): string | null => {
  const missing = ["user.name", "user.email"].filter((key) => !config.jj?.[key]?.trim());
  if (missing.length) return `The runner config sets no ${missing.join(" or ")} under "jj": the runner commits as that identity`;
  if (config.workers !== undefined && !(Number.isSafeInteger(config.workers) && config.workers >= 1)) return `The runner config's "workers" must be a whole number of at least 1`;
  const limits = Object.entries(config.limits ?? {});
  if (limits.some(([key, value]) => !(key in RUNNER_DEFAULT_LIMITS) || (key === "tasksMax" ? !(Number.isSafeInteger(value) && Number(value) >= 1) : typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?[KMGT%]?$/.test(value))))
    return `The runner config's "limits" takes memoryHigh and memoryMax (such as "40G"), cpuQuota (such as "1400%") and tasksMax (a whole number)`;
  if (Object.values(config.repos).some((repo) => repo.lane !== undefined && (typeof repo.lane !== "string" || !repo.lane.trim()))) return `A repository's "lane" in the runner config must be a non-empty name`;
  if (Object.values(config.repos).some((repo) => repo.verificationDepth !== undefined && repo.verificationDepth !== 1 && repo.verificationDepth !== 2)) return `A repository's "verificationDepth" must be 1 or 2`;
  if (Object.values(config.repos).some((repo) => repo.verificationDepth === 2 && repo.lane !== undefined)) return `Depth-two verification requires an isolated repository lane`;
  return null;
};

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
  kind === "release" && lane === repositoryKey(repo) ? `${lane}\0release` : lane;

/** A repository's `owner/name` as the runner keys it: GitHub names are case-insensitive. */
export const repositoryKey = (name: string): string => name.toLowerCase();

export type HeldIntegrationState = { repo: string; commitId: string; since: string; reason: string; retries: number };
export type WatchOperation = Operation & {
  stageStartedAt?: string;
  timing: { state: "unknown" | "normal" | "amber" | "red"; medianMs: number | null; amberAfterMs: number | null; samples: number; commandDeadlineAt: string | null };
  kill: { allowed: boolean; reason: string | null };
};
export type QueueSnapshot = {
  version: 1; runner: string; seq: number; observedAt: string;
  lanes: { serial: WatchOperation[]; deploy: WatchOperation[] };
  paused: { by: string; at: string } | null; held: HeldIntegrationState[];
  recentReleases: ReleaseOperation[]; recentProductionDeploys: DeployOperation[]; lastStagingDeploys: DeployOperation[];
  lastSuite: { status: "unavailable" };
};
