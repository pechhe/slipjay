import { submissionSourceResponse } from "../landing/submission-source-export.ts";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { readSubmissionManifest, retainSubmissionSource } from "../landing/submission-source.ts";
import { submissionProbe } from "../landing/submission-probe.ts";
import { readCommandArtifact } from "./command-artifact.ts";
import { pruneRetainedEvidence } from "./evidence-retention.ts";
import { createRunnerHandler } from "./runner-api.ts";
import { BUILD_TOKEN_ENV, buildAdmitter, buildReader, buildRoute } from "../build/build-admission.ts";
import { createBuildCheckAccess } from "../build/build-check-access.ts";
import { createPipelineRelay, localPipelineReader } from "../build/build-pipeline-relay.ts";
import { createReceiptDrain, deliveryState } from "../build/build-receipts.ts";
import { landingOutcome } from "../landing/landing-outcome.ts";
import { RUNNER_DEFAULT_PORT, RUNNER_TOKEN_ENV } from "./runner-env.ts";
import { RUNNER_JJ_DEFAULTS, runnerConfigProblem } from "./runner-contract.ts";
import type { Executor, RunnerConfig } from "./runner-types.ts";
import { serveRunner } from "./runner-http.ts";
import { openOperationLog } from "./runner-log.ts";
import { classifyEvent } from "./failure-classification.ts";
import { projectWatchOperation } from "./runner-watch-projection.ts";
import { shortRepositories } from "./pipeline-metrics.ts";
import { localExecutor } from "./local-executor.ts";
import { createRunnerQueue, runnerLogOptions } from "./runner-queue.ts";

/** How long a submission's conflict probe may hold admission before the submission queues unchecked. */
const PROBE_BUDGET_MS = 30_000;

/** The runner's state directory: config, operation log, run logs and warm checkouts. */
export const runnerHome = (): string => join(homedir(), ".slipjay", "runner");

/**
 * Start the runner: recover what a previous process held, then serve the API on
 * loopback and process the queue. The token comes from the environment (the
 * systemd unit runs this under `bws run`).
 */
export async function startRunner(options: { home?: string; env?: NodeJS.ProcessEnv; port?: number; executor?: Executor } = {}): Promise<{ url: string; close(): Promise<void>; drain(): Promise<void> }> {
  const home = options.home ?? runnerHome();
  const env = options.env ?? process.env;
  const token = env[RUNNER_TOKEN_ENV];
  if (!token) throw new Error(`${RUNNER_TOKEN_ENV} is not set; run the runner under \`bws run\``);
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as RunnerConfig;
  const problem = runnerConfigProblem(config);
  if (problem) throw new Error(`${problem}; rerun scripts/setup-runner.sh or add it to ${join(home, "config.json")}`);
  mkdirSync(home, { recursive: true });
  // Tests whose subject is not containment run commands directly (tests/support/executor.ts).
  const executor = options.executor ?? localExecutor({ host: config.name ?? hostname(), env, ...config.limits ? { limits: config.limits } : {}, home });
  // The ledger records; these are the interpretations the runner reports from it, composed here.
  const log = openOperationLog(join(home, "operations.sqlite"), runnerLogOptions(config, executor),
    { classify: classifyEvent, landingOutcome, watch: projectWatchOperation, deliveryState, shortRepositories });
  const buildToken = env[BUILD_TOKEN_ENV]?.trim();
  const build = config.build && buildToken ? buildRoute({ origin: config.build.origin, token: buildToken }) : undefined;
  // Landing checks read Build through this runner, each operation with its own short-lived token.
  const buildChecks = build ? createBuildCheckAccess() : undefined;
  const queue = createRunnerQueue({
    log, home, config, executor,
    environment: () => env,
    ...build ? { readBuild: buildReader(build), buildChecks } : {},
  });
  await queue.recover();
  // Receipts go from the ledger to Build on their own schedule: publication never waits on HQ.
  // Admissions Build never answered are settled there too, and each answer may let queued work start.
  const receipts = build ? createReceiptDrain({ log, route: build, onAdmissionSettled: queue.wake }) : undefined;
  const configuredUrl = (name: string) => {
    const repository = Object.entries(config.repos).find(([repo]) => repo.toLowerCase() === name.toLowerCase())?.[1];
    if (!repository) throw new Error("Repository is not configured on this runner");
    return repository.url;
  };
  const server = await serveRunner(createRunnerHandler({
    log, token, runnerName: config.name ?? hostname(), readLog: queue.readLog, onSubmitted: queue.wake, kill: queue.kill, onCancelled: queue.cancelled, recoverHeld: queue.recoverHeld,
    subscribe: log.subscribe,
    // Without both, Build-bound submissions are refused, never queued unadmitted.
    ...build ? { admitBuild: buildAdmitter(build), onAdmissionUnresolved: () => receipts?.wake(), readBuild: build, buildChecks } : {},
    async readSource(operation, signal) {
      const retained = log.events({ operationId: operation.id }).find((row) => row.event.type === "source_retained")?.event;
      if (retained?.type !== "source_retained") throw new Error("No retained submission");
      return submissionSourceResponse({ home, repo: operation.repo, operationId: operation.id, retained, executor, env, signal,
        gitExecutable: config.jj?.["git.executable-path"] });
    },
    async readManifest(operation) {
      const retained = log.events({ operationId: operation.id }).find((row) => row.event.type === "source_retained")?.event;
      if (retained?.type !== "source_retained") throw new Error("No retained submission");
      return readSubmissionManifest(home, operation.repo, operation.id, retained);
    },
    readArtifact: (operationId, runId, reference, offset, limit) => readCommandArtifact(home, operationId, runId, reference, offset, limit),
    probeSubmission: submissionProbe({ home, url: configuredUrl, jjConfig: { ...RUNNER_JJ_DEFAULTS, ...config.jj }, budgetMs: PROBE_BUDGET_MS,
      onSkipped: (repo, reason) => console.error(`[probe] ${repo}: submission queued without a conflict check: ${reason}`) }),
    async retainSubmission(operationId, request) {
      return retainSubmissionSource({ home, operationId, request, url: configuredUrl(request.repo), executor, env, gitExecutable: config.jj?.["git.executable-path"] });
    },
  }), { host: config.listen?.host ?? "127.0.0.1", port: options.port ?? config.listen?.port ?? RUNNER_DEFAULT_PORT });
  buildChecks?.serve(server.url);
  // The metrics export goes to HQ shortly after each new event and on its own timer, reading this runner's API like any
  // client; it shares nothing with the receipt drain.
  const relay = config.build && buildToken
    ? createPipelineRelay({ origin: config.build.origin, token: buildToken, readPage: localPipelineReader({ baseUrl: server.url, token }), subscribe: log.subscribe }) : undefined;
  relay?.start();
  // Queued operations from before a restart resume here.
  queue.wake();
  receipts?.wake();
  // Retained evidence is bounded: expire it at start and every six hours. One pass at a time.
  let pruning: Promise<unknown> = Promise.resolve();
  const prune = () => { pruning = pruning.then(() => pruneRetainedEvidence({ home, log, executor, env, gitExecutable: config.jj?.["git.executable-path"] })).catch(() => {}); };
  prune();
  const retention = setInterval(prune, 6 * 60 * 60 * 1000);
  retention.unref();
  return { url: server.url, drain: queue.drain, close: async () => { clearInterval(retention); await pruning; relay?.close(); await relay?.idle(); await server.close(); receipts?.close(); await receipts?.idle(); queue.close(); await queue.idle(); log.close(); } };
}
