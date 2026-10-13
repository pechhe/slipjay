import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createRunnerHandler } from "./runner-api.ts";
import { RUNNER_DEFAULT_PORT, RUNNER_TOKEN_ENV } from "./runner-contract.ts";
import type { RunnerConfig, StoredEvent } from "./runner-contract.ts";
import { serveRunner } from "./runner-http.ts";
import { openOperationLog } from "./runner-log.ts";
import { createRunnerQueue, localExecutor } from "./runner-queue.ts";

/** The runner's state directory: config, operation log, run logs and warm checkouts. */
export const runnerHome = (): string => join(homedir(), ".slipjay", "runner");

/**
 * Start the runner: recover what a previous process held, then serve the API on
 * loopback and process the queue. The token comes from the environment (the
 * systemd unit runs this under `bws run`).
 */
export async function startRunner(options: { home?: string; env?: NodeJS.ProcessEnv; port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const home = options.home ?? runnerHome();
  const env = options.env ?? process.env;
  const token = env[RUNNER_TOKEN_ENV];
  if (!token) throw new Error(`${RUNNER_TOKEN_ENV} is not set; run the runner under \`bws run\``);
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as RunnerConfig;
  mkdirSync(home, { recursive: true });
  const log = openOperationLog(join(home, "operations.sqlite"));
  const listeners = new Set<(event: StoredEvent) => void>();
  const queue = createRunnerQueue({
    log, home, config, executor: localExecutor(config.name ?? hostname()),
    publish: (event) => { for (const listener of listeners) listener(event); },
    environment: () => env,
  });
  await queue.recover();
  const server = await serveRunner(createRunnerHandler({
    log, token, runnerName: config.name ?? hostname(), readLog: queue.readLog, onSubmitted: queue.wake,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  }), { host: config.listen?.host ?? "127.0.0.1", port: options.port ?? config.listen?.port ?? RUNNER_DEFAULT_PORT });
  // Queued operations from before a restart resume here.
  queue.wake();
  return { url: server.url, close: async () => { await server.close(); await queue.idle(); log.close(); } };
}
