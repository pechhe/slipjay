import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { runBoundedProcess } from "./bounded-process.ts";
import { integrateLandingCandidate } from "./landing-candidate.ts";
import { fetchIntegration, landingIO, publishIntegration } from "./landing-steps.ts";
import { migrationPaths } from "./migration-candidate.ts";
import { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
import { repositoryKey } from "./runner-contract.ts";
import type { Executor, Operation, OperationEvent, OperationLog, RunnerConfig, RunnerStage, StoredEvent } from "./runner-contract.ts";

const configuredRepository = (config: RunnerConfig, repo: string) =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1];
import { jj, revisionExists, revisionFacts, workspaceContext } from "./workspace-jj.ts";

const DECLINED_REASON = "Changes migration trigger paths; land it through the local path until the runner generates migrations (pechhe/slipjay#11)";

class MigrationDeclined extends Error {
  constructor(readonly paths: string[]) { super(DECLINED_REASON); }
}

export function localExecutor(host = hostname()): Executor {
  return { host, run: runBoundedProcess };
}

/** One serial loop owns every repository's warm checkout and landing transition. */
export function createRunnerQueue(input: {
  log: OperationLog; executor: Executor; home: string; config: RunnerConfig;
  publish(event: StoredEvent): void;
  environment?: () => NodeJS.ProcessEnv;
}): {
  wake(): void; recover(): Promise<void>; idle(): Promise<void>;
  logPath(operationId: string): string; readLog(operationId: string): Promise<string | null>;
} {
  const { log, executor, home, config, publish, environment } = input;
  let active: Promise<void> | undefined;
  const logPath = (id: string) => join(home, "logs", `${id}.log`);
  function append(id: string, event: OperationEvent): void {
    const stored = log.append(id, event);
    publish(stored);
    mkdirSync(dirname(logPath(id)), { recursive: true });
    appendFileSync(logPath(id), `${JSON.stringify(stored)}\n`);
  }
  const checkoutPath = (operation: Operation) => join(home, "repos", operation.repo);
  async function cleanup(operation: Operation, checkout: string, remote: string): Promise<void> {
    try {
      await jj(checkout, ["bookmark", "delete", operation.bookmark]);
      await jj(checkout, ["git", "push", "--remote", remote, "--bookmark", operation.bookmark]);
    } catch (error) {
      append(operation.id, { type: "progress", line: `Candidate bookmark cleanup failed: ${message(error)}` });
    }
  }
  async function processOperation(operation: Operation): Promise<void> {
    let stage: RunnerStage = "queued";
    const checkout = checkoutPath(operation);
    let remote: string | undefined;
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    const setStage = (next: RunnerStage) => {
      stage = next;
      append(operation.id, { type: "stage", stage });
    };
    try {
      const repository = configuredRepository(config, operation.repo);
      if (!repository) throw new Error(`Repository ${operation.repo} is not configured on this runner`);
      setStage("fetching");
      if (!await stat(checkout).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) {
        await mkdir(dirname(checkout), { recursive: true });
        await jj(dirname(checkout), ["git", "clone", repository.url, checkout]);
      }
      let context = await workspaceContext(checkout);
      if (!context || context.current.name !== "default") throw new Error("Runner checkout must be the default jj workspace");
      remote = context.configuration.remote ?? "origin";
      const branch = context.integrationBranch;
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch, "--branch", operation.bookmark]);
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      // Read the freshly fetched integration policy, rather than an earlier warm tip.
      context = await workspaceContext(checkout);
      if (!context) throw new Error("Runner checkout context is unavailable");
      await jj(checkout, ["bookmark", "track", `${operation.bookmark}@${remote}`]);
      await jj(checkout, ["abandon", "-r", `mutable() ~ ::${operation.bookmark}`]);
      const commits = await jj(checkout, ["log", "-r", operation.bookmark, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (commits !== operation.commitId) throw new Error(`Candidate bookmark ${operation.bookmark} does not resolve to submitted commit ${operation.commitId}`);
      const visible = await jj(checkout, ["log", "-r", `change_id(${operation.changeId})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
      if (visible.split("\n").filter(Boolean).length !== 1 || visible !== operation.commitId)
        throw new Error(`Submitted change ${operation.changeId} must have exactly one visible commit matching ${operation.commitId}`);
      await jj(checkout, ["edit", operation.commitId]);
      const candidateContext = context;
      const integrated = await integrateLandingCandidate(checkout, {
        environment, onProgress: progress,
        onStage: (next) => { if (next !== "cleaning") setStage(next); },
        adapter: {
          async finalizeCandidate(candidate, base) {
            const paths = (await migrationPaths(checkout, candidateContext.configuration.migrationFinalization, base.commitId, candidate.commitId, jj)).owned;
            if (paths.length) throw new MigrationDeclined(paths);
            return candidate;
          },
          verify: () => runRequiredVerification({
            root: checkout, checks: candidateContext.configuration.requiredLocalVerification,
            slot: false, environment, onProgress: progress,
            async run(request) {
              const runId = randomUUID();
              const started = Date.now();
              append(operation.id, { type: "run_started", runId, command: [request.executable, ...request.args].join(" "), host: executor.host });
              const result = await executor.run(request).catch((error: unknown) => {
                append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started });
                throw error;
              });
              append(operation.id, { type: "run_finished", runId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: Date.now() - started });
              return result;
            },
          }),
        },
      }, {
        ...landingIO,
        landingPreview: async () => ({ context: candidateContext, target: await revisionFacts(checkout, operation.commitId) }),
        ensureLandingDescription: async (_cwd, _context, target) => target,
        assertNoForeignPrimaryWriter: async () => {},
        async prepareCandidateDependencies(cwd, candidate, target, onProgress) {
          setStage("installing");
          await landingIO.prepareCandidateDependencies(cwd, candidate, target, onProgress);
        },
      });
      const { base, artifact } = integrated;
      append(operation.id, { type: "integrated", base, commitId: artifact.commitId });
      setStage("publishing");
      const publication = await publishIntegration(checkout, remote, branch, artifact.commitId);
      if (publication.ok) append(operation.id, { type: "landed", base, commitId: artifact.commitId, branch, remote });
      else {
        append(operation.id, { type: "failed", stage, reason: publication.reason ?? "Integration publication failed" });
        await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      }
    } catch (error) {
      // A failed reset after a publication failure must not append a second verdict.
      if (log.operation(operation.id)?.result) progress(message(error));
      else if (error instanceof MigrationDeclined) append(operation.id, { type: "declined", reason: DECLINED_REASON, paths: error.paths });
      else if (error instanceof RequiredVerificationError) append(operation.id, {
        type: "failed", stage: "verifying", reason: error.message,
        command: error.evidence.command, output: error.evidence.stdoutTail + error.evidence.stderrTail,
      });
      else append(operation.id, { type: "failed", stage, reason: message(error) });
    } finally {
      if (remote) await cleanup(operation, checkout, remote);
    }
  }
  async function loop(): Promise<void> {
    for (;;) {
      const operation = log.openOperations().find((entry) => entry.status === "queued");
      if (!operation) return;
      await processOperation(operation);
    }
  }
  async function recoverRunning(): Promise<void> {
    for (const operation of log.openOperations().filter((entry) => entry.status === "running")) {
      const checkout = checkoutPath(operation);
      let remote: string | undefined;
      let verdict: OperationEvent = { type: "failed", stage: operation.stage, reason: `runner restarted during ${operation.stage}; land again` };
      try {
        const integrated = log.events({ operationId: operation.id }).map((stored) => stored.event).findLast((event) => event.type === "integrated");
        if (configuredRepository(config, operation.repo)) {
          const context = await workspaceContext(checkout);
          if (context) remote = context.configuration.remote ?? "origin";
          if (integrated) {
            if (!context || !remote) throw new Error("Runner checkout context is unavailable");
            const branch = context.integrationBranch;
            const fetched = await fetchIntegration(checkout, remote, branch);
            if (fetched.code !== 0) throw new Error(fetched.stderr || fetched.stdout);
            if (await revisionExists(checkout, `${integrated.commitId} & ::${branch}@${remote}`)) {
              verdict = { type: "landed", base: integrated.base, commitId: integrated.commitId, branch, remote };
            }
          }
        }
      } catch (error) {
        append(operation.id, { type: "progress", line: `Recovery could not confirm publication: ${message(error)}` });
      }
      append(operation.id, verdict);
      if (remote) await cleanup(operation, checkout, remote);
    }
  }
  function start(work: () => Promise<void>, previous?: Promise<void>): Promise<void> {
    const pending = (previous ?? Promise.resolve()).then(work).finally(() => {
      if (active === pending) active = undefined;
    });
    active = pending;
    return pending;
  }
  return {
    wake() {
      if (!active) start(loop);
    },
    async recover() {
      await start(recoverRunning, active);
    },
    async idle() { while (active) await active; },
    logPath,
    async readLog(id) {
      try { return await readFile(logPath(id), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
