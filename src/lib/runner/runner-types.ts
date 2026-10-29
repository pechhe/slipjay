import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { ReleaseResult } from "../release/release-types.ts";
import type { VerificationDeclaration } from "../policy/verification-policy.ts";
import type { StartSteps } from "../workspace/start-steps.ts";
import type { TestReportReading } from "./test-reports.ts";
// A value read only in a type position: `typeof TERMINAL_EVENT_TYPES` names a terminal event. Erased at runtime.
import type { TERMINAL_EVENT_TYPES } from "./runner-contract.ts";

/**
 * The runner's contract as data: every declaration a client, a projection or a test needs
 * to name an operation, an event or a request. Type-only, so reading it costs no runtime
 * module: `runner-contract.ts` holds the contract's values.
 */

/**
 * Stages of one operation, in order; `queued` until the queue reaches it. `paused` is
 * never recorded: a queued operation shows it while the owner has paused the runner.
 */
export type RunnerStage = "queued" | "paused" | "fetching" | "rebasing" | "installing" | "verifying" | "waiting-for-predecessor" | "integrating" | "finalizing" | "publishing" | "deploying" | "resetting";

/** Terminal and live states of an operation, derived from its events. */
export type OperationStatus = "queued" | "running" | "landed" | "released" | "verified" | "deployed" | "reset" | "audited" | "failed" | "declined" | "superseded" | "cancelled";

/** A release the runner verified and published, or found already published. */
export type CompletedRelease = Extract<ReleaseResult, { status: "released" | "released_by" }>;

/** A reached deploy step; elapsed time uses a monotonic clock. Absent from older records. */
export type DeployStepTiming = { startedAt: string; durationMs: number; outcome: "passed" | "failed" };
export type DeployStep = "build" | "migrate" | "health" | "activate" | "rollback";

/**
 * One project's outcome in a deploy: `url` is the deployment its command reported, and
 * `ok` that it deployed and passed its health check. In an environment that activates,
 * `activated` says whether the project's traffic moved to it; `unknown` means an
 * activation or recovery command failed and the runner cannot establish what serves.
 * A project proved moved back after activation failed is `restored`.
 */
export type DeployProjectOutcome = { name: string; ok: boolean; url?: string; reason?: string; activated?: boolean | "unknown"; restored?: boolean; timings?: Partial<Record<DeployStep, DeployStepTiming>> };

/**
 * What one deploy put in an environment: the commit, the commit the environment
 * served before (null for its first deploy), the commits between them, newest first,
 * and each project's outcome. A production problem narrows to one record.
 */
export type DeployRecord = {
  environment: string; commitId: string; previous: string | null;
  changes: { commitId: string; subject: string }[];
  projects: DeployProjectOutcome[];
  /** Absent on older records; elapsed time includes source preparation and cleanup. */
  startedAt?: string;
  durationMs?: number;
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
export type PromotionFacts = { merge: string; nonAdditiveMigrations: string[]; migrationArtifacts?: string[]; automatic?: AutomaticPromotion };

/** A promotion the runner submitted by itself, and the policy setting that allowed it: `process: "development"`. */
export type AutomaticPromotion = { setting: "process"; value: "development" };

/** One fact appended to the log. Nothing is updated or deleted. */
export type CauseClass = "gate" | "conflict" | "infrastructure" | "policy" | "killed" | "paused_out" | "held" | "superseded" | "cancelled";

export type ClientFact =
  | { kind: "workspace_start"; workspace: string; machine: string; startedAt: string }
  | { kind: "pool_claim"; workspace: string; hit: boolean; spareCount: number; durationMs: number; steps?: StartSteps }
  | { kind: "land_follow"; reattached: boolean }
  | { kind: "ssh_forward_failure"; reason: string; observedAt: string }
  | { kind: "preview_start"; workspace: string; port: number };

/** One failed verification check of a `failed` event; `runId` names its run when the runner ran it. */
export type VerificationFailureRef = { checkIndex: number; command: string; outcome: "nonzero_exit" | "timeout" | "cancelled" | "signal" | "spawn_failure"; runId?: string };

/** A failing test and the first line of its error, as the gate's failure summary paired them (rule 2). */
export type FirstError = { test: string; error: string };

/**
 * What a failure names beyond its cause class (rule 2): `firstErrors` pairs failing tests with their first error and
 * `failureCauses` names causes that are not a test (a type check, a timeout, memory, a moved candidate). Each is
 * absent when the gate's output named none.
 */
export type NamedFailure = { firstErrors?: FirstError[]; failureCauses?: string[] };

/** One failed check's own classification (SJ-51): `failingTests` are the tests that command failed. */
export type ClassifiedCheck = { checkIndex: number; command: string; cause: CauseClass; runId?: string; failingTests: string[]; diagnostics: string[] } & NamedFailure;

export type ClassifiedFact = NamedFailure & { type: "classified"; ruleVersion: number; cause: CauseClass; command?: string; failingTests: string[]; diagnostics: string[]; checks?: ClassifiedCheck[]; interaction?: { earlierOperation: string; fromBase: string; toBase: string } };

/**
 * Why a failing audit failed, as the person who looked recorded it. `culprits` names the
 * published commits of the landings that broke the suite; the others say no landing did.
 */
export type AuditCause = { kind: "culprits"; landings: string[] } | { kind: "flake" } | { kind: "infrastructure" } | { kind: "unresolved" };

export type RunPurpose = "gate" | "dependencies" | "finalization" | "migration_generate" | "migration_verify" | "deploy" | "reset";

/** The exact preinstalled runtime selected for a candidate command and its children. */
export type RuntimeIdentity = { name: "bun"; version: string; path: string; sha256: string };

export type CommandEvidence = { status: "unavailable"; reason: "capacity" } | {
  status: "recorded"; executable: string; args: string[]; cwd: string | null; environmentNames: string[];
  redacted: boolean; configurationSha256: string;
  runtime?: RuntimeIdentity;
};

export type CommandArtifact = { status: "unavailable"; reason: "private-output" | "capture-failed" } | {
  status: "retained"; version: 1; sha256: string; bytes: number; complete: boolean;
  retention: "runner-retention-policy";
};

export type ArtifactChunk = { version: 1; operationId: string; runId: string; sha256: string; bytes: number; offset: number; nextOffset: number | null; dataBase64: string };

export type FailureProvenance = {
  migrations: { paths: string[]; truncated?: true } | { unavailable: string };
  toolchain: { runtime: { name: string; version: string; sha256: string } | { unavailable: string }; lockfiles: { path: string; blob: string }[]; truncated?: true };
  fixture: { paths: { path: string; tree: string }[]; truncated?: true } | { unavailable: string };
};

export type OperationEvent =
  | { type: "provenance"; value: FailureProvenance }
  | { type: "repair_claimed"; claimId: string; tokenSha256: string; source: string; workspace: string; by: string }
  | { type: "repair_released"; claimId: string; by: string; reason: "released" | "revoked" }
  | { type: "repair_proposed"; operationId: string; claimId: string; source: string }
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
  /** `candidate` is the exact revision verified on `base`; rows from before it was recorded lack it. */
  /**
   * A remote verifier (`RemoteVerification`) took this attempt's gate: `ready` once the machine holds the exact candidate,
   * `finished` after the gate, with the tree the machine's checkout held then (null when tracked files changed), `failed`
   * when setup failed on a machine it had.
   */
  | { type: "remote_verification"; phase: "ready"; machine: RemoteMachine; slot: number; candidate: string; tree: string; setupMs: number; usage?: RemoteUsage | null }
  | { type: "remote_verification"; phase: "finished"; machine: RemoteMachine; tree: string | null; trackedChanges: number; machineMs: number; usage?: RemoteUsage | null }
  /** The machine was acquired but never came to hold the candidate; its readings before and after setup keep it in the window's spend. */
  | { type: "remote_verification"; phase: "failed"; machine: RemoteMachine; reason: string; usageBefore: RemoteUsage | null; usage: RemoteUsage | null }
  | { type: "verification_base"; base: string; candidate?: string;
      /** The candidate policy's time budgets, so metrics can judge each repository by its own. */
      budgets?: import("../policy/execution-policy.ts").TimeBudgets }
  | { type: "verification_passed"; base: string; candidate: string }
  /** A settings landing: only `fields` of the policy changed, so its landing checks did not run (see `policy-settings.ts`). */
  | { type: "verification_skipped"; base: string; candidate: string; fields: string[]; reason: string }
  | { type: "source_retained"; commitId: string; sourceRef: string; manifestSha256: string; handoffComplete: false }
  /** Retained source, manifest and command artifacts were deleted under the runner's retention policy. */
  | { type: "evidence_expired"; policy: "published" | "unadopted" }
  /** Immutable request-to-operation binding; survives terminal outcomes and follower loss. */
  | { type: "submission_request"; repairClaimId?: string; handoffSha256?: string; requestId: string; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string }
  /** A landing of one change; rows from before releases existed carry no `kind`. */
  | { type: "submitted"; kind?: "landing"; handoffSha256?: string; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string;
      /** Build-bound: the queue starts it only after `build_admitted`. `supersedes` is the admitted operation it replaces in Build's custody. */
      admission?: BuildAdmissionRecord;
      /** Declared by its author as belonging to no Spec: once published, reported to Build as a chore landing. */
      chore?: { title: string; helperRevisions: string[] } }
  /** Build could not answer admission; the ledger timestamp records when the reason changed. Does not settle admission. */
  | { type: "admission_unavailable"; reason: string }
  /** Build admitted this operation's `submitted` fact at `sequence`, its ledger sequence. */
  | { type: "build_admitted"; sequence: number; sessionId: string; recordedAt: string | null;
      /** The admitted Spec's and Tickets' numbers; absent on admissions recorded before they were read. */
      items?: BuildAdmittedItems }
  /** The receipt for this operation's fact at `sequence` reached Build, or was parked because Build refused it with `code`.
      A delivered chore landing names the Build item Build created for it, read by the id Build's answer gave. */
  | { type: "build_receipt"; sequence: number; state: "delivered" | "parked"; code?: string; chore?: { number: number } }
  /** An operator asked for the parked receipt at `sequence` to be sent again (`slipjay runner resend`): it is owed once more. */
  | { type: "build_receipt"; sequence: number; state: "requeued"; code: string; by: string }
  /** Runner-wide, under RUNNER_CONTROL_ID: Build stopped (or resumed) answering receipt delivery. */
  | { type: "build_delivery"; state: "available" | "unavailable"; reason?: string }
  /** A release of `commitId`, the integration commit a human approved. */
  | { type: "submitted"; kind: "release"; repo: string; commitId: string; migrationsReady: boolean; submittedBy: string; automatic?: AutomaticPromotion }
  /** A deploy of `commitId`, already on the integration branch, to a declared environment. */
  | { type: "submitted"; kind: "deploy"; repo: string; environment: string; commitId: string; submittedBy: string; promotion?: PromotionFacts }
  /** Release verification of `commitId`, which staging deployed, before anyone approves it: see `VerificationOperation`. */
  | { type: "submitted"; kind: "verification"; repo: string; commitId: string; submittedBy: string }
  /** A reset of the repository's declared target; `commitId` is its last landed commit at submission, for reading only. */
  | { type: "submitted"; kind: "reset"; repo: string; commitId: string; submittedBy: string }
  /** The recovery of a held integration, `commitId`: see `RecoveryOperation`. */
  | { type: "submitted"; kind: "recovery"; repo: string; commitId: string; submittedBy: string }
  /**
   * A nightly audit for the wall-clock `slot` (an ISO instant). `commitId` is the integration head last known at
   * submission, for reading only: the audited head is the one `audit_head` records when the run resolves it.
   */
  | { type: "submitted"; kind: "audit"; repo: string; commitId: string; slot: string; submittedBy: string }
  /** The exact integration-branch head an audit run resolved and is auditing; a rerun records its own. */
  | { type: "audit_head"; commit: string }
  /** An audit's declared commands all ran, in full, against `commit`: none skipped (`skipped`), none reused (`reused`). Anything less is not green. */
  | { type: "audited"; commit: string; commands: string[]; passed: string[]; skipped: string[]; reused: string[] }
  /** Someone recorded why this failing audit failed, for its whole open failure; the newest record stands. */
  | { type: "audit_cause"; cause: AuditCause; by: string; note?: string }
  | { type: "stage"; stage: RunnerStage; health?: RunnerHealth;
    /** On a landing's first stage when it was admitted as short: it counts toward `workers + 1`, not toward `workers`. */
    shortLanding?: true }
  /** One line of landing progress, as the local landing printed it. */
  | { type: "progress"; line: string }
  /** An executor began a command; `host` is where it ran. */
  | { type: "run_started"; runId: string; command: string; host: string; timeoutMs?: number; purpose?: RunPurpose; attempt?: number; commandEvidence?: CommandEvidence }
  /** What a gate run's test reports said (see `test-reports.ts`); absent when the command wrote none. */
  | ({ type: "test_report"; runId: string } & TestReportReading)
  | { type: "run_finished"; runId: string; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; outputBytes?: number; killed?: boolean; failingTests?: string[]; diagnostics?: string[]; testBodyRan?: boolean; diagnosticCapture?: "selected" | "incomplete" | "unavailable"; artifact?: CommandArtifact } & NamedFailure
  /** The integration bookmark moved locally to `commitId`; publication is next. Recovery reads it. */
  | { type: "integrated"; base: string; commitId: string; process?: "development" | "standard" }
  | { type: "landed"; base: string; commitId: string; branch: string; remote: string;
      /**
       * The repository and the deployment environments the landed commit's `slipjay.json` declares, so Build can
       * tell a repository with no staging from one whose deploy has not reached it. Absent when the policy could
       * not be read, and on landings from before 3.39.0: unknown, never "none".
       */
      repo?: string; declaredEnvironments?: string[];
      /** Release process applied at publication; light uses the standard release path. Unknown on older events. */
      process?: "development" | "standard" }
  /** A release's outcome. A promotion names `deploy`, the production deploy of its candidate, which the deploy lane runs. */
  | { type: "released"; result: CompletedRelease; deploy?: string }
  /** A pre-verification passed: `checks` ran against `candidate`'s tree while the release branch was at `base`. */
  | { type: "verified"; base: string; candidate: string; checks: VerificationDeclaration[]; nonAdditiveMigrations?: string[] }
  /** A running pre-verification stopped for `to` (a runner restart, or on older logs a landing, reset or release) and is queued again; its runs so far stay on record. */
  | { type: "yielded"; to: string }
  /** Every project of the environment deployed. */
  | { type: "deployed"; record: DeployRecord }
  /** The declared reset step ran against `target` from the exact source of `source`, the integration tip. */
  | { type: "reset"; target: string; source: string }
  /** The change touches migration trigger or artifact paths; the author lands it locally (until #11). */
  | { type: "declined"; reason: string; paths: string[]; build?: { code: string; retryable: boolean } }
  /**
   * `command` and `output` describe the first failing command (bounded as the local gate bounds it).
   * `failures` lists every failed verification check in declaration order (SJ-51).
   */
  | { type: "failed"; stage: RunnerStage; reason: string; command?: string; output?: string; failures?: VerificationFailureRef[]; deployment?: DeployRecord }
  /** A queued operation replaced by a newer submission of the same change. */
  | { type: "superseded"; by: string }
  | { type: "cancelled"; reason: string; by?: string }
  /** Runner-wide, under RUNNER_CONTROL_ID: the queue takes no next operation until resumed. */
  | { type: "paused"; by: string }
  | { type: "resumed"; by: string }
  | { type: "integration_held"; repo: string; commitId: string; reason: string; targetReached?: boolean; branch?: string; remote?: string }
  | { type: "integration_recovered"; repo: string; commitId: string; retried?: boolean }
  /** A hold discarded unpublished after reconciliation or proof that its target command never started. */
  | { type: "integration_released"; repo: string; commitId: string; reason: string; by?: string };

/** A landing's `submitted` event; rows from before releases existed carry no `kind`. */
export type LandingSubmission = Extract<OperationEvent, { type: "submitted"; changeId: string }>;

/** A stored event: `seq` is global and strictly increasing across operations. */
export type StoredEvent = { seq: number; operationId: string; at: string; event: OperationEvent };

/** One executed command of an operation, projected from its run events. */
export type RunRecord = NamedFailure & {
  runId: string; command: string; host: string; startedAt: string; timeoutMs?: number; purpose?: RunPurpose; attempt?: number; commandEvidence?: CommandEvidence;
  finishedAt?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number; outputBytes?: number; killed?: boolean; failingTests?: string[]; diagnostics?: string[]; testBodyRan?: boolean; diagnosticCapture?: "selected" | "incomplete" | "unavailable"; artifact?: CommandArtifact;
  /** The per-file timings its command reported (see `test-reports.ts`); absent when it wrote none. */
  testReport?: TestReportReading;
};

/** The runner's machine as a stage began: 1-minute load average, memory, and operations then running. */
export type RunnerHealth = { load1: number; cpus: number; freeMemoryBytes: number; totalMemoryBytes: number; running: number };

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
  /** When it left the queue for its first stage; set once, so a yield back to the queue keeps it. */
  startedAt?: string;
  /** Admitted as a short landing (see `runnerLogOptions`). */
  shortLanding?: true;
  runs: RunRecord[];
  /** The terminal event, when closed. */
  result?: Extract<OperationEvent, { type: (typeof TERMINAL_EVENT_TYPES)[number] }>;
  /** Seq of the latest event, for resuming a stream after it. */
  lastSeq: number;
};

export type LandingOperation = OperationFields & { kind: "landing"; changeId: string; bookmark: string; outcome?: LandingOutcome;
  /** Build-bound only: `pending` until Build admits it, and the queue never starts it while pending. */
  admission?: "pending" | "admitted";
  /** Latest unanswered admission attempt, while admission is pending. */
  admissionUnavailable?: { reason: string; at: string } };

/** Versioned recorded evidence, not authority to repair, retry, or release the author. */
export type LandingOutcome = {
  version: 1; operationId: string; repo: string; changeId: string; sourceCommitId: string;
  status: OperationStatus; stage: RunnerStage; terminal: boolean; asOfSeq: number;
  submittedAt: string; finishedAt?: string;
  identity?: Extract<OperationEvent, { type: "identity" }>;
  requestId?: string;
  sourceRetention?: Extract<OperationEvent, { type: "source_retained" }>;
  /** When set, retained source, manifest and artifacts no longer exist; the ledger's own record remains. */
  evidenceExpired?: { at: string; policy: "published" | "unadopted" };
  attempt?: Extract<OperationEvent, { type: "attempt_prepared" }>;
  publication: { state: "not-attempted" | "unconfirmed" | "published"; base?: string; commitId?: string; process?: "development" | "standard" };
  failure?: { reason: string; stage?: RunnerStage; command?: string; excerpt?: string; excerptTruncated: boolean };
  classification?: ClassifiedFact;
  runs: (RunRecord & { outcome: "passed" | "failed" | "incomplete" | "killed"; invalidated: boolean })[];
  evidence: { coverage: "partial"; gaps: string[]; logCommand: string; logPath: string };
  recovery: { kind: "follow" | "inspect-failure" | "reconcile-publication" | "already-published" | "owner-stopped" | "superseded" | "policy-refusal"; automaticRetry: false };
  /** Build-bound only. `receipts` concerns delivery to Build, never the landing's own verdict. */
  /** `unassociated`: its author declared it part of no Spec, so it is never admitted and reports only its publication.
      `chore` is Build's own item number for that publication, once Build has recorded it and its number was read. */
  build?: { admission: "pending" | "admitted" | "refused" | "unassociated"; receipts: "none" | "pending" | "delivered" | "parked";
    admissionUnavailable?: { reason: string; at: string }; chore?: { number: number } };
};

/** Releases share the serial queue with landings: a landing submitted behind a release waits for it. */
export type ReleaseOperation = OperationFields & { kind: "release"; migrationsReady: boolean; automatic?: AutomaticPromotion };

/**
 * Release verification of a commit staging deployed, run before the owner approves it so a
 * confirm of the same commit can skip straight to publication. It runs in its repository's
 * release lane, admitted like a release: beside the repository's landings, never beside its
 * reset, and never stopped by either. It starts once staging has deployed the latest landing.
 * It never counts as an approval.
 */
export type VerificationOperation = OperationFields & { kind: "verification" };

/** Deploys take turns in their own lane, so a slow deploy never holds a landing. */
export type DeployOperation = OperationFields & { kind: "deploy"; environment: string; promotion?: PromotionFacts };

/**
 * Resets share the serial queue with landings and releases: a landing finalizes its
 * migrations against the same target, so the two never run together.
 */
export type ResetOperation = OperationFields & { kind: "reset" };

/**
 * Publishes the integration a repository holds, so no later landing has to. It takes its repository's lane like a
 * landing, finishes and publishes `commitId` (the held commit when it was queued), and is `landed` once the
 * remote has it. A restart mid-recovery queues it again.
 */
export type RecoveryOperation = OperationFields & { kind: "recovery" };

/**
 * The nightly audit: the complete suite on the exact integration head, at a wall-clock time. It takes its
 * repository's lane like a landing (see `audit-scheduler.ts`). `slot` is the scheduled instant it covers; `head` the
 * commit it resolved and audited (absent until it resolves one); `cause` the newest cause recorded on it.
 */
export type AuditOperation = OperationFields & { kind: "audit"; slot: string; head?: string; cause?: { cause: AuditCause; by: string; at: string; note?: string } };

/** An operation as clients see it: a pure projection of its stored events plus queue order. */
export type Operation = LandingOperation | ReleaseOperation | VerificationOperation | DeployOperation | ResetOperation | RecoveryOperation | AuditOperation;

/** A landing that published, as the audit ledger reads it: the integration commit it made, on `base`. A recovery that published a held commit has no change. */
export type PublishedLanding = {
  operationId: string; changeId: string | null; commitId: string; base: string; at: string;
  /** `green`: the published commit passed the landing checks. `skipped`: a settings landing, whose checks did not run. */
  gate: "green" | "skipped" | "none";
};

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
  /**
   * A persisted landing request, including terminal operations, scoped to its repository, while the ledger keeps the
   * operation: inside the fact horizon (`LEDGER_FACT_MS`), or longer when another live fact still names it. A request whose
   * operation the ledger has forgotten is unknown, so resubmitting it opens a new operation.
   */
  submission(repo: string, requestId: string): { operation: LandingOperation; request: Extract<OperationEvent, { type: "submission_request" }> } | null;
  /** Every operation of a change, newest first. */
  operationsForChange(repo: string, changeId: string): LandingOperation[];
  /** Open (queued or running) operations of a repository, oldest first: the queue. */
  openOperations(repo?: string): Operation[];
  /** A repository's deploys, newest first, optionally of one environment. */
  deployments(repo: string, environment?: string): DeployOperation[];
  /** A repository's release operations, newest first. */
  releases(repo: string): ReleaseOperation[];
  /** A repository's pre-verifications, newest first. */
  verifications(repo: string): VerificationOperation[];
  /** A repository's reset operations, newest first. */
  resets(repo: string): ResetOperation[];
  /** A repository's audits, newest first. */
  audits(repo: string): AuditOperation[];
  /** The landings a repository published, oldest first, each with the gate evidence of the commit it made. */
  landings(repo: string): PublishedLanding[];
  /**
   * Whether staging has yet to finish a deploy of the repository's latest landing: a newer
   * candidate may be coming, so a pre-verification waits rather than verify one it would replace.
   */
  stagingDue(repo: string): boolean;
  /** The latest landing a repository published, if any. */
  lastLanded(repo: string): { commitId: string; at: string } | null;
  /**
   * Whether a repository's landings are short: its verify-stage p90 over the budget window, from at least the minimum
   * samples (`pipelineMetrics`), is at or below the log's `shortLandingP90Ms`. Never without that option.
   */
  shortRepository(repo: string): boolean;
  /** The owner's pause, while it holds. */
  paused(): { by: string; at: string } | null;
  /** Integrations kept locally but not yet published, by repository. */
  held(): HeldIntegrationState[];
  /** Every Build-bound landing (offered for admission, or declared a chore), with its own events: what receipt delivery reads. */
  buildBound(): { operation: LandingOperation; history: StoredEvent[] }[];
  /** Every event settling a held integration (confirmed published, or released unpublished), in ledger order, keyed by `recoveryKey(repo, commitId)`. */
  integrationSettlements(): Map<string, StoredEvent[]>;
  /** Checkpoint the write-ahead log, truncating it to the pages still in use. Safe to call while anything reads. */
  checkpoint(): void;
  /**
   * Forget what closed operations recorded: past the history window (`LEDGER_HISTORY_MS`) everything that only
   * explained them, keeping the facts a read across operations needs; past the fact horizon (`LEDGER_FACT_MS`) the
   * operation and those facts too. Open operations, ones inside the window, ones whose retained evidence has not been
   * recorded as expired, and the ids in `keep` stay whole. Returns how much went.
   */
  forgetHistory(now?: Date, keep?: ReadonlySet<string>): { events: number; operations: number };
  /** The operations that still name retained evidence (a source ref, or a retained command artifact): the retention pass's work. */
  retainedEvidence(): string[];
  /**
   * The operations with a receipt-key event (`RECEIPT_KEY_EVENT_TYPES`) that has no `build_receipt` settlement: the only
   * ones that can still owe Build a receipt, so the only ones whose history an owed receipt is built from.
   */
  unsettledReceipts(): string[];
  close(): void;
}

/** POST /v1/operations body. The commit must already be on the remote as `bookmark`.
 * Optional requestId binds a transport retry to one operation, even after it finishes.
 * It acknowledges request identity only, not a durable source handoff.
 */
export type SubmitRequest = { repair?: RepairProof; handoff?: SubmissionHandoff; requestId?: string; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string; identity?: Extract<OperationEvent, { type: "identity" }> };

/**
 * POST /v1/releases body: the full id of a candidate already published on the
 * integration branch. An open release of the same candidate is returned instead
 * of a second (`reattached: true`), so a confirm rerun follows it.
 */
export type ReleaseRequest = { repo: string; candidate: string; migrationsReady: boolean; submittedBy: string };

export type ReleaseResponse = { operation: ReleaseOperation; reattached: boolean };

/**
 * POST /v1/verifications body: the full id of a commit staging recorded a green deploy of. Queues its
 * pre-verification unless it has one on record (any status), without superseding another; 400 for a commit staging did not deploy green.
 */
export type VerificationRequest = { repo: string; commitId: string; submittedBy: string };

export type VerificationResponse = { operation: VerificationOperation; requested: boolean };

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
 * POST /v1/audits/cause body: record why a failing audit failed. `audit` names the failing audit (default: the
 * repository's open failure); `landings` are culprit landings, by operation id or by commit id (12 or more hex digits).
 * Exactly one of `landings` (one or more) and `kind` (the other causes) is given.
 */
export type AuditCauseRequest = { repo: string; by: string; audit?: string; note?: string } & ({ landings: string[]; kind?: undefined } | { kind: "flake" | "infrastructure" | "unresolved"; landings?: undefined });

/**
 * POST /v1/operations response.
 * - A known requestId returns its original operation, including a terminal result.
 *   Reusing it for different source/attribution returns 409 `{ error }` without submitting.
 * - No open operation for the change: a new one (`reattached: false`).
 * - An open one for the same commit: that one (`reattached: true`), never a second.
 * - A queued one for an older commit: superseded by a new one (`superseded` names it).
 * - A running one for a different commit: HTTP 409 with that operation, so the client
 *   follows it and tells the author to land again afterwards.
 */
export type SubmitResponse = { requestId?: string; operation: Operation; reattached: boolean; superseded?: string };

/**
 * Routes (all require `Authorization: Bearer <token>`; anything else is 401):
 * - POST /v1/operations                         SubmitRequest → SubmitResponse (200, or 409 `{ operation }`)
 * - POST /v1/releases                           ReleaseRequest → ReleaseResponse
 * - POST /v1/deploys                            DeployRequest → DeployResponse
 * - POST /v1/verifications                      VerificationRequest → VerificationResponse
 * - POST /v1/resets                             ResetRequest → ResetResponse (400 until the repository has landed here)
 * - GET  /v1/resets?repo=<owner/name>           → `{ operations: ResetOperation[] }` newest first
 * - GET  /v1/audits?repo=<owner/name>           → `{ operations: AuditOperation[], summary: AuditSummary }` newest first
 * - POST /v1/audits/cause                       AuditCauseRequest → `{ operation: AuditOperation, summary: AuditSummary }` (400 when it names no failing audit or an unknown landing)
 * - GET  /v1/deploys?repo=<owner/name>[&environment=<name>] → `{ operations: DeployOperation[] }` newest first
 * - GET  /v1/releases?repo=<owner/name>         → `{ operations: ReleaseOperation[] }` newest first
 * - GET  /v1/operations/:id/source              → authenticated bounded Git bundle (no mutation)
 * - GET  /v1/operations/:id                     → `{ operation }` (404 when unknown)
 * - GET  /v1/operations/:id/events?after=<seq>  → `text/event-stream`, one `data: <StoredEvent JSON>` per event,
 *                                                 replaying after `seq`, then live; ends after the terminal event
 * - GET  /v1/operations/:id/log                 → `text/plain` retained operation events (not complete process output)
 * - GET  /v1/operations/:id/outcome             → `{ outcome: LandingOutcome }` (409 for other operation kinds)
 * - GET  /v1/operations/:id/artifacts/:runId?offset=0&limit=1048576 → ArtifactChunk (410 if unavailable; 400 invalid range)
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
  /**
   * Stop every command an earlier process of this executor's owner left running, before anything
   * reuses their checkouts; throws when they cannot be shown stopped. Absent when runs cannot outlive
   * their process's knowledge of them.
   */
  recover?(): Promise<void>;
}

/** What the remote machine's provider has billed for it so far: running time, idle included, and its price. */
export type RemoteUsage = { seconds: number; dollars: number };

/** The remote machine an attempt's gate ran on, as the ledger records it. */
export type RemoteMachine = { verifier: "boat"; id: string; name: string; size: string; image: string };

/**
 * Where a repository's gate runs when its runner entry names a `verifier`: a machine the attempt has to itself, whose
 * checkout sits at the runner checkout's own path, so commands, evidence and test reports read as they would locally.
 * The runner still prepares the candidate locally; only the gate's commands run remotely.
 */
export interface RemoteVerification {
  /** A machine for `slot` of `repo`, holding exactly `candidate` on `base` with `integrationBranch` at `base`. */
  open(input: { repo: string; slot: number; checkout: string; base: string; candidate: string; integrationBranch: string; signal: AbortSignal }): Promise<RemoteAttempt>;
  /** Stop whatever an earlier runner process left running on the pools of `repos`; best effort. */
  recover?(repos: readonly string[]): Promise<void>;
}

/** An `open` that failed once it had a machine: which machine, and its billing at the failure. */
export type RemoteOpenFailure = Error & { remote?: { machine: RemoteMachine; usageBefore: RemoteUsage | null; usage: RemoteUsage | null } };

export interface RemoteAttempt {
  /** Runs the gate's commands; `runtime` is the Bun they run with there, for command evidence. */
  readonly executor: Executor & { runtime?: RuntimeIdentity };
  readonly machine: RemoteMachine;
  /** The tree of the files the machine's checkout holds before the gate: the candidate's, or the attempt fails. */
  readonly tree: string;
  /** The machine's billing when it took the attempt. */
  readonly usage: RemoteUsage | null;
  /** The checkout's files after the gate: `tree` null, and a count, when they no longer match the candidate. */
  finish(): Promise<{ tree: string | null; trackedChanges: number; usage: RemoteUsage | null }>;
  /** Stop everything the attempt started on the machine. */
  close(): Promise<void>;
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
  repos: Record<string, { url: string; lane?: string; verificationDepth?: 1 | 2;
    /** Run the gate on a remote verifier (see `boat`) instead of this host. Depth two then needs no host budget. */
    verifier?: "boat" }>;
  /**
   * boat.dev VMs for repositories whose `verifier` is `boat`: one per verification place, forked from `image` (a sandbox
   * kept stopped as the starting image) and reached over SSH with `sshKey`. `cli` is the boat CLI, which authenticates
   * with `BOAT_API_KEY` from the runner's environment.
   */
  boat?: { image: string; cli?: string; sshKey?: string; size?: "small" | "default" | "large" | "xlarge" };
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
  /** Runner-wide deploy concurrency, separate from workers; default 1, always one per repository. */
  deployWorkers?: number;
  /**
   * A repository whose landings' verify-stage p90 over the budget window (`pipeline-metrics.ts`) is at or below this
   * many seconds is short (RUNNER_DEFAULT_SHORT_LANDING_SECONDS): its landings may start while other operations hold
   * every worker, at most `workers + 1` running in all. Only with enforced combined limits.
   */
  shortLandingP90Seconds?: number;
  /** Combined limits of every run on a systemd host (RUNNER_DEFAULT_LIMITS), deploys included. */
  limits?: RunnerLimits;
  /** HQ's origin for Build admission and receipts; with BUILD_TOKEN_ENV, required to accept Build-bound submissions. */
  build?: { origin: string };
};

export type HeldIntegrationState = { repo: string; commitId: string; since: string; reason: string; retries: number; targetReached?: boolean; branch?: string; remote?: string };

export type WatchOperation = Operation & {
  stageStartedAt?: string;
  /** The Spec its submitter named: the Build item or Issue the submitting workspace was started for, or a `Spec:` trailer. */
  spec?: number;
  timing: { state: "unknown" | "normal" | "amber" | "red"; medianMs: number | null; amberAfterMs: number | null; samples: number; commandDeadlineAt: string | null };
  kill: { allowed: boolean; reason: string | null };
};

/** A terminal event failure classification reads: the raw fact, before any cause is decided. */
export type FailureEvent = Extract<OperationEvent, { type: "failed" | "declined" | "cancelled" | "superseded" }>;

/**
 * The interpretations the event store may apply on its caller's behalf. The store owns none of them: it
 * appends and reads events. A runner composes the ones it reports (from `failure-classification`,
 * `landing-outcome`, `runner-watch-projection`, `build-receipts` and `pipeline-metrics`); a caller that
 * reads the ledger itself supplies none and gets the bare facts.
 */
export type OperationLogProjections = {
  /** The classification to append before a failure, declined, cancelled or superseded event. */
  classify?(input: { event: FailureEvent; operation: Operation | null; history: StoredEvent[]; paused: boolean; held: boolean }): ClassifiedFact;
  /** A landing's recorded outcome, attached to its projected operation. */
  landingOutcome?(operation: LandingOperation, history: StoredEvent[]): LandingOutcome;
  /** The watch timing and kill permission a snapshot's lanes report; absent, lanes carry no timing and no kill permission. */
  watch?(operation: Operation, events: readonly StoredEvent[], now: Date): WatchOperation;
  /** Build's receipt-delivery state a snapshot reports; absent, the snapshot reports none. */
  deliveryState?(log: OperationLog): QueueSnapshot["build"];
  /** The repositories whose landings are short at `p90Ms`, keyed as `repositoryKey`, read from the budget-window events; absent, none is short. */
  shortRepositories?(read: (since: Date) => StoredEvent[], now: Date, p90Ms: number): ReadonlySet<string>;
};

export type QueueSnapshot = {
  version: 1; runner: string; seq: number; observedAt: string;
  lanes: { serial: WatchOperation[]; deploy: WatchOperation[] };
  paused: { by: string; at: string } | null; held: HeldIntegrationState[];
  /** Finished history carries its result but not its runs, which `runner log` and the outcome endpoint keep. */
  recentReleases: Omit<ReleaseOperation, "runs">[]; recentProductionDeploys: Omit<DeployOperation, "runs">[]; lastStagingDeploys: Omit<DeployOperation, "runs">[];
  lastSuite: { status: "unavailable" };
  /** Receipt delivery to Build; null while the runner has never admitted a Build-bound landing. */
  build: BuildDeliveryState | null;
};

export type RepairProof = { operationId: string; claimId: string; token: string };
/**
 * The author's Build binding, retained as supplied. `bodyRevision` is the numeric HQ Docs revision and is
 * unrelated to the Spec's `bodySha256`; `null` says the author does not know it. An empty `ticketIds` is Spec
 * work with no Tickets. A handoff with no `build` key makes no claim about Build at all.
 */
export type BuildBinding = { specId: string; ticketIds: string[]; bodyRevision: number | null; bindGeneration: number; sessionId: string };
/** The author's explicit statement that this work belongs to no Spec: once published, Build records it as a chore. */
export type BuildUnassociated = { unassociated: true };

/** Author reports are provenance, never runner verification or repair authority. */
export type SubmissionHandoff = {
  version: 1; source: string; intent: string; scope: string[];
  spec: { ref: string; bodySha256: string; snapshot: string } | null;
  build?: BuildBinding | BuildUnassociated;
  helpers: { revision: string; base: string; scope: string }[];
  checks: { revision: string; command: string; result: "passed" | "failed" | "not-run"; detail: string }[];
  reviews: { revision: string; reference: string; result: "complete" | "incomplete"; detail: string }[];
  toolchain: { name: string; version: string }[]; gaps: string[];
};
/** The numbers of the Spec and Tickets an admission names, read from Build by their ids. */
export type BuildAdmittedItems = { specNumber: number; ticketNumbers: number[] };

/**
 * What a Build-bound `submitted` record keeps so its admission can be resent from the ledger alone, byte for
 * byte, by the handler or a later reconciliation. `supersedes` is the admitted operation it replaces in Build's custody.
 */
export type BuildAdmissionRecord = {
  binding: BuildBinding; specBodyHash: string | null; helperRevisions: string[]; repairsOperationId: string | null; supersedes: string | null;
};

/** Delivery as the runner snapshot reports it: receipts still owed, and whether Build is answering. */
export type BuildDeliveryState = {
  state: "available" | "unavailable"; since: string | null; reason: string | null;
  pending: number; oldestPendingAt: string | null; parked: number;
};
