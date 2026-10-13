import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess } from "./bounded-process.ts";
import { finishLanding } from "./landing-candidate.ts";
import { fetchIntegration, landingIO, landingPreview, publicationRemote } from "./landing-steps.ts";
import { githubRepository } from "./issue-references.ts";
import { candidateBookmark, RUNNER_DEFAULT_PORT, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { Operation, ReleaseOperation, StoredEvent } from "./runner-contract.ts";
import { jj, revisionExists, revisionFacts } from "./workspace-jj.ts";
import { releaseLandedWorkspace } from "./workspace-lifecycle.ts";
import { readLandingState, statePath } from "./workspace-state.ts";
import { sweepDisposableWorkspaces } from "./workspace-sweep.ts";
import type { SweepResult } from "./workspace-sweep.ts";
import { writeWorkspaceJson } from "./workspace-transaction.ts";

export function runnerLocation(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SLIPJAY_RUNNER) return env.SLIPJAY_RUNNER;
  return readRunnerConfiguration();
}

function readRunnerConfiguration(): string | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".slipjay/config.json"), "utf8"));
    return typeof config.runner === "string" && config.runner ? config.runner : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function runnerToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SLIPJAY_RUNNER_TOKEN) return env.SLIPJAY_RUNNER_TOKEN;
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

async function request(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new Error("runner refused the credential; check SLIPJAY_RUNNER_TOKEN");
  if (!response.ok && response.status !== 409) throw new Error(`Runner request failed: HTTP ${response.status}`);
  return response;
}

export async function connectRunner(location: string, env: NodeJS.ProcessEnv = process.env): Promise<{ baseUrl: string; name: string; close(): void }> {
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
    } catch (error) { close(); throw error; }
    baseUrl = `http://127.0.0.1:${port}`;
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Runner location must use http://, https:// or ssh://");
  }
  try {
    const health = await (await request(baseUrl, token, "/v1/health", { signal: AbortSignal.timeout(15_000) })).json() as { runner: string };
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

/** How to read an operation's full run log from any machine with the runner location. */
export const runLogCommand = (operationId: string): string => `slipjay runner log ${operationId}`;

/** The full run log of one operation. */
export async function readRunLog(location: string, operationId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/operations/${encodeURIComponent(operationId)}/log`);
    return await response.text();
  } finally { connection.close(); }
}

/**
 * The owner's controls: kill the running operation (until it passes verification),
 * or pause and resume the queue. Returns the line to print and whether it took effect.
 */
export async function controlRunner(location: string, action: "kill" | "pause" | "resume", env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; line: string }> {
  const token = await runnerToken(env);
  const connection = await connectRunner(location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  try {
    const response = await request(connection.baseUrl, token, `/v1/runner/${action}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ by: hostname() }) });
    const body = await response.json() as { operation?: Operation | null; reason?: string; paused?: boolean };
    const prefix = `[runner ${connection.name}]`;
    if (action !== "kill") return { ok: true, line: `${prefix} ${body.paused ? "paused: queued changes wait until resumed" : "resumed"}` };
    if (!body.operation) return { ok: true, line: `${prefix} nothing running` };
    const subject = body.operation.kind === "release" ? `release ${body.operation.commitId.slice(0, 12)}` : `landing ${body.operation.changeId.slice(0, 12)}`;
    if (response.status === 409) return { ok: false, line: `${prefix} not killed: ${subject} ${body.reason}` };
    return { ok: true, line: body.operation.stage === "verifying" ? `${prefix} killed ${subject}`
      : `${prefix} killing ${subject}: it stops when ${body.operation.stage} finishes, before verification` };
  } finally { connection.close(); }
}

export async function landThroughRunner(cwd: string, options: { direct?: boolean; location: string; env?: NodeJS.ProcessEnv;
  onLine?(line: string): void; onStage?(stage: string): void; signal?: AbortSignal }): Promise<{ ok: boolean; operation: Operation; logUrl: string; sweep?: SweepResult }> {
  const env = options.env ?? process.env;
  const onLine = options.onLine ?? console.log;
  const { context, target: preview } = await landingPreview(cwd, { allowDefaultWorkspace: options.direct });
  const target = await landingIO.ensureLandingDescription(cwd, context, preview);
  const remote = publicationRemote(context);
  if (!remote) throw new Error("Runner landing requires a publication remote");
  const repo = githubRepository(await jj(cwd, ["git", "remote", "list"]), remote);
  if (!repo) throw new Error("Runner landing requires a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  const { baseUrl, name } = connection;
  try {
    const existing = await (await request(baseUrl, token, `/v1/changes/${target.changeId}?repo=${encodeURIComponent(repo)}`, { signal: options.signal })).json() as { operations: Operation[] };
    // Reattach to this commit's open operation, or to one that landed while nobody followed it.
    let operation = existing.operations.find((op) => (op.status === "queued" || op.status === "running") && op.commitId === target.commitId)
      ?? existing.operations.find((op) => op.status === "landed" && op.commitId === target.commitId);
    // A running older commit already fetched its bookmark state; follow it instead of moving the bookmark under it.
    const running = operation ? undefined : existing.operations.find((op) => op.status === "running");
    let older = running !== undefined;
    if (running) operation = running;
    if (!operation) {
      const bookmark = candidateBookmark(target.changeId);
      try { await jj(cwd, ["git", "fetch", "--remote", remote, "--branch", bookmark]); }
      catch (error) { if (!/nothing|no matching|does not exist|not found/i.test(String(error))) throw error; }
      await jj(cwd, ["bookmark", "set", bookmark, "-r", target.commitId, "--allow-backwards"]);
      await jj(cwd, ["bookmark", "track", `${bookmark}@${remote}`]).catch(() => {});
      try {
        await jj(cwd, ["git", "push", "--remote", remote, "--bookmark", bookmark]);
      } catch {
        await jj(cwd, ["git", "push", "--remote", remote, "--named", `${bookmark}=${target.commitId}`]);
      }
      // Keeping the untracked remote ref would make the candidate immutable, so the next jj
      // command would stack a new working-copy commit on it and a reland would carry both.
      await jj(cwd, ["bookmark", "forget", "--include-remotes", bookmark]);
      const response = await request(baseUrl, token, "/v1/operations", { method: "POST", signal: options.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, changeId: target.changeId, commitId: target.commitId, bookmark,
          submittedBy: `${hostname()}:${context.current.name}` }) });
      operation = ((await response.json()) as { operation: Operation }).operation;
      older = response.status === 409;
    }
    operation = await follow(baseUrl, token, operation, name, onLine, env, options.signal, options.onStage);
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
        state = { ...await readLandingState(context.current.name), runner: { location: options.location, operationId: operation.id } };
        await writeWorkspaceJson(statePath(context.current.name), state);
      }
      if (target.commitId !== result.commitId && !await revisionExists(cwd, `${target.commitId} & ::${result.branch}`)) {
        try { await jj(cwd, ["abandon", target.commitId]); }
        catch (error) {
          onLine(`Could not abandon the submitted commit ${target.commitId}, which landed as ${result.commitId}: ${String(error).trim()}`);
          onLine(`Run \`jj workspace update-stale\` and \`jj abandon ${target.commitId}\` in ${context.current.root}.`);
        }
      }
      await finishLanding(context, state, landingIO);
      // Release other delivered or idle checkouts; the sweep never fails the landing.
      sweep = await sweepDisposableWorkspaces(context.integration.root, { protectedRoots: [cwd, context.current.root] }).catch(() => undefined);
      for (const removed of sweep?.removed ?? []) onLine(`Removed workspace: ${removed}`);
      // An undelivered checkout kept by its session is the normal case; a delivered one is a leftover.
      for (const skipped of sweep?.skipped ?? []) if (skipped.landed) onLine(`Kept landed workspace ${skipped.name}: ${skipped.reason}`);
      if (context.current.name !== "default") {
        const released = await releaseLandedWorkspace(context).catch((error: unknown) => ({ cleaned: false, reason: String(error) }));
        if (!released.cleaned) onLine(`Kept landed workspace ${context.current.name}: ${released.reason}`);
      }
    } else if (result?.type === "declined") {
      // Only runners from before migration landings declined; nothing lands locally now.
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

/**
 * Submit an approved release candidate to the runner, or reattach to its open
 * release, and follow it to its verdict.
 */
export async function releaseThroughRunner(cwd: string, options: { candidate: string; remote: string; migrationsReady: boolean; location: string;
  env?: NodeJS.ProcessEnv; onLine?(line: string): void; signal?: AbortSignal }): Promise<{ operation: Operation; logUrl: string }> {
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
    if (reattached) onLine(`[runner ${connection.name}] following the open release of ${options.candidate.slice(0, 12)}`);
    const operation = await follow(connection.baseUrl, token, submitted, connection.name, onLine, env, options.signal);
    return { operation, logUrl: runLogCommand(operation.id) };
  } finally { connection.close(); }
}
