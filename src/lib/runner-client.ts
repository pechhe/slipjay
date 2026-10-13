import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess } from "./bounded-process.ts";
import { finishLanding } from "./landing-candidate.ts";
import { fetchIntegration, landingIO, landingPreview, publicationRemote } from "./landing-steps.ts";
import { githubRepository } from "./post-land-issue.ts";
import { candidateBookmark, RUNNER_DEFAULT_PORT } from "./runner-contract.ts";
import type { Operation, StoredEvent } from "./runner-contract.ts";
import { jj, revisionExists, revisionFacts } from "./workspace-jj.ts";
import { releaseLandedWorkspace } from "./workspace-landing.ts";
import { readLandingState, statePath } from "./workspace-state.ts";
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

async function follow(baseUrl: string, token: string, initial: Operation, name: string, onLine: (line: string) => void,
  env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Operation> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let operation = initial;
  let lastSeq = initial.lastSeq;
  let lastLine = "";
  const show = () => {
    const line = `[runner ${name}] ${operation.stage}${operation.status === "queued" && operation.position !== undefined ? ` (position ${operation.position})` : ""}`;
    if (line !== lastLine) { lastLine = line; onLine(line); }
  };
  const refresh = async () => {
    operation = (await (await request(baseUrl, token, `/v1/operations/${initial.id}`, { signal: controller.signal })).json() as { operation: Operation }).operation;
    show();
  };
  show();
  const polling = (async () => {
    while (!controller.signal.aborted) {
      await delay(3000, undefined, { signal: controller.signal });
      if (operation.status === "queued") await refresh();
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
              } else if (["landed", "failed", "declined", "superseded", "cancelled"].includes(stored.event.type)) {
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
        await refresh();
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

export async function landThroughRunner(cwd: string, options: { direct?: boolean; location: string; env?: NodeJS.ProcessEnv;
  onLine?(line: string): void; signal?: AbortSignal; fallback(): Promise<unknown> }): Promise<{ ok: boolean; operation: Operation; logUrl: string; fallback?: unknown }> {
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
      await jj(cwd, ["bookmark", "forget", bookmark]);
      const response = await request(baseUrl, token, "/v1/operations", { method: "POST", signal: options.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, changeId: target.changeId, commitId: target.commitId, bookmark,
          submittedBy: `${hostname()}:${context.current.name}` }) });
      operation = ((await response.json()) as { operation: Operation }).operation;
      older = response.status === 409;
    }
    operation = await follow(baseUrl, token, operation, name, onLine, env, options.signal);
    // The forward and its port end with this call, so the log is named by a command, not a URL.
    const logUrl = runLogCommand(operation.id);
    const result = operation.result;
    if (older && result?.type === "landed") {
      onLine(`[runner ${name}] followed an older commit (${operation.commitId}); land again to publish your current commit`);
      onLine(logUrl);
      return { ok: false, operation, logUrl };
    }
    if (result?.type === "landed") {
      await fetchIntegration(cwd, remote, result.branch);
      if (target.commitId !== result.commitId && !await revisionExists(cwd, `${target.commitId} & ::${result.branch}`))
        await jj(cwd, ["abandon", target.commitId]);
      const facts = await revisionFacts(cwd, result.commitId);
      let state: Record<string, unknown> = { artifactCommitId: result.commitId };
      if (context.current.name !== "default") {
        await landingIO.writeLandingState(context, facts, { status: "passed", passed: operation.runs.map((run) => run.command), gaps: [], policyDigest: "runner" }, "landed", false, operation.id);
        state = { ...await readLandingState(context.current.name), runner: { location: options.location, operationId: operation.id } };
        await writeWorkspaceJson(statePath(context.current.name), state);
      }
      await finishLanding(context, state, {}, landingIO);
      if (context.current.name !== "default") {
        const released = await releaseLandedWorkspace(context).catch((error: unknown) => ({ cleaned: false, reason: String(error) }));
        if (!released.cleaned) onLine(`Kept landed workspace ${context.current.name}: ${released.reason}`);
      }
    } else if (result?.type === "declined") {
      onLine(`[runner ${name}] declined: ${result.reason}\n${result.paths.join("\n")}`);
      const fallback = await options.fallback();
      return { ok: typeof fallback === "object" && fallback !== null && "ok" in fallback && fallback.ok === true, operation, logUrl, fallback };
    } else if (result?.type === "failed") {
      onLine(`[runner ${name}] failed at ${result.stage}: ${result.reason}`);
      if (result.command) onLine(result.command);
      if (result.output !== undefined) onLine(result.output);
      onLine(logUrl);
    } else {
      onLine(`[runner ${name}] ${operation.status}${result?.type === "cancelled" ? `: ${result.reason}` : ""}`);
    }
    if (older) onLine(`[runner ${name}] followed an older commit; land again to submit your current commit`);
    return { ok: !older && result?.type === "landed", operation, logUrl };
  } finally { connection.close(); }
}
