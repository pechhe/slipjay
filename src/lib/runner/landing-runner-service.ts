import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { submissionSourceResponse } from "../landing/submission-source-export.ts";
import { readSubmissionManifest, retainSubmissionSource } from "../landing/submission-source.ts";
import { submissionProbe } from "../landing/submission-probe.ts";
import { readCommandArtifact } from "./command-artifact.ts";
import { createRunnerHandler } from "./runner-api.ts";
import { BUILD_TOKEN_ENV, buildAdmitter, buildReader, buildRoute } from "../build/build-admission.ts";
import { createBuildCheckAccess } from "../build/build-check-access.ts";
import { createReceiptDrain, deliveryState } from "../build/build-receipts.ts";
import { landingOutcome } from "../landing/landing-outcome.ts";
import { RUNNER_DEFAULT_PORT, RUNNER_TOKEN_ENV } from "./runner-env.ts";
import { RUNNER_JJ_DEFAULTS } from "./runner-contract.ts";
import type { Executor, RunnerConfig } from "./runner-types.ts";
import { serveRunner } from "./runner-http.ts";
import { openOperationLog } from "./runner-log.ts";
import { classifyEvent } from "./failure-classification.ts";
import { createRunnerQueue, runnerLogOptions } from "./runner-queue.ts";

const PROBE_BUDGET_MS = 30_000;

/**
 * Lightweight landing-only HTTP runner for workspace/landing/policy/build tests:
 * runs the real queue, API and Build admission without wiring release, deploy,
 * batch-check, reset, audit or remote-verifier subsystems into their import graph.
 */
export async function startLandingRunner(options: { home: string; env: NodeJS.ProcessEnv; port?: number; executor: Executor }): Promise<{ url: string; recovered: Promise<void>; close(): Promise<void> }> {
  const { home, env, executor } = options;
  const token = env[RUNNER_TOKEN_ENV];
  if (!token) throw new Error(`${RUNNER_TOKEN_ENV} is not set`);
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as RunnerConfig;
  mkdirSync(home, { recursive: true });
  const log = openOperationLog(join(home, "operations.sqlite"), runnerLogOptions(config, executor),
    { classify: classifyEvent, landingOutcome, deliveryState });
  const buildToken = env[BUILD_TOKEN_ENV]?.trim();
  const build = config.build && buildToken ? buildRoute({ origin: config.build.origin, token: buildToken }) : undefined;
  const buildChecks = build ? createBuildCheckAccess() : undefined;
  const queue = createRunnerQueue({
    log, home, config, executor,
    environment: () => env,
    ...build ? { readBuild: buildReader(build), buildChecks } : {},
  });
  const receipts = build ? createReceiptDrain({ log, route: build, onAdmissionSettled: queue.wake }) : undefined;
  const configuredUrl = (name: string) => {
    const repository = Object.entries(config.repos).find(([repo]) => repo.toLowerCase() === name.toLowerCase())?.[1];
    if (!repository) throw new Error("Repository is not configured on this runner");
    return repository.url;
  };
  const server = await serveRunner(createRunnerHandler({
    log, token, runnerName: config.name ?? hostname(), readLog: queue.readLog, onSubmitted: queue.wake, kill: queue.kill, onCancelled: queue.cancelled, prioritize: queue.prioritize, recoverHeld: queue.recoverHeld, releaseHeld: queue.releaseHeld,
    subscribe: log.subscribe,
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
  const recovered = queue.recover().then(() => { queue.wake(); receipts?.wake(); });
  return {
    url: server.url,
    recovered,
    close: async () => {
      await recovered;
      await server.close();
      receipts?.close();
      await receipts?.idle();
      queue.close();
      await queue.idle();
      log.close();
    },
  };
}
