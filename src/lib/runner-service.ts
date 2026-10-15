import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { retainSubmissionSource } from "./submission-source.ts";
import { createRunnerHandler } from "./runner-api.ts";
import { RUNNER_DEFAULT_PORT, RUNNER_TOKEN_ENV, repositoryLane, runnerConfigProblem } from "./runner-contract.ts";
import type { RunnerConfig } from "./runner-contract.ts";
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
  const problem = runnerConfigProblem(config);
  if (problem) throw new Error(`${problem}; rerun scripts/setup-runner.sh or add it to ${join(home, "config.json")}`);
  mkdirSync(home, { recursive: true });
  const log = openOperationLog(join(home, "operations.sqlite"), { ...config.workers === undefined ? {} : { workers: config.workers }, lane: (repo) => repositoryLane(config, repo) });
  const executor = localExecutor(config.name ?? hostname(), env, config.limits);
  const queue = createRunnerQueue({
    log, home, config, executor,
    environment: () => env,
  });
  await queue.recover();
  const server = await serveRunner(createRunnerHandler({
    log, token, runnerName: config.name ?? hostname(), readLog: queue.readLog, onSubmitted: queue.wake, kill: queue.kill, onCancelled: queue.cancelled,
    subscribe: log.subscribe,
    async retainSubmission(operationId, request) {
      const repository = Object.entries(config.repos).find(([repo]) => repo.toLowerCase() === request.repo.toLowerCase())?.[1];
      if (!repository) throw new Error("Repository is not configured on this runner");
      return retainSubmissionSource({ home, operationId, request, url: repository.url, executor, env, gitExecutable: config.jj?.["git.executable-path"] });
    },
  }), { host: config.listen?.host ?? "127.0.0.1", port: options.port ?? config.listen?.port ?? RUNNER_DEFAULT_PORT });
  // Queued operations from before a restart resume here.
  queue.wake();
  return { url: server.url, close: async () => { await server.close(); queue.close(); await queue.idle(); log.close(); } };
}
