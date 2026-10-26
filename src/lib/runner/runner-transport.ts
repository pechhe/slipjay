import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess } from "../infra/bounded-process.ts";
import { RUNNER_DEFAULT_PORT } from "./runner-env.ts";
import type { Operation } from "./runner-types.ts";

export type RunnerConnection = { baseUrl: string; name: string; close(): void };

/** The caller owns durable evidence; these awaited hooks must handle their recording failures. */
export type RunnerConnectionLifecycle = {
  forwardFailure?(error: unknown): Promise<void>;
  connected?(connection: RunnerConnection, token: string): Promise<void>;
};

/** The token read from Bitwarden, once per process: one command can reach the runner many times. */
let savedToken: Promise<string> | undefined;

export async function runnerToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SLIPJAY_RUNNER_TOKEN) return env.SLIPJAY_RUNNER_TOKEN;
  // A failed lookup is not kept, so a later call (a watcher's retry) asks Bitwarden again.
  savedToken ??= bitwardenRunnerToken(env).catch((error: unknown) => { savedToken = undefined; throw error; });
  return savedToken;
}

const MISSING_TOKEN = "Set SLIPJAY_RUNNER_TOKEN or save the Bitwarden key SLIPJAY_RUNNER_TOKEN";
/** A lookup that fails is tried this many times, a quarter second apart, each bounded by `timeoutMs`. */
const TOKEN_LOOKUP_ATTEMPTS = 3;

/** Escapes raw control characters inside JSON strings, which `bws` prints unescaped for an unrelated secret's value. */
function escapeControlCharacters(json: string): string {
  let inString = false, escaped = false, out = "";
  for (const char of json) {
    if (inString && char < " ") out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    else out += char;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = inString;
    else if (char === '"') inString = !inString;
  }
  return out;
}

/** One `bws` lookup: the token, null when the key is absent, or why the lookup failed (never any output). */
async function lookupBitwardenToken(env: NodeJS.ProcessEnv): Promise<string | null | { failure: string }> {
  const result = await runBoundedProcess({ executable: "bws", args: ["secret", "list"], cwd: process.cwd(), env,
    timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.timedOut) return { failure: "bws timed out" };
  if (result.error) return { failure: "bws could not be started" };
  if (result.exitCode !== 0) return { failure: "bws exited non-zero" };
  try {
    const entries = JSON.parse(escapeControlCharacters(result.stdout)) as { key: string; value: string }[];
    return entries.find((entry) => entry.key === "SLIPJAY_RUNNER_TOKEN")?.value || null;
  } catch { return { failure: "bws returned unparsable output" }; }
}

async function bitwardenRunnerToken(env: NodeJS.ProcessEnv): Promise<string> {
  let failure = "";
  for (let attempt = 1; attempt <= TOKEN_LOOKUP_ATTEMPTS; attempt++) {
    const found = await lookupBitwardenToken(env);
    if (typeof found === "string") return found;
    if (found === null) throw new Error(MISSING_TOKEN);
    failure = found.failure;
    if (attempt < TOKEN_LOOKUP_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The cause only; the lookup's output may hold secrets.
  throw new Error(`Could not read SLIPJAY_RUNNER_TOKEN from Bitwarden after ${TOKEN_LOOKUP_ATTEMPTS} attempts (${failure}). ${MISSING_TOKEN}`);
}

/** An explicit runner refusal; deferred admission may name an already retained operation. */
export class RunnerRequestRefused extends Error {
  readonly status: number;
  readonly operation?: Operation;
  constructor(status: number, message: string, operation?: Operation) { super(message); this.status = status; this.operation = operation; }
}

export async function request(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init, headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new RunnerRequestRefused(401, "runner refused the credential; check SLIPJAY_RUNNER_TOKEN");
  if (response.ok || response.status === 409) return response;
  // A refusal (400) names why in its body, such as a reset of a repository that never landed on the runner;
  // so does a landing that would conflict with what lands before it (422), and a known retryable one (503),
  // such as Build admission that did not complete.
  const body = [400, 422, 503].includes(response.status) ? await response.json().catch(() => null) as { error?: unknown; operation?: Operation } | null : null;
  const refusal = body?.error;
  if (response.status === 400) throw new RunnerRequestRefused(400, `Runner request refused: HTTP 400: ${typeof refusal === "string" ? refusal : "invalid request"}`);
  if (response.status === 422 && typeof refusal === "string") throw new RunnerRequestRefused(422, refusal);
  if (response.status === 503 && typeof refusal === "string") throw new RunnerRequestRefused(503, `Runner request refused: HTTP 503: ${refusal}`, body?.operation);
  throw new Error(`Runner request failed: HTTP ${response.status}`);
}

export async function connectRunner(location: string, env: NodeJS.ProcessEnv = process.env, lifecycle: RunnerConnectionLifecycle = {}): Promise<RunnerConnection> {
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
    } catch (error) { close(); await lifecycle.forwardFailure?.(error); throw error; }
    baseUrl = `http://127.0.0.1:${port}`;
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Runner location must use http://, https:// or ssh://");
  }
  try {
    const health = await (await request(baseUrl, token, "/v1/health", { signal: AbortSignal.timeout(15_000) })).json() as { runner: string };
    const connection = { baseUrl, name: health.runner, close };
    await lifecycle.connected?.(connection, token);
    return connection;
  } catch (error) { close(); throw error; }
}

