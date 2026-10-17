import { validSubmissionHandoff, prepareSubmissionHandoff } from "./submission-handoff.ts";
import type { RepairProof } from "./repair-claim.ts";
import type { SubmissionHandoff } from "./submission-handoff.ts";
import { BuildRefusal, trackerOf } from "./tracker.ts";
import { BUILD_SESSION_ENV, buildLandingHandoff } from "./build-handoff.ts";
import type { BuildReadAction } from "./tracker.ts";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open, link, readFile, rm, lstat } from "node:fs/promises";
import { SOURCE_BUNDLE_MAX_BYTES } from "./submission-source-export.ts";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createConnection, createServer } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess } from "./bounded-process.ts";
import { fetchIntegration, finishLandedWorkspace, landingIO, landingPreview, publicationRemote } from "./landing-steps.ts";
import { githubRepository } from "./issue-references.ts";
import { redactMigrationOutput } from "./migration-command-evidence.ts";
import { candidateBookmark, RUNNER_DEFAULT_PORT, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { ClientFact, DeployOperation, Operation, ReleaseOperation, ResetResponse, StoredEvent } from "./runner-contract.ts";
import { jj, revisionExists, revisionFacts, workspaceContext } from "./workspace-jj.ts";
import type { PromotionState } from "./release.ts";
import type { RevisionFacts, WorkspaceContext, WorkspaceMetadata } from "./workspace-jj.ts";
import { releaseLandedWorkspace } from "./workspace-lifecycle.ts";
import { metadataPath, readLandingState, statePath, workspaceMetadata } from "./workspace-state.ts";
import { poolRefillLogPath, stateHome } from "./workspace-paths.ts";
import { runnerSetting } from "./machine-config.ts";
import { sweepDisposableWorkspaces } from "./workspace-sweep.ts";
import type { SweepResult } from "./workspace-sweep.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

type PendingRunnerFact = {
  id: string; fact: Extract<ClientFact, { kind: "ssh_forward_failure" }>;
  operationId?: string; repo: string; workspace: string; machine: string; runnerBinding: string;
};

// A transport address is hashed so even a credential-bearing URL cannot enter metadata.
const runnerBinding = (location: string): string => createHash("sha256").update(new URL(location).href).digest("hex");
const pendingFacts = (metadata: { [key: string]: unknown }): PendingRunnerFact[] =>
  Array.isArray(metadata.pendingRunnerFacts) ? metadata.pendingRunnerFacts as PendingRunnerFact[] : [];

async function updatePendingFacts(context: WorkspaceContext, update: (pending: PendingRunnerFact[]) => PendingRunnerFact[]): Promise<boolean> {
  return withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    if (!metadata || context.current.name === "default") return false;
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, pendingRunnerFacts: update(pendingFacts(metadata)) });
    return true;
  }, { waitMs: 1000 });
}

/**
 * The runner a workspace submitted each commit to, kept from before submission until its outcome is known, so
 * a landing reattaches where it was submitted even after this machine's runner location changes.
 * `location` records it, null forgets it; without either it is only read.
 */
async function landingRunner(context: WorkspaceContext, commitId: string, location?: string | null): Promise<string | undefined> {
  if (context.current.name === "default") return undefined;
  const runners = (metadata: WorkspaceMetadata | null) => ({ ...(metadata?.landingRunners as Record<string, string> | undefined) });
  if (location === undefined) return runners(await workspaceMetadata(context.current.name))[commitId];
  return withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    if (!metadata) return undefined;
    const next = runners(metadata);
    if (location === null) delete next[commitId];
    else next[commitId] = location;
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, landingRunners: next });
    return location ?? undefined;
  }, { waitMs: 1000 });
}

/** Keep ambiguous requests across process restarts; only a known response releases the identity. */
const landingRequestKey = (location: string, repo: string, commitId: string) =>
  createHash("sha256").update(JSON.stringify([runnerBinding(location), repo, commitId])).digest("hex");

async function landingRequestIdentity(context: WorkspaceContext, location: string, repo: string, commitId: string, acknowledge?: string): Promise<string | undefined> {
  // Direct/default checkouts have no assigned-workspace metadata; they retain the legacy follower contract.
  if (context.current.name === "default") return undefined;
  const key = landingRequestKey(location, repo, commitId);
  return withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    // A checkout outside workspace storage has nowhere durable to keep it: the legacy follower contract.
    if (!metadata) return undefined;
    const pending = { ...(metadata.pendingLandingRequests as Record<string, string> | undefined) };
    if (acknowledge) {
      if (pending[key] !== acknowledge) return undefined;
      delete pending[key];
      await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, pendingLandingRequests: pending });
      return undefined;
    }
    if (pending[key]) return pending[key];
    if (Object.keys(pending).length >= 32) throw new Error("Too many unresolved landing requests; reconcile earlier submissions before submitting more source");
    const id = randomUUID();
    pending[key] = id;
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, pendingLandingRequests: pending });
    return id;
  }, { waitMs: 1000 });
}

/**
 * The handoff `land` wrote for a candidate, replayed while that submission can still be retried: its request
 * is unacknowledged, or (`awaitingAdmission`) its operation still awaits Build admission. A handoff regenerated
 * from Build's current state could differ, and the runner refuses a retry whose evidence changed.
 * Otherwise Build's current state is read afresh: a refused landing is retried under the lead's new bind.
 * Each candidate keeps its own, recorded together with its request identity, so a caller racing another
 * whose request is still unresolved replays it; one that loses the race after it was acknowledged follows
 * the operation submitted first (the runner refuses its different evidence as `handoff_differs`).
 */
async function writtenLandingHandoff(context: WorkspaceContext, key: string, awaitingAdmission: boolean, write: () => Promise<SubmissionHandoff>): Promise<SubmissionHandoff> {
  // Direct/default checkouts have nowhere durable to keep it; their chore handoff is the same each time.
  if (context.current.name === "default") return await write();
  const pendingOf = (metadata: WorkspaceMetadata | null) => ({ ...(metadata?.pendingLandingRequests as Record<string, string> | undefined) });
  const handoffsOf = (metadata: WorkspaceMetadata | null) => ({ ...(metadata?.landingHandoffs as Record<string, SubmissionHandoff> | undefined) });
  const replayable = (metadata: WorkspaceMetadata | null) => awaitingAdmission || pendingOf(metadata)[key] ? handoffsOf(metadata)[key] : undefined;
  const retained = replayable(await workspaceMetadata(context.current.name));
  if (retained) return retained;
  const handoff = await write();
  return withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    if (!metadata) return handoff;
    const raced = replayable(metadata);
    if (raced) return raced;
    const pending = pendingOf(metadata);
    if (!pending[key]) {
      if (Object.keys(pending).length >= 32) throw new Error("Too many unresolved landing requests; reconcile earlier submissions before submitting more source");
      pending[key] = randomUUID();
    }
    // The newest last. One whose request is unresolved is always kept (those are capped above); of the
    // acknowledged, which a retry needs only while admission is pending, the newest 32.
    const handoffs = handoffsOf(metadata);
    delete handoffs[key];
    const acknowledged = Object.keys(handoffs).filter((other) => !pending[other]).slice(0, -32);
    const kept = Object.entries(handoffs).filter(([other]) => !acknowledged.includes(other));
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, pendingLandingRequests: pending, landingHandoffs: Object.fromEntries([...kept, [key, handoff]]) });
    return handoff;
  }, { waitMs: 1000 });
}

async function retainForwardFailure(cwd: string, location: string, error: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const context = await workspaceContext(cwd);
    if (!context || context.current.name === "default") throw new Error("no isolated workspace");
    const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
    if (!repo) throw new Error("unknown repository");
    const reason = redactMigrationOutput(error instanceof Error ? error.message : String(error), cwd, { ...process.env, ...env })
      .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
    const pending: PendingRunnerFact = { id: randomUUID(), fact: { kind: "ssh_forward_failure", reason, observedAt: new Date().toISOString() },
      repo, workspace: context.current.name, machine: hostname(), runnerBinding: runnerBinding(location) };
    if (!await updatePendingFacts(context, (facts) => [...facts, pending])) throw new Error("missing workspace metadata");
  } catch {
    console.error("SSH forwarding failure could not be durably recorded in existing isolated workspace metadata.");
  }
}

async function flushForwardFailures(cwd: string, location: string, baseUrl: string, token: string): Promise<void> {
  // Delivery is best effort. A telemetry transport failure cannot block the caller's successful connection.
  try {
    const context = await workspaceContext(cwd);
    if (!context || context.current.name === "default") return;
    const metadata = await workspaceMetadata(context.current.name);
    if (!metadata) return;
    for (const pending of pendingFacts(metadata).filter((fact) => fact.runnerBinding === runnerBinding(location))) {
      let operationId = pending.operationId;
      if (!operationId) {
        const response = await request(baseUrl, token, "/v1/client-operations", { method: "POST", signal: AbortSignal.timeout(5000),
          headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: pending.repo, workspace: pending.workspace, machine: pending.machine }) });
        if (!response.ok) throw new Error("Runner refused client operation");
        const body = await response.json() as { id: string };
        if (typeof body.id !== "string" || !body.id) throw new Error("Runner returned no client operation");
        operationId = body.id;
        let retained = false;
        await updatePendingFacts(context, (facts) => facts.map((fact) => {
          if (fact.id !== pending.id) return fact;
          retained = true;
          operationId = fact.operationId ?? operationId;
          return { ...fact, operationId };
        }));
        if (!retained) continue;
      }
      await postClientFact(baseUrl, token, operationId!, pending.fact, pending.id);
      await updatePendingFacts(context, (facts) => facts.filter((fact) => fact.id !== pending.id));
    }
  } catch { /* Keep unacknowledged facts for the next successful connection. */ }
}

export function runnerLocation(env: NodeJS.ProcessEnv = process.env): string | null {
  return runnerSetting(env).value;
}

/** The token read from Bitwarden, once per process: one command can reach the runner many times. */
let savedToken: Promise<string> | undefined;

export async function runnerToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SLIPJAY_RUNNER_TOKEN) return env.SLIPJAY_RUNNER_TOKEN;
  // A failed lookup is not kept, so a later call (a watcher's retry) asks Bitwarden again.
  savedToken ??= bitwardenRunnerToken(env).catch((error: unknown) => { savedToken = undefined; throw error; });
  return savedToken;
}

async function bitwardenRunnerToken(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runBoundedProcess({ executable: "bws", args: ["secret", "list"], cwd: process.cwd(), env,
    timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.exitCode === 0) {
    try {
      const entries = JSON.parse(result.stdout) as { key: string; value: string }[];
      const token = entries.find((entry) => entry.key === "SLIPJAY_RUNNER_TOKEN")?.value;
      if (token) return token;
    } catch { /* Never include secret-list output in an error. */ }
  }
  throw new Error("Set SLIPJAY_RUNNER_TOKEN or save the Bitwarden key SLIPJAY_RUNNER_TOKEN");
}

/** The runner answered and refused: unlike a lost response, nothing it was asked to do happened. */
export class RunnerRequestRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new RunnerRequestRefused(401, "runner refused the credential; check SLIPJAY_RUNNER_TOKEN");
  if (response.ok || response.status === 409) return response;
  // A refusal (400) names why in its body, such as a reset of a repository that never landed on the runner;
  // so does a known retryable one (503), such as Build admission that did not complete.
  const refusal = response.status === 400 || response.status === 503 ? ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error : undefined;
  if (response.status === 400) throw new RunnerRequestRefused(400, `Runner request refused: HTTP 400: ${typeof refusal === "string" ? refusal : "invalid request"}`);
  if (response.status === 503 && typeof refusal === "string") throw new RunnerRequestRefused(503, `Runner request refused: HTTP 503: ${refusal}`);
  throw new Error(`Runner request failed: HTTP ${response.status}`);
}

export async function connectRunner(location: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<{ baseUrl: string; name: string; close(): void }> {
  const token = await runnerToken(env);
  const url = new URL(location);
  let baseUrl = location;
  let close = () => {};
  if (url.protocol === "ssh:") {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot allocate SSH forwarding port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const ssh = spawn("ssh", ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-L",
      `${port}:127.0.0.1:${url.port || RUNNER_DEFAULT_PORT}`, `${url.username ? `${url.username}@` : ""}${url.hostname}`], { stdio: ["ignore", "ignore", "pipe"] });
    close = () => { ssh.kill(); };
    let stderr = "";
    let spawnError: Error | undefined;
    ssh.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65536); });
    ssh.on("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    try {
      while (!await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(250, () => done(false));
      })) {
        if (spawnError || ssh.exitCode !== null || Date.now() >= deadline) throw new Error(`SSH runner connection failed: ${spawnError?.message ?? stderr}`);
        await delay(100);
      }
    } catch (error) { close(); await retainForwardFailure(cwd, location, error, env); throw error; }
    baseUrl = `http://127.0.0.1:${port}`;
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Runner location must use http://, https:// or ssh://");
  }
  try {
    const health = await (await request(baseUrl, token, "/v1/health", { signal: AbortSignal.timeout(15_000) })).json() as { runner: string };
    await flushForwardFailures(cwd, location, baseUrl, token);
    return { baseUrl, name: health.runner, close };
  } catch (error) { close(); throw error; }
}

const RECONNECT_ATTEMPTS = 30;
const RECONNECT_DELAY_MS = 2000;

async function follow(baseUrl: string, token: string, initial: Operation, name: string, onLine: (line: string) => void,
  env: NodeJS.ProcessEnv, signal?: AbortSignal, onStage?: (stage: string) => void): Promise<Operation> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let operation = initial;
  let lastSeq = initial.lastSeq;
  let lastLine = "";
  let lastStage = "";
  const show = () => {
    if (operation.stage !== lastStage) { lastStage = operation.stage; onStage?.(operation.stage); }
    const queued = operation.status === "queued" && operation.position !== undefined
      ? ` (position ${operation.position}${operation.waitingFor ? `, behind ${operation.waitingFor}` : ""})` : "";
    const line = `[runner ${name}] ${operation.stage}${queued}`;
    if (line !== lastLine) { lastLine = line; onLine(line); }
  };
  const refresh = async () => {
    operation = (await (await request(baseUrl, token, `/v1/operations/${initial.id}`, { signal: controller.signal })).json() as { operation: Operation }).operation;
    show();
  };
  // A restarting runner refuses connections for a few seconds: keep asking, then hand back.
  const reconnect = async () => {
    for (let attempt = 1; ; attempt++) {
      try { return await refresh(); } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof Error && /credential|HTTP/.test(error.message)) throw error;
        if (attempt === 1) onLine(`[runner ${name}] connection lost; reconnecting`);
        if (attempt === RECONNECT_ATTEMPTS) throw new Error("Lost the runner connection; rerun the command to reattach", { cause: error });
        await delay(RECONNECT_DELAY_MS, undefined, { signal: controller.signal });
      }
    }
  };
  show();
  const polling = (async () => {
    while (!controller.signal.aborted) {
      await delay(3000, undefined, { signal: controller.signal });
      // Queue positions are cosmetic; the event loop below reports a lost connection.
      if (operation.status === "queued") await refresh().catch(() => {});
    }
  })().catch((error: unknown) => { if (!controller.signal.aborted) { controller.abort(error); } });
  try {
    while (operation.status === "queued" || operation.status === "running") {
      controller.signal.throwIfAborted();
      try {
        const response = await request(baseUrl, token, `/v1/operations/${initial.id}/events?after=${lastSeq}`, { signal: controller.signal });
        if (!response.body) throw new Error("Runner event stream has no body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end).trimEnd();
              buffer = buffer.slice(end + 1);
              if (!line.startsWith("data:")) continue;
              const stored = JSON.parse(line.slice(5).trim()) as StoredEvent;
              if (stored.seq <= lastSeq) continue;
              lastSeq = stored.seq;
              if (stored.event.type === "progress" && env.SLIPJAY_RUNNER_VERBOSE === "1") onLine(stored.event.line);
              if (stored.event.type === "stage") {
                operation = { ...operation, stage: stored.event.stage, status: stored.event.stage === "queued" ? "queued" : "running" };
                show();
              } else if ((TERMINAL_EVENT_TYPES as readonly string[]).includes(stored.event.type)) {
                await refresh();
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof Error && /credential|HTTP/.test(error.message)) throw error;
      }
      if (operation.status === "queued" || operation.status === "running") {
        await delay(250, undefined, { signal: controller.signal });
        await reconnect();
      }
    }
    return operation;
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    await polling;
  }
}

/** How to read retained operation events from any machine with the runner location. */
export const runLogCommand = (operationId: string): string => `slipjay runner log ${operationId}`;

/** This machine's record of which runner accepted each operation it submitted, newest last. */
const operationRunnersPath = (): string => join(stateHome(), "operation-runners.json");
const OPERATION_RUNNERS_KEPT = 500;

async function readOperationRunners(): Promise<Record<string, string>> {
  const text = await readFile(operationRunnersPath(), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (text === null) return {};
  const value: unknown = JSON.parse(text);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
}

/** Remember that `location` accepted `operationId`, so reading it later still asks that runner. Never fails its caller. */
async function rememberOperationRunner(operationId: string, location: string): Promise<void> {
  await withWorkspaceTransaction(`operation-runners:${operationRunnersPath()}`, async () => {
    const runners = await readOperationRunners();
    if (runners[operationId] === location) return;
    delete runners[operationId];
    runners[operationId] = location;
    const kept = Object.entries(runners).slice(-OPERATION_RUNNERS_KEPT);
    mkdirSync(dirname(operationRunnersPath()), { recursive: true });
    await writeWorkspaceJson(operationRunnersPath(), Object.fromEntries(kept));
  }, { waitMs: 1000 }).catch(() => undefined);
}

/**
 * Where to read an operation: the runner that accepted it when this machine submitted it,
 * even after the runner location changed, else the configured runner.
 */
export async function operationRunnerLocation(operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return (await readOperationRunners().catch(() => ({} as Record<string, string>)))[operationId] ?? runnerLocation(env);
}

/** Chunked retrieval verifies bytes against the ledger-backed digest before exposing JSON. */
export async function readRunArtifact(location: string, operationId: string, runId: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const parts: Buffer[] = [];
    let offset = 0, sha256: string | undefined, size: number | undefined;
    for (let page = 0; page < 17; page++) {
      const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/artifacts/${encodeURIComponent(runId)}?offset=${offset}&limit=16384`, { signal: AbortSignal.timeout(15_000) });
      const chunk = await response.json() as import("./runner-contract.ts").ArtifactChunk;
      if (chunk.version !== 1 || chunk.operationId !== operationId || chunk.runId !== runId || chunk.offset !== offset
        || !/^[a-f0-9]{64}$/.test(chunk.sha256) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > 256 * 1024
        || (sha256 !== undefined && (chunk.sha256 !== sha256 || chunk.bytes !== size)) || typeof chunk.dataBase64 !== "string" || chunk.dataBase64.length > 21848)
        throw new Error("Runner returned inconsistent artifact metadata");
      sha256 = chunk.sha256; size = chunk.bytes;
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (bytes.length > 16384 || offset + bytes.length > size) throw new Error("Runner returned an invalid artifact chunk");
      parts.push(bytes); offset += bytes.length;
      if (chunk.nextOffset === null) {
        const all = Buffer.concat(parts);
        if (offset !== size || createHash("sha256").update(all).digest("hex") !== sha256) throw new Error("Artifact bytes do not match retained evidence");
        return JSON.parse(all.toString("utf8")) as unknown;
      }
      if (chunk.nextOffset !== offset || bytes.length === 0) throw new Error("Runner artifact cursor did not advance");
    }
    throw new Error("Runner artifact exceeded the bounded retrieval limit");
  } finally { connection.close(); }
}

/** Read evidence without following, resubmitting, or claiming repair authority. */
export async function readLandingOutcome(location: string, operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<import("./runner-contract.ts").LandingOutcome> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/outcome`);
    if (!response.ok) throw new Error(`Runner outcome unavailable (${response.status}); no submission or repair was attempted`);
    const body = await response.json() as { outcome: import("./runner-contract.ts").LandingOutcome };
    if (body.outcome?.version !== 1 || body.outcome.operationId !== operationId) throw new Error("Runner returned an unsupported or mismatched landing outcome");
    return body.outcome;
  } finally { connection.close(); }
}

async function flushWorkspaceCapability(path: string): Promise<void> {
  for (const target of [path, dirname(path)]) {
    const handle = await open(target, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

type WorkspaceRepair = { operationId: string; repo: string; changeId: string; binding: string; token: string; claimId?: string; confirmedAt?: number };
const workspaceRepairs = (metadata: Record<string, unknown>): Record<string, WorkspaceRepair> => (metadata.repairClaims ?? {}) as Record<string, WorkspaceRepair>;

/** Capability is persisted before the request and never returned in CLI evidence. */
export async function manageRepairClaim(cwd: string, location: string, operationId: string, action: "claim" | "release" | "revoke", env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("Repair claims require an assigned isolated authoring workspace");
  const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Cannot resolve the workspace repository");
  const token = await runnerToken(env), binding = runnerBinding(location);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token }, cwd);
  const key = createHash("sha256").update(JSON.stringify([binding, repo.toLowerCase(), operationId])).digest("hex");
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/outcome`);
    const result = await response.json() as { outcome?: import("./runner-contract.ts").LandingOutcome };
    if (result.outcome?.repo.toLowerCase() !== repo.toLowerCase() || result.outcome.operationId !== operationId) throw new Error("Repair operation does not belong to this workspace repository");
    const changeId = result.outcome.changeId;
    const saved = await withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
      const metadata = await workspaceMetadata(context.current.name);
      if (!metadata) throw new Error("Assigned workspace metadata is missing");
      const claims = { ...workspaceRepairs(metadata) };
      if (action === "claim" && !claims[key]) {
        if (Object.keys(claims).length >= 32) throw new Error("Resolve existing repair claims before creating more");
        claims[key] = { operationId, repo: repo.toLowerCase(), changeId, binding, token: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "") };
        await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, repairClaims: claims });
        await flushWorkspaceCapability(metadataPath(context.current.name));
      }
      return claims[key];
    }, { waitMs: 1000 });
    if (action !== "revoke" && !saved) throw new Error("No locally retained capability for this repair claim");
    const control = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/repair`, {
      method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, by: `${hostname()}:${context.current.name}`, ...(action === "claim" ? { workspace: context.current.name, token: saved!.token }
        : action === "release" ? { claimId: saved!.claimId, token: saved!.token } : {}) }),
    });
    const body = await control.json() as { claim?: { claimId: string; operationId: string; source: string } | null; error?: string };
    if (!control.ok) throw new RunnerRequestRefused(control.status, body.error ?? "Repair claim was refused; keep its local capability until reconciled");
    await withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
      const metadata = await workspaceMetadata(context.current.name);
      if (!metadata) throw new Error("Assigned workspace metadata disappeared; retain this workspace for recovery");
      const claims = { ...workspaceRepairs(metadata) };
      if (action === "claim") {
        if (!body.claim?.claimId || body.claim.operationId !== operationId || claims[key]?.token !== saved?.token) throw new Error("Repair acknowledgement did not match the persisted capability");
        for (const [oldKey, old] of Object.entries(claims)) if (oldKey !== key && old.binding === binding && old.repo === repo.toLowerCase() && old.changeId === changeId) delete claims[oldKey];
        claims[key] = { ...saved!, claimId: body.claim.claimId, confirmedAt: Date.now() };
      } else delete claims[key];
      await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, repairClaims: claims });
        await flushWorkspaceCapability(metadataPath(context.current.name));
    }, { waitMs: 1000 });
    return body;
  } finally { connection.close(); }
}

async function workspaceRepairProof(context: WorkspaceContext, location: string, repo: string, changeId: string): Promise<RepairProof | undefined> {
  const metadata = await workspaceMetadata(context.current.name);
  if (!metadata) return undefined;
  const claim = Object.values(workspaceRepairs(metadata)).filter((entry) => entry.binding === runnerBinding(location)
    && entry.repo === repo.toLowerCase() && entry.changeId === changeId && entry.claimId).sort((a, b) => (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0))[0];
  return claim?.claimId ? { operationId: claim.operationId, claimId: claim.claimId, token: claim.token } : undefined;
}

/** A logical change's public repair claim, and why a fresh claim would be refused now (absent from older runners). */
export async function readRepairState(location: string, operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ claimed: boolean; claim: { claimId: string; operationId: string; workspace: string; source: string } | null; eligibility?: string | null }> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/repair`, { signal: AbortSignal.timeout(15000) });
    const body = await response.json() as { claimed?: boolean; claim?: { claimId: string; operationId: string; workspace: string; source: string } | null; eligibility?: string | null; error?: string };
    if (!response.ok || typeof body.claimed !== "boolean") throw new RunnerRequestRefused(response.status, body.error ?? "Runner did not report the repair state");
    return { claimed: body.claimed, claim: body.claim ?? null, ...("eligibility" in body ? { eligibility: body.eligibility ?? null } : {}) };
  } finally { connection.close(); }
}

/** Stream a derived recovery bundle to a new local file; no source or ownership is changed. */
export async function downloadSubmissionSource(location: string, operationId: string, destination: string, env: NodeJS.ProcessEnv = process.env): Promise<{ operationId: string; source: string; sha256: string; bytes: number; path: string }> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }))
      throw new Error("EEXIST: recovery destination already exists");
    const expected = await (await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/outcome`, { signal: AbortSignal.timeout(15000) })).json() as { outcome?: import("./runner-contract.ts").LandingOutcome };
    const source = expected.outcome?.sourceCommitId;
    if (!source || !/^[a-f0-9]{40}$/.test(source) || expected.outcome?.operationId !== operationId || expected.outcome.sourceRetention?.commitId !== source)
      throw new Error("Operation has no exact retained source acknowledgement");
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/source`, { signal: AbortSignal.timeout(300000) });
    const sha256 = response.headers.get("x-slipjay-sha256") ?? "", size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || response.headers.get("x-slipjay-operation") !== operationId || response.headers.get("x-slipjay-source") !== source
      || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > SOURCE_BUNDLE_MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("Source export metadata is unavailable or inconsistent");
    }
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > size) throw new Error("Source export exceeded its declared size");
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
        }
        if (bytes !== size || hash.digest("hex") !== sha256) throw new Error("Source export does not match its integrity evidence");
        await file.sync();
      } finally { await file.close(); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    await link(temporary, destination);
    return { operationId, source, sha256, bytes, path: destination };
  } finally { try { await rm(temporary, { force: true }); } finally { connection.close(); } }
}

/** Read-only author evidence; never starts a repair or changes operation ownership. */
export async function readLandingHandoff(location: string, operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/handoff`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Retained handoff is unavailable");
    const body = await response.json() as { manifest?: { version?: number; operationId?: string } };
    if (body.manifest?.version !== 1 || body.manifest.operationId !== operationId) throw new Error("Runner returned an unsupported or mismatched handoff");
    return body.manifest;
  } finally { connection.close(); }
}

/** Retained events of one operation, including bounded failure diagnostics. */
export async function readRunLog(location: string, operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/log`);
    return await response.text();
  } finally { connection.close(); }
}

/** One read-only Build action through the runner, which holds the Build credential; throws unless Build answered. */
export async function readBuildThroughRunner(action: BuildReadAction, input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const location = runnerLocation(env);
  if (!location) throw new Error("Reading Build needs a SlipJay runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, "/v1/build/read", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, input }), signal: AbortSignal.timeout(30_000) });
    const body = await response.json() as { value?: unknown; code?: string };
    if (response.status === 409) throw new BuildRefusal(action, body.code ?? "refused");
    return body.value ?? null;
  } finally { connection.close(); }
}

/**
 * The owner's controls: kill a running operation (until it passes verification),
 * or pause and resume the queue. A kill names the operation it means; unnamed, it kills
 * the only one running and refuses when several are. Returns the line to print and
 * whether it took effect.
 */
export async function controlRunner(location: string, action: "kill" | "pause" | "resume", env: NodeJS.ProcessEnv = process.env, operationId?: string): Promise<{ ok: boolean; line: string }> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/runner/${action}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ by: hostname(), ...operationId ? { operation: operationId } : {} }) });
    const body = await response.json() as { operation?: Operation | null; operations?: Operation[]; reason?: string; paused?: boolean };
    const prefix = `[runner ${connection.name}]`;
    if (action !== "kill") return { ok: true, line: `${prefix} ${body.paused ? "paused: queued changes wait until resumed" : "resumed"}` };
    const subjectOf = (operation: Operation) => operation.kind === "landing" ? `landing ${operation.changeId.slice(0, 12)}` : `${operation.kind} ${operation.commitId.slice(0, 12)}`;
    if (body.operations) return { ok: false, line: `${prefix} not killed: ${body.operations.length} operations are running; name one:\n${body.operations.map((operation) => `  slipjay runner kill ${operation.id}  (${subjectOf(operation)}, ${operation.stage})`).join("\n")}` };
    if (!body.operation) return response.status === 409
      ? { ok: false, line: `${prefix} not killed: ${operationId} ${body.reason}` }
      : { ok: true, line: `${prefix} nothing running` };
    const subject = subjectOf(body.operation);
    if (response.status === 409) return { ok: false, line: `${prefix} not killed: ${subject} ${body.reason}` };
    return { ok: true, line: body.operation.stage === "verifying" ? `${prefix} killed ${subject}`
      : `${prefix} killing ${subject}: it stops when ${body.operation.stage} finishes, before verification` };
  } finally { connection.close(); }
}

/**
 * `session` and `tickets` shape the handoff a Build-tracked landing writes itself when none is supplied
 * (see `build-handoff.ts`): the lead's Build session (else `HQ_BUILD_SESSION_ID`) and further Tickets it completes.
 */
type LandOptions = { direct?: boolean; handoff?: SubmissionHandoff; session?: string; tickets?: number[];
  location: string; env?: NodeJS.ProcessEnv; resubmitAfterOutcome?: boolean;
  onLine?(line: string): void; onStage?(stage: string): void; onOperation?(operationId: string): void; signal?: AbortSignal };
type LandResult = { ok: boolean; operation: Operation; logUrl: string; sweep?: SweepResult };

/** A landing that failed before it submitted anything or followed an operation: the runner holds nothing of it. */
export class LandingNotSubmitted extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}

export async function landThroughRunner(cwd: string, options: LandOptions): Promise<LandResult> {
  const progress = { engaged: false };
  try { return await submitAndFollow(cwd, options, progress); }
  catch (error) { throw progress.engaged || error instanceof LandingNotSubmitted ? error : new LandingNotSubmitted(error); }
}

/** `engaged` turns true once the runner may hold this landing: it follows an operation, or sends the submission. */
async function submitAndFollow(cwd: string, options: LandOptions, progress: { engaged: boolean }): Promise<LandResult> {
  const env = options.env ?? process.env;
  const onLine = options.onLine ?? console.log;
  const { context, target: preview } = await landingPreview(cwd, { allowDefaultWorkspace: options.direct });
  const remote = publicationRemote(context);
  if (!remote) throw new Error("Runner landing requires a publication remote");
  const repo = githubRepository(await jj(cwd, ["git", "remote", "list"]), remote);
  if (!repo) throw new Error("Runner landing requires a GitHub repository on the publication remote");
  // An integrated target is never submitted: a rerun after this workspace's change landed
  // can find only integrated history (someone else's commit) under an empty working copy.
  // The fetched remote bookmark counts too: a local bookmark can lag it, and an empty working copy
  // on someone else's landed change must not fall through to that change's landed operation.
  await fetchIntegration(cwd, remote, context.integrationBranch);
  const integrated = `::(${context.integrationBranch} | remote_bookmarks(exact:${JSON.stringify(context.integrationBranch)}, exact:${JSON.stringify(remote)}))`;
  const landedChange = await revisionExists(cwd, `${preview.commitId} & ${integrated}`) ? await ownChangeId(context) : undefined;
  const target = landedChange === undefined ? await landingIO.ensureLandingDescription(cwd, context, preview, (action, input) => readBuildThroughRunner(action, input, env)) : preview;
  const buildTracked = trackerOf(context.configuration) === "build";
  if ((options.session !== undefined || options.tickets?.length) && (options.handoff || !buildTracked))
    throw new Error(options.handoff ? "--session and --ticket shape the handoff land writes; with --handoff, put them in that file" : "--session and --ticket apply only in a Build-tracked repository");
  const prepared = (supplied: SubmissionHandoff) => {
    if (!validSubmissionHandoff(supplied) || supplied.source !== target.commitId) throw new Error("Handoff must contain valid evidence for the exact landing source");
    return prepareSubmissionHandoff(supplied, { ...process.env, ...env });
  };
  let handoff = options.handoff ? prepared(options.handoff) : undefined;
  // Follow a submission where it was made, even if this machine's runner location has changed since.
  const location = await landingRunner(context, target.commitId) ?? options.location;
  if (location !== options.location) onLine(`[runner] following ${target.commitId.slice(0, 12)} on ${location}, where it was submitted`);
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token }, cwd);
  const { baseUrl, name } = connection;
  const operationsFor = async (changeId: string) => (await (await request(baseUrl, token, `/v1/changes/${changeId}?repo=${encodeURIComponent(repo)}`,
    { signal: options.signal })).json() as { operations: Operation[] }).operations;
  try {
    let operation: Operation | undefined;
    let reattached = true;
    let older = false;
    let requestId: string | undefined;
    let priorAttempt: Operation | undefined;
    let awaitingAdmission = false;
    if (landedChange !== undefined) {
      // Only this workspace's own landed change finishes housekeeping here.
      // Operations come newest first.
      operation = landedChange ? (await operationsFor(landedChange)).find((op) => op.status === "landed") : undefined;
      if (!operation) throw new Error(`Nothing to land: ${preview.commitId.slice(0, 12)} is already on ${context.integrationBranch}`);
    } else {
      const existing = await operationsFor(target.changeId);
      priorAttempt = existing[0];
      awaitingAdmission = existing.some((op) => op.kind === "landing" && op.admission === "pending" && !op.result && op.commitId === target.commitId);
      // Reattach to this commit's open operation, or to one that landed while nobody followed it.
      // One still awaiting Build admission is resubmitted instead, which retries that admission.
      operation = existing.find((op) => (op.status === "queued" && !(op.kind === "landing" && op.admission === "pending") || op.status === "running") && op.commitId === target.commitId)
        ?? existing.find((op) => op.status === "landed" && op.commitId === target.commitId);
      // A running older commit already fetched its bookmark state; follow it instead of moving the bookmark under it.
      const running = operation ? undefined : existing.find((op) => op.status === "running");
      older = running !== undefined;
      if (running) operation = running;
      // A caller that must never submit a commit twice reports this commit's last outcome instead.
      if (!operation && options.resubmitAfterOutcome === false && priorAttempt?.result && priorAttempt.commitId === target.commitId) operation = priorAttempt;
    }
    if (operation) progress.engaged = true;
    if (!operation) {
      const repair = await workspaceRepairProof(context, location, repo, target.changeId);
      if (repair || priorAttempt?.kind === "landing" && priorAttempt.outcome) {
        const ownership = await request(baseUrl, token, `/v1/operations/${encodeURIComponent(repair?.operationId ?? priorAttempt!.id)}/repair`);
        if (!ownership.ok) throw new Error("Repair ownership could not be established; source was not submitted");
        const view = await ownership.json() as { claimed?: boolean; claim?: { claimId: string } };
        if (repair ? view.claim?.claimId !== repair.claimId : view.claimed)
          throw new Error("Repair ownership changed or belongs to another claimant; source was not submitted");
      }
      // A Build-tracked landing always tells Build what it is. Written only for a submission, so following
      // an operation already submitted never depends on the session or on Build answering.
      if (!handoff && buildTracked) {
        const issueNumber = (await workspaceMetadata(context.current.name))?.issueNumber;
        handoff = await writtenLandingHandoff(context, landingRequestKey(location, repo, target.commitId), awaitingAdmission, async () => prepared(await buildLandingHandoff({
          source: target.commitId, description: target.description, issueNumber: typeof issueNumber === "number" ? issueNumber : null,
          tickets: options.tickets ?? [], sessionId: options.session ?? env[BUILD_SESSION_ENV], read: (action, input) => readBuildThroughRunner(action, input, env) })));
      }
      requestId = await landingRequestIdentity(context, location, repo, target.commitId);
      const bookmark = candidateBookmark(target.changeId);
      try { await jj(cwd, ["git", "fetch", "--remote", remote, "--branch", bookmark]); }
      catch (error) { if (!/nothing|no matching|does not exist|not found/i.test(String(error))) throw error; }
      await jj(cwd, ["bookmark", "set", bookmark, "-r", target.commitId, "--allow-backwards"]);
      await jj(cwd, ["bookmark", "track", `${bookmark}@${remote}`]).catch(() => {});
      try {
        await jj(cwd, ["git", "push", "--remote", remote, "--bookmark", bookmark]);
      } catch (pushError) {
        try { await jj(cwd, ["git", "push", "--remote", remote, "--named", `${bookmark}=${target.commitId}`]); }
        catch { throw pushError; }
      }
      // Keeping the untracked remote ref would make the candidate immutable, so the next jj
      // command would stack a new working-copy commit on it and a reland would carry both.
      // Forgotten through the colocated integration checkout, which also drops the Git ref:
      // forgotten from a secondary workspace, the next command there would re-import it.
      await jj(context.integration.root, ["--ignore-working-copy", "bookmark", "forget", "--include-remotes", bookmark]);
      // Pinned only once the runner may hold the submission, so a lost response is followed where it went;
      // a known refusal submitted nothing and releases the pin, so a retry goes to the current location.
      await landingRunner(context, target.commitId, location);
      progress.engaged = true;
      let response: Response;
      try {
        response = await request(baseUrl, token, "/v1/operations", { method: "POST", signal: options.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ...repair ? { repair } : {}, ...handoff ? { handoff } : {}, requestId, repo, changeId: target.changeId, commitId: target.commitId, bookmark,
          submittedBy: `${hostname()}:${context.current.name}`, identity: {
            type: "identity", submitterKind: env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID ? "agent" : "unknown",
            submitterId: `${hostname()}:${context.current.name}`, workspace: context.current.name, machine: hostname(),
            ...(env.CODEX_THREAD_ID ? { harness: "codex", sessionId: env.CODEX_THREAD_ID } : env.CLAUDE_SESSION_ID ? { harness: "claude", sessionId: env.CLAUDE_SESSION_ID } : {}),
          } }) });
      } catch (error) {
        if (error instanceof RunnerRequestRefused) {
          await landingRunner(context, target.commitId, null).catch(() => undefined);
          throw new LandingNotSubmitted(error);
        }
        throw new Error(`Landing submission outcome is unknown${requestId ? ` (request ${requestId})` : ""}; run slipjay land again from this workspace to reconcile. Do not assume it failed.`);
      }
      let submitted: { operation: Operation; reattached?: boolean; requestId?: string; code?: string };
      try { submitted = await response.json() as typeof submitted; }
      catch { throw new Error("Landing submission response was unreadable; outcome is unknown. Run slipjay land again from this workspace to reconcile."); }
      // Another landing of this candidate submitted the handoff it wrote first, from Build as it was then: follow that one.
      const submittedFirst = submitted.code === "handoff_differs" && !options.handoff
        ? (await operationsFor(target.changeId)).find((op) => (op.status === "queued" || op.status === "running") && op.commitId === target.commitId) : undefined;
      if (submittedFirst) submitted = { operation: submittedFirst, reattached: true, requestId };
      if (!submitted.operation?.id) throw new Error("Runner refused landing request reconciliation; keep the unresolved request identity and inspect the candidate before retrying.");
      // A 409 with an operation is an older commit of this change, running already.
      const olderRunning = response.status === 409 && !submittedFirst;
      if (requestId && !olderRunning && submitted.requestId !== requestId)
        throw new Error("Runner did not acknowledge the persisted request identity; outcome is unknown. Keep this workspace and reconcile with slipjay land before retrying source.");
      operation = submitted.operation;
      reattached = submitted.reattached === true || response.status === 409;
      older = olderRunning;
    }
    if (!older && requestId) await landingRequestIdentity(context, location, repo, target.commitId, requestId);
    await rememberOperationRunner(operation.id, location);
    await postClientFact(baseUrl, token, operation.id, { kind: "land_follow", reattached });
    options.onOperation?.(operation.id);
    operation = await follow(baseUrl, token, operation, name, onLine, env, options.signal, options.onStage);
    // What follows is this machine's own work (recording the landing, sweeping other workspaces), not the runner's.
    if (operation.result) options.onStage?.("housekeeping");
    // A failure at or after integration leaves publication unresolved: later attempts still follow that runner.
    const unresolved = operation.result?.type === "failed" && (operation.result.stage === "finalizing" || operation.result.stage === "publishing");
    if (operation.result && !unresolved) await landingRunner(context, target.commitId, null).catch(() => undefined);
    // A fetch of every bookmark while the candidate was on the remote imports it untracked,
    // which makes the submitted commit immutable: the author could neither fix a failure
    // nor abandon a landed commit, and the landed rewrite would show as divergent.
    if (operation.result)
      await jj(context.integration.root, ["--ignore-working-copy", "bookmark", "forget", "--include-remotes", candidateBookmark(target.changeId)]).catch(() => {});
    // The forward and its port end with this call, so the log is named by a command, not a URL.
    const logUrl = runLogCommand(operation.id);
    const result = operation.result;
    let sweep: SweepResult | undefined;
    if (older && result?.type === "landed") {
      onLine(`[runner ${name}] followed an older commit (${operation.commitId}); land again to publish your current commit`);
      onLine(logUrl);
      return { ok: false, operation, logUrl };
    }
    if (result?.type === "landed") {
      // Record the landing before anything that snapshots the working copy: a stale one must
      // not leave a published change looking undelivered to cleanup.
      await fetchIntegration(cwd, remote, result.branch, { ignoreWorkingCopy: true });
      const facts = await revisionFacts(cwd, result.commitId, { ignoreWorkingCopy: true });
      let state: Record<string, unknown> = { artifactCommitId: result.commitId };
      if (context.current.name !== "default") {
        await landingIO.writeLandingState(context, facts, { status: "passed", passed: operation.runs.map((run) => run.command), gaps: [], policyDigest: "runner" }, "landed", operation.id);
        state = { ...await readLandingState(context.current.name), runner: { location: location, operationId: operation.id } };
        await writeWorkspaceJson(statePath(context.current.name), state);
      }
      // A concurrent jj command elsewhere in the repository can leave this working copy stale.
      await jj(cwd, ["workspace", "update-stale"]);
      if (target.commitId !== result.commitId && !await revisionExists(cwd, `${target.commitId} & ::${result.branch}`))
        await dropSupersededCandidate(cwd, context.current.root, target, result.commitId, onLine);
      await finishLandedWorkspace(context, state);
      // Release other delivered or idle checkouts; the sweep never fails the landing.
      sweep = await sweepDisposableWorkspaces(context.integration.root, { protectedRoots: [cwd, context.current.root],
        readBuild: (action, input) => readBuildThroughRunner(action, input, env) }).catch(() => undefined);
      for (const removed of sweep?.removed ?? []) onLine(`Removed workspace: ${removed}`);
      // An undelivered checkout kept by its session is the normal case; a delivered one is a leftover.
      for (const skipped of sweep?.skipped ?? []) if (skipped.landed) onLine(`Kept landed workspace ${skipped.name}: ${skipped.reason}`);
      if (context.current.name !== "default") {
        const released = await releaseLandedWorkspace(context).catch((error: unknown) => ({ cleaned: false, reason: String(error) }));
        if (!released.cleaned) onLine(`Kept landed workspace ${context.current.name}: ${released.reason}`);
      }
    } else if (result?.type === "declined") {
      // A Build refusal of admission, or a runner from before migration landings; nothing lands locally now.
      onLine(`[runner ${name}] declined: ${result.reason}\n${result.paths.join("\n")}`);
    } else if (result?.type === "failed") {
      onLine(`[runner ${name}] failed at ${result.stage}: ${result.reason}`);
      if (result.command) onLine(result.command);
      if (result.output !== undefined) onLine(result.output);
      onLine(logUrl);
    } else {
      onLine(`[runner ${name}] ${operation.status}${result?.type === "cancelled" ? `: ${result.reason}` : ""}`);
    }
    if (older) onLine(`[runner ${name}] followed an older commit; land again to submit your current commit`);
    return { ok: !older && result?.type === "landed", operation, logUrl, ...(sweep ? { sweep } : {}) };
  } finally { connection.close(); }
}

async function postClientFact(baseUrl: string, token: string, id: string, fact: ClientFact, eventId: string = randomUUID()): Promise<void> {
  const response = await request(baseUrl, token, `/v1/operations/${encodeURIComponent(id)}/events`, { method: "POST",
    signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ id: eventId, fact }) });
  if (!response.ok) throw new Error(`Runner refused client event (${response.status})`);
  const acknowledgement = await response.json() as { event?: StoredEvent };
  if (acknowledgement.event?.event.type !== "client" || acknowledgement.event.event.id !== eventId)
    throw new Error("Runner returned no acknowledgement for the client event");
}

/** Client-only facts belong to an attributed operation in the runner's ledger. */
export async function recordClientFacts(cwd: string, facts: ClientFact[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const location = runnerLocation(env);
  if (!location) return;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Client event requires a SlipJay checkout");
  const repo = githubRepository(await jj(cwd, ["git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Client event requires a GitHub repository");
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token }, cwd);
  try {
    const response = await request(connection.baseUrl, token, "/v1/client-operations", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, workspace: context.current.name, machine: hostname() }) });
    if (!response.ok) throw new Error(`Runner refused client operation (${response.status})`);
    const { id } = await response.json() as { id: string };
    for (const fact of facts) await postClientFact(connection.baseUrl, token, id, fact);
  } finally { connection.close(); }
}

/**
 * `recordClientFacts` without making the caller wait for the runner: a detached child
 * (`client-facts.ts`, beside this module in source and in the installed bundle) opens
 * the connection and posts the facts, so a slow or unreachable runner never delays a
 * start. Facts are best effort and this never rejects: the child's failure, and a failure
 * to launch it, are one line in the background-work log (a log that cannot be opened is
 * reported on stderr). Nothing runs without a runner location.
 */
export async function recordClientFactsInBackground(cwd: string, facts: ClientFact[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!runnerLocation(env)) return;
  try {
    mkdirSync(stateHome(), { recursive: true, mode: 0o700 });
    const log = openSync(poolRefillLogPath(), "a", 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./client-facts.ts", import.meta.url)), cwd, JSON.stringify(facts)], {
        cwd, env, detached: true, stdio: ["ignore", log, log],
      });
      const failure = await new Promise<Error | null>((settle) => {
        child.once("spawn", () => settle(null));
        child.once("error", (error) => settle(error));
      });
      if (failure) writeSync(log, `${new Date().toISOString()} runner client facts not recorded: ${failure.message}\n`);
      else child.unref();
    } finally { closeSync(log); }
  } catch (error) {
    console.error(`Runner client facts not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readMetricsEvents(location: string, env: NodeJS.ProcessEnv = process.env): Promise<StoredEvent[]> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const events: StoredEvent[] = [];
    let cursor = 0;
    for (;;) {
      const response = await request(connection.baseUrl, token, `/v1/metrics/events?since=${cursor}`);
      if (!response.ok) throw new Error(`Runner metrics failed (${response.status})`);
      const page = await response.json() as { events: StoredEvent[]; nextSeq: number; hasMore: boolean };
      events.push(...page.events);
      if (!page.hasMore) return events;
      if (page.nextSeq <= cursor) throw new Error("Runner metrics cursor did not advance");
      cursor = page.nextSeq;
    }
  } finally { connection.close(); }
}

/** The change this workspace landed or was created for; null when nothing records one. */
async function ownChangeId(context: WorkspaceContext): Promise<string | null> {
  if (context.current.name === "default") return null;
  const state = await readLandingState(context.current.name, { readOnly: true });
  if (state?.phase === "landed" && typeof state.artifactChangeId === "string") return state.artifactChangeId;
  const metadata = await workspaceMetadata(context.current.name);
  return typeof metadata?.implementationChangeId === "string" ? metadata.implementationChangeId : null;
}

/**
 * Abandon the submitted stack the runner rewrote onto the integration branch: the candidate and
 * every unintegrated ancestor, since the runner rebases and lands them together. If that fails and
 * nothing sits on top of it, move the working copy onto the landed commit so cleanup sees no
 * unlanded work; follow-up work stays in the working copy, and cleanup keeps the workspace for it.
 */
async function dropSupersededCandidate(cwd: string, root: string, candidate: RevisionFacts, landedCommitId: string, onLine: (line: string) => void): Promise<void> {
  const stack = `::${candidate.commitId} ~ ::${landedCommitId}`;
  // Abandoning the stack moves the working copy onto the candidate's old base; work on top
  // of the candidate belongs on what landed, which carries the candidate's content.
  const onTop = await revisionExists(cwd, `${candidate.commitId} & ::@`);
  try {
    await jj(cwd, ["abandon", stack]);
    if (onTop) await jj(cwd, ["rebase", "-b", "@", "-d", landedCommitId]).catch((error: unknown) =>
      onLine(`Could not move the working copy onto ${landedCommitId}, which landed: ${String(error).trim()}`));
  } catch (error) {
    onLine(`Could not abandon the submitted stack ending at ${candidate.commitId}, which landed as ${landedCommitId}: ${String(error).trim()}`);
    onLine(`Abandon it with \`jj abandon '${stack}'\` in ${root} once the cause is fixed, or it shows as divergent.`);
    if (await revisionExists(cwd, `${candidate.commitId} & ::@`) && !await revisionExists(cwd, `(${candidate.commitId}..@) & ~empty()`))
      await jj(cwd, ["new", landedCommitId]);
  }
}

/**
 * Submit an approved release candidate to the runner, or reattach to its open
 * release, and follow it to its verdict.
 */
export async function releaseThroughRunner(cwd: string, options: { candidate: string; remote: string; migrationsReady: boolean; location: string;
  env?: NodeJS.ProcessEnv; onLine?(line: string): void; signal?: AbortSignal }): Promise<{ operation: Operation; deploy?: DeployOperation; logUrl: string }> {
  const env = options.env ?? process.env;
  const onLine = options.onLine ?? console.log;
  const repo = githubRepository(await jj(cwd, ["git", "remote", "list"]), options.remote);
  if (!repo) throw new Error("Runner releases require a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, "/v1/releases", { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, candidate: options.candidate,
        migrationsReady: options.migrationsReady, submittedBy: `${hostname()}:${cwd}` }) });
    const { operation: submitted, reattached } = (await response.json()) as { operation: ReleaseOperation; reattached: boolean };
    await rememberOperationRunner(submitted.id, options.location);
    if (reattached) onLine(`[runner ${connection.name}] following the open release of ${options.candidate.slice(0, 12)}`);
    const operation = await follow(connection.baseUrl, token, submitted, connection.name, onLine, env, options.signal);
    // A promotion ends with its production deploy, which runs in the deploy lane.
    if (operation.result?.type !== "released" || !operation.result.deploy) return { operation, logUrl: runLogCommand(operation.id) };
    const route = `/v1/operations/${encodeURIComponent(operation.result.deploy)}`;
    const { operation: queued } = (await (await request(connection.baseUrl, token, route, { signal: options.signal })).json()) as { operation: DeployOperation };
    onLine(`[runner ${connection.name}] deploying ${options.candidate.slice(0, 12)} to production`);
    const deploy = await follow(connection.baseUrl, token, queued, connection.name, onLine, env, options.signal) as DeployOperation;
    return { operation, deploy, logUrl: runLogCommand(operation.id) };
  } finally { connection.close(); }
}

/** For a promotion plan: the newest commit staging deployed, and the candidates already submitted for release, newest first. */
export async function readPromotionState(cwd: string, options: { location: string; env?: NodeJS.ProcessEnv }): Promise<PromotionState> {
  const env = options.env ?? process.env;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Runner promotions require a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const read = async <T>(route: string, query: Record<string, string>): Promise<T[]> =>
      ((await (await request(connection.baseUrl, token, `${route}?${new URLSearchParams({ repo, ...query })}`)).json()) as { operations: T[] }).operations;
    const staging = await read<DeployOperation>("/v1/deploys", { environment: "staging" });
    const releases = await read<ReleaseOperation>("/v1/releases", {});
    return {
      stagingGreen: staging.find((operation) => operation.result?.type === "deployed")?.commitId ?? null,
      approved: releases.filter((operation) => operation.status !== "cancelled" && operation.status !== "superseded").map((operation) => operation.commitId),
    };
  } finally { connection.close(); }
}

/** The repository and integration branch of `cwd`, with the branch's commit on the remote freshly fetched. */
async function integrationTip(cwd: string): Promise<{ repo: string; branch: string; commitId: string }> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  const remote = publicationRemote(context) ?? "origin";
  const repo = githubRepository(await jj(cwd, ["git", "remote", "list"]), remote);
  if (!repo) throw new Error("Runner deploys require a GitHub repository on the publication remote");
  const branch = context.integrationBranch;
  const fetched = await fetchIntegration(cwd, remote, branch, { ignoreWorkingCopy: true });
  if (fetched.code !== 0) throw new Error(`Could not fetch ${branch}: ${(fetched.stderr || fetched.stdout).trim()}`);
  const commitId = await jj(cwd, ["--ignore-working-copy", "log", "-r", `${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
  return { repo, branch, commitId };
}

/**
 * Deploy the integration branch's latest commit on the remote to `environment` now,
 * or follow the open deploy of that commit, to its verdict.
 */
export async function deployThroughRunner(cwd: string, options: { environment: string; location: string;
  env?: NodeJS.ProcessEnv; onLine?(line: string): void; signal?: AbortSignal }): Promise<{ operation: Operation; logUrl: string }> {
  const env = options.env ?? process.env;
  const onLine = options.onLine ?? console.log;
  const { repo, branch, commitId } = await integrationTip(cwd);
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, "/v1/deploys", { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, environment: options.environment, commitId,
        submittedBy: `${hostname()}:${cwd}` }) });
    const { operation: submitted, reattached } = (await response.json()) as { operation: DeployOperation; reattached: boolean };
    await rememberOperationRunner(submitted.id, options.location);
    onLine(`[runner ${connection.name}] ${reattached ? "following the open deploy" : "deploying"} of ${branch} ${commitId.slice(0, 12)} to ${options.environment}`);
    const operation = await follow(connection.baseUrl, token, submitted, connection.name, onLine, env, options.signal);
    return { operation, logUrl: runLogCommand(operation.id) };
  } finally { connection.close(); }
}

/** The repository's deploy records, newest first, optionally of one environment. */
export async function readDeploys(cwd: string, options: { environment?: string; location: string; env?: NodeJS.ProcessEnv }): Promise<DeployOperation[]> {
  const env = options.env ?? process.env;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Runner deploys require a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const query = new URLSearchParams({ repo, ...options.environment ? { environment: options.environment } : {} });
    return ((await (await request(connection.baseUrl, token, `/v1/deploys?${query}`)).json()) as { operations: DeployOperation[] }).operations;
  } finally { connection.close(); }
}

/** Reset the repository's declared target now, or follow its open reset, to its verdict. */
export async function resetThroughRunner(cwd: string, options: { location: string; env?: NodeJS.ProcessEnv; onLine?(line: string): void; signal?: AbortSignal }): Promise<{ operation: Operation; logUrl: string }> {
  const env = options.env ?? process.env;
  const onLine = options.onLine ?? console.log;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Runner resets require a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, "/v1/resets", { method: "POST", signal: options.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, submittedBy: `${hostname()}:${cwd}` }) });
    const { operation: submitted, reattached } = (await response.json()) as ResetResponse;
    await rememberOperationRunner(submitted.id, options.location);
    onLine(`[runner ${connection.name}] ${reattached ? "following the open reset" : "resetting"} of ${repo}`);
    const operation = await follow(connection.baseUrl, token, submitted, connection.name, onLine, env, options.signal);
    return { operation, logUrl: runLogCommand(operation.id) };
  } finally { connection.close(); }
}

/** Owns a fresh authenticated transport for each watch reconnect, including SSH forwards. */
export async function watchThroughRunner(
  location: string,
  emit: (envelope: import("./runner-watch.ts").WatchEnvelope) => void,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { watchRunner } = await import("./runner-watch.ts");
  let token: string | undefined;
  let missingToken = false;
  await watchRunner({
    signal,
    emit,
    retry: (abort) => delay(missingToken ? 30_000 : 2000, undefined, { signal: abort }),
    async connect() {
      if (!token) {
        missingToken = true;
        token = await runnerToken(env);
        missingToken = false;
      }
      signal.throwIfAborted();
      const credential = token;
      const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: credential });
      return {
        close: connection.close,
        snapshot: async (abort) =>
          (await request(connection.baseUrl, credential, "/v1/queue", { signal: AbortSignal.any([abort, AbortSignal.timeout(15_000)]) })).json() as Promise<import("./runner-contract.ts").QueueSnapshot>,
        async stream(cursor, abort) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try { return await request(connection.baseUrl, credential, `/v1/metrics/events?since=${cursor}`, {
            signal: AbortSignal.any([abort, controller.signal]), headers: { accept: "text/event-stream" },
          }); } finally { clearTimeout(timer); }
        },
      };
    },
  });
}

export async function cancelThroughRunner(
  location: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; result: unknown }> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(
      connection.baseUrl,
      token,
      `/v1/operations/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ by: hostname() }),
      },
    );
    return { ok: response.ok, result: await response.json() };
  } finally {
    connection.close();
  }
}
