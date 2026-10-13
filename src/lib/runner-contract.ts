import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";

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

/** Stages of one operation, in order; `queued` until the queue reaches it. */
export type RunnerStage = "queued" | "fetching" | "rebasing" | "installing" | "verifying" | "integrating" | "publishing";

/** Terminal and live states of an operation, derived from its events. */
export type OperationStatus = "queued" | "running" | "landed" | "failed" | "declined" | "superseded" | "cancelled";

/** One fact appended to the log. Nothing is updated or deleted. */
export type OperationEvent =
  | { type: "submitted"; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string }
  | { type: "stage"; stage: RunnerStage }
  /** One line of landing progress, as the local landing printed it. */
  | { type: "progress"; line: string }
  /** An executor began a command; `host` is where it ran. */
  | { type: "run_started"; runId: string; command: string; host: string }
  | { type: "run_finished"; runId: string; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number }
  /** The integration bookmark moved locally to `commitId`; publication is next. Recovery reads it. */
  | { type: "integrated"; base: string; commitId: string }
  | { type: "landed"; base: string; commitId: string; branch: string; remote: string }
  /** The change touches migration trigger or artifact paths; the author lands it locally (until #11). */
  | { type: "declined"; reason: string; paths: string[] }
  /** `output` is the failing command's output verbatim (bounded as the local gate bounds it). */
  | { type: "failed"; stage: RunnerStage; reason: string; command?: string; output?: string }
  /** A queued operation replaced by a newer submission of the same change. */
  | { type: "superseded"; by: string }
  | { type: "cancelled"; reason: string };

/** A stored event: `seq` is global and strictly increasing across operations. */
export type StoredEvent = { seq: number; operationId: string; at: string; event: OperationEvent };

/** One executed command of an operation, projected from its run events. */
export type RunRecord = {
  runId: string; command: string; host: string; startedAt: string;
  finishedAt?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; durationMs?: number;
};

/** An operation as clients see it: a pure projection of its stored events plus queue order. */
export type Operation = {
  id: string; repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string;
  status: OperationStatus;
  /** Latest stage reached; `queued` until it starts. */
  stage: RunnerStage;
  /** 1-based place in the runner's one serial queue, across repositories (1 = running or next); absent once closed. */
  position?: number;
  submittedAt: string; finishedAt?: string;
  runs: RunRecord[];
  /** The terminal event, when closed. */
  result?: Extract<OperationEvent, { type: "landed" | "declined" | "failed" | "superseded" | "cancelled" }>;
  /** Seq of the latest event, for resuming a stream after it. */
  lastSeq: number;
};

/** The append-only log and its projections. One implementation, on `node:sqlite`. */
export interface OperationLog {
  /** Append one event; returns it stored. Appends are serialized by the caller's single process. */
  append(operationId: string, event: OperationEvent): StoredEvent;
  /** Events after `afterSeq` (exclusive), optionally for one operation, in seq order. */
  events(options?: { operationId?: string; afterSeq?: number }): StoredEvent[];
  operation(id: string): Operation | null;
  /** Every operation of a change, newest first. */
  operationsForChange(repo: string, changeId: string): Operation[];
  /** Open (queued or running) operations of a repository, oldest first: the queue. */
  openOperations(repo?: string): Operation[];
  close(): void;
}

/** POST /v1/operations body. The commit must already be on the remote as `bookmark`. */
export type SubmitRequest = { repo: string; changeId: string; commitId: string; bookmark: string; submittedBy: string };

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
 * - GET  /v1/operations/:id                     → `{ operation }` (404 when unknown)
 * - GET  /v1/operations/:id/events?after=<seq>  → `text/event-stream`, one `data: <StoredEvent JSON>` per event,
 *                                                 replaying after `seq`, then live; ends after the terminal event
 * - GET  /v1/operations/:id/log                 → `text/plain` full run log
 * - POST /v1/operations/:id/cancel              → `{ operation }`; only a queued operation can be cancelled (else 409)
 * - GET  /v1/changes/:changeId?repo=<owner/name> → `{ operations: Operation[] }` newest first
 * - GET  /v1/health                             → `{ ok: true, runner: <name>, queued: number }`
 */
export type RunnerHandler = (request: Request) => Promise<Response>;

/** Runs one command in a checkout and returns its output and exit status. Never touches the log or the queue. */
export interface Executor {
  /** Where commands run; recorded on each run. */
  readonly host: string;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

/** Runner-side configuration: `~/.slipjay/runner/config.json`. The token comes from `SLIPJAY_RUNNER_TOKEN`. */
export type RunnerConfig = {
  /** Shown in every client progress line; defaults to the host name. */
  name?: string;
  /** Always loopback; the port defaults to RUNNER_DEFAULT_PORT. */
  listen?: { host?: "127.0.0.1"; port?: number };
  /** Repositories this runner lands, keyed `owner/name`, with the git URL its warm checkout clones. */
  repos: Record<string, { url: string }>;
};

/** A repository's `owner/name` as the runner keys it: GitHub names are case-insensitive. */
export const repositoryKey = (name: string): string => name.toLowerCase();
