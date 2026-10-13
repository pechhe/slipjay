import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { integrateLandingCandidate } from "./landing-candidate.ts";
import { completeLanding, fetchIntegration, landingIO } from "./landing-steps.ts";
import { confirmRelease } from "./release.ts";
import { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
import { KILLABLE_STAGES, OWNER_KILL_REASON, repositoryKey } from "./runner-contract.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { Executor, LandingOperation, Operation, OperationEvent, OperationLog, RunnerConfig, RunnerStage, ReleaseOperation, StoredEvent } from "./runner-contract.ts";

const configuredRepository = (config: RunnerConfig, repo: string) =>
  Object.entries(config.repos).find(([name]) => repositoryKey(name) === repositoryKey(repo))?.[1];
import { jj, revisionExists, revisionFacts, workspaceContext } from "./workspace-jj.ts";

/**
 * An integration the runner could not finalize or publish. It stays on the runner's
 * integration branch, because the external target may already reflect it, and every
 * later turn retries it first; nothing else lands until it is published.
 */
class HeldIntegration extends Error {
  constructor(readonly commitId: string, readonly stage: "finalizing" | "publishing", reason: string, readonly output?: string) {
    super(`${reason}\nThe runner holds ${commitId.slice(0, 12)}, integrated but not published, and retries it before the next landing.`);
  }
}

/** The owner's kill reached the operation; it ends cancelled, never passed. */
class OwnerKill extends Error {
  constructor() { super(OWNER_KILL_REASON); }
}

/**
 * Runs commands on this host. Each run's process group is killed on abort or
 * timeout, but a gate's own tools may start further groups (setsid) that a group
 * signal never reaches. Under a systemd user manager each run therefore gets its
 * own transient scope, and stopping the scope kills everything left in it, on
 * abort and after every run. Elsewhere only the run's process group is killed.
 */
export function localExecutor(host = hostname(), env: NodeJS.ProcessEnv = process.env): Executor {
  const runtimeDir = process.platform === "linux" ? env.XDG_RUNTIME_DIR : undefined;
  if (!runtimeDir) return { host, run: runBoundedProcess };
  const kill = (unit: string) => new Promise<void>((resolve) =>
    execFile("systemctl", ["--user", "kill", "--signal=SIGKILL", unit], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } }, () => resolve()));
  return {
    host,
    async run(request) {
      const unit = `slipjay-run-${randomUUID()}.scope`;
      const stop = () => { void kill(unit); };
      request.abortSignal?.addEventListener("abort", stop, { once: true });
      try {
        return await runBoundedProcess({
          ...request, executable: "systemd-run",
          args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", request.executable, ...request.args],
          env: { ...request.env ?? sanitizedProcessEnv(), XDG_RUNTIME_DIR: runtimeDir },
        });
      } finally {
        request.abortSignal?.removeEventListener("abort", stop);
        await kill(unit);
      }
    },
  };
}

/**
 * One serial loop owns every repository's warm checkout and every transition of its
 * integration and release branches: landings and releases take turns in arrival order.
 */
export function createRunnerQueue(input: {
  log: OperationLog; executor: Executor; home: string; config: RunnerConfig;
  publish(event: StoredEvent): void;
  environment?: () => NodeJS.ProcessEnv;
}): {
  wake(): void; recover(): Promise<void>; idle(): Promise<void>;
  /** Delete the remote candidate of a landing cancelled while queued, after the running turn. */
  cancelled(operation: Operation): void;
  /** Kill the running operation if it has not passed verification: `null` when idle. */
  kill(): { operation: Operation; killed: boolean } | null;
  logPath(operationId: string): string; readLog(operationId: string): Promise<string | null>;
} {
  const { log, executor, home, config, publish, environment } = input;
  let active: Promise<void> | undefined;
  let current: { operation: Operation; stage: RunnerStage; controller: AbortController } | undefined;
  const logPath = (id: string) => join(home, "logs", `${id}.log`);
  function append(id: string, event: OperationEvent): void {
    const stored = log.append(id, event);
    publish(stored);
    mkdirSync(dirname(logPath(id)), { recursive: true });
    appendFileSync(logPath(id), `${JSON.stringify(stored)}\n`);
  }
  const checkoutPath = (operation: Operation) => join(home, "repos", operation.repo);
  /** The published integration of an earlier submission of this exact commit, if any. */
  async function publishedIntegration(checkout: string, operation: LandingOperation, branch: string, remote: string): Promise<{ base: string; commitId: string } | null> {
    for (const earlier of log.operationsForChange(operation.repo, operation.changeId)) {
      if (earlier.id === operation.id || earlier.commitId !== operation.commitId) continue;
      const integrated = log.events({ operationId: earlier.id }).map((stored) => stored.event).findLast((event) => event.type === "integrated");
      if (integrated && await revisionExists(checkout, `${integrated.commitId} & ::${branch}@${remote}`))
        return { base: integrated.base, commitId: integrated.commitId };
    }
    return null;
  }
  async function cleanup(operation: LandingOperation, checkout: string, remote: string): Promise<void> {
    try {
      // A candidate this checkout never fetched (cancelled while queued, or interrupted by a
      // restart) has no local bookmark to delete until it is fetched.
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", operation.bookmark]).catch(() => {});
      await jj(checkout, ["bookmark", "track", `${operation.bookmark}@${remote}`]).catch(() => {});
      await jj(checkout, ["bookmark", "delete", operation.bookmark]);
      await jj(checkout, ["git", "push", "--remote", remote, "--bookmark", operation.bookmark]);
    } catch (error) {
      // Leave no half-deleted bookmark behind: a resubmission fetches the candidate afresh.
      await jj(checkout, ["bookmark", "forget", "--include-remotes", operation.bookmark]).catch(() => {});
      append(operation.id, { type: "progress", line: `Candidate bookmark cleanup failed: ${message(error)}` });
    }
  }
  async function processOperation(operation: Operation): Promise<void> {
    let stage: RunnerStage = "queued";
    const controller = new AbortController();
    current = { operation, stage, controller };
    let verdict: OperationEvent | undefined;
    const checkout = checkoutPath(operation);
    let remote: string | undefined;
    const progress = (line: string) => append(operation.id, { type: "progress", line });
    // Gate and migration commands both go through the executor, so each run records where it ran.
    async function run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
      const runId = randomUUID();
      const started = Date.now();
      append(operation.id, { type: "run_started", runId, command: [request.executable, ...request.args].join(" "), host: executor.host });
      const abortSignal = request.abortSignal ? AbortSignal.any([request.abortSignal, controller.signal]) : controller.signal;
      const result = await executor.run({ ...request, abortSignal }).catch((error: unknown) => {
        append(operation.id, { type: "run_finished", runId, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - started });
        throw error;
      });
      append(operation.id, { type: "run_finished", runId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: Date.now() - started });
      return result;
    }
    // Finalization, then publication, of an integrated commit (completeLanding).
    async function finishIntegration(context: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>, commitId: string): Promise<void> {
      setStage("finalizing");
      const tail = await completeLanding(checkout, context, commitId, { ...(environment ? { environment } : {}), onPublishing: () => setStage("publishing") });
      if (!tail.postIntegration.ok)
        throw new HeldIntegration(commitId, "finalizing", `Post-integration ${tail.postIntegration.status}: ${tail.postIntegration.reason ?? "no reason recorded"}`, tail.postIntegration.output);
      if (!tail.publication.ok) throw new HeldIntegration(commitId, "publishing", tail.publication.reason ?? "Integration publication failed");
    }
    const setStage = (next: RunnerStage) => {
      // A kill that landed between runs stops the operation before it moves a branch.
      if (controller.signal.aborted) throw new OwnerKill();
      stage = next;
      current = { operation, stage, controller };
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
      await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", branch, ...operation.kind === "landing" ? ["--branch", operation.bookmark] : []]);
      // A commit integrated by an earlier turn but never published (a failed push, or
      // a restart after finalization) may already be applied to the external target.
      // Finish it before anything moves the bookmark: dropping it would orphan that state.
      if (await jj(checkout, ["log", "-r", `${branch} ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"])) {
        const held = (await revisionFacts(checkout, branch)).commitId;
        progress(`Finishing ${held.slice(0, 12)}, integrated by an earlier landing but not yet published`);
        await finishIntegration(context, held);
        setStage("fetching");
      }
      await jj(checkout, ["bookmark", "set", branch, "-r", `${branch}@${remote}`, "--allow-backwards"]);
      // Read the freshly fetched integration policy, rather than an earlier warm tip.
      context = await workspaceContext(checkout);
      if (!context) throw new Error("Runner checkout context is unavailable");
      // A release's post-release step runs against the integration branch just reset to the remote.
      if (operation.kind === "release") {
        await release(operation);
        return;
      }
      // A reland of a submission whose integration has since been published (by the
      // step above, or before a restart) is already landed: never integrate it twice.
      const published = await publishedIntegration(checkout, operation, branch, remote);
      if (published) {
        verdict = { type: "landed", ...published, branch, remote };
        return;
      }
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
        runCommand: run,
        adapter: {
          verify: () => runRequiredVerification({
            root: checkout, checks: candidateContext.configuration.requiredLandingVerification,
            environment, onProgress: progress, run,
          }),
        },
      }, {
        ...landingIO,
        landingPreview: async () => ({ context: candidateContext, target: await revisionFacts(checkout, operation.commitId) }),
        ensureLandingDescription: async (_cwd, _context, target) => target,
        async prepareCandidateDependencies(cwd, candidate, target, onProgress) {
          setStage("installing");
          await landingIO.prepareCandidateDependencies(cwd, candidate, target, onProgress);
        },
      });
      const { base, artifact } = integrated;
      append(operation.id, { type: "integrated", base, commitId: artifact.commitId });
      await finishIntegration(candidateContext, artifact.commitId);
      verdict = { type: "landed", base, commitId: artifact.commitId, branch, remote };
    } catch (error) {
      // A failed reset after a publication failure must not append a second verdict.
      if (log.operation(operation.id)?.result) progress(message(error));
      else if (controller.signal.aborted) verdict = { type: "cancelled", reason: OWNER_KILL_REASON };
      else if (error instanceof HeldIntegration) verdict = { type: "failed", stage: error.stage, reason: error.message, ...(error.output ? { output: error.output } : {}) };
      else if (error instanceof RequiredVerificationError) verdict = {
        type: "failed", stage: "verifying", reason: error.message,
        command: error.evidence.command, output: error.evidence.stdoutTail + error.evidence.stderrTail,
      };
      else verdict = { type: "failed", stage, reason: message(error) };
    } finally {
      current = undefined;
      // Delete the candidate bookmark before the verdict: an author's repository that fetches
      // every bookmark after that would otherwise import it and pin the submitted commit.
      if (remote && operation.kind === "landing") await cleanup(operation, checkout, remote);
      if (verdict) append(operation.id, verdict);
    }
    async function release(operation: ReleaseOperation): Promise<void> {
      const result = await confirmRelease(checkout, { candidate: operation.commitId, migrationsReady: operation.migrationsReady,
        onProgress: progress, onStage: setStage, run, ...(environment ? { environment } : {}) });
      if (controller.signal.aborted) throw new OwnerKill();
      if (result.status === "released" || result.status === "released_by") append(operation.id, { type: "released", result });
      else if (result.status === "verification_failed") append(operation.id, {
        type: "failed", stage: "verifying", reason: result.reason,
        command: result.evidence.command, output: result.evidence.stdoutTail + result.evidence.stderrTail,
      });
      else if (!result.ok && result.status === "refused") append(operation.id, { type: "failed", stage, reason: result.reason });
      else throw new Error(`Unexpected release result ${result.status}`);
    }
  }
  async function loop(): Promise<void> {
    for (;;) {
      if (log.paused()) return;
      const operation = log.openOperations().find((entry) => entry.status === "queued");
      if (!operation) return;
      await processOperation(operation);
    }
  }
  async function recoverRunning(): Promise<void> {
    for (const operation of log.openOperations().filter((entry) => entry.status === "running")) {
      const checkout = checkoutPath(operation);
      let remote: string | undefined;
      if (operation.kind === "release") {
        // A release that published reports itself on a rerun confirm, which also retries its post-release step.
        append(operation.id, { type: "failed", stage: operation.stage,
          reason: `runner restarted during ${operation.stage}; rerun slipjay release --confirm ${operation.commitId.slice(0, 12)}` });
        continue;
      }
      let verdict: OperationEvent = { type: "failed", stage: operation.stage, reason: `runner restarted during ${operation.stage}; land again` };
      try {
        let integrated = log.events({ operationId: operation.id }).map((stored) => stored.event).findLast((event) => event.type === "integrated");
        if (configuredRepository(config, operation.repo)) {
          const context = await workspaceContext(checkout);
          if (context) remote = context.configuration.remote ?? "origin";
          // Stopped after integrating but before recording it: record the held commit,
          // so a reland recognises it once the next turn publishes it.
          if (!integrated && context && remote) {
            const branch = context.integrationBranch;
            const held = await jj(checkout, ["log", "-r", `${branch} & change_id(${operation.changeId}) ~ ::${branch}@${remote}`, "--no-graph", "-T", "commit_id"]);
            // Another operation's integration of the same change (an earlier submission) is not this one's.
            const claimed = log.operationsForChange(operation.repo, operation.changeId).some((other) =>
              log.events({ operationId: other.id }).some((stored) => stored.event.type === "integrated" && stored.event.commitId === held));
            if (held && !claimed) {
              const [base = ""] = (await jj(checkout, ["log", "-r", `${held}-`, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n");
              integrated = { type: "integrated", base, commitId: held };
              append(operation.id, integrated);
            }
          }
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
      if (remote) await cleanup(operation, checkout, remote);
      append(operation.id, verdict);
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
    cancelled(operation) {
      if (operation.kind !== "landing") return;
      void start(async () => {
        const checkout = checkoutPath(operation);
        const context = await workspaceContext(checkout).catch(() => null);
        if (context) await cleanup(operation, checkout, context.configuration.remote ?? "origin");
        // A submission that woke the queue while this cleanup held it waits for this pass.
        await loop();
      }, active);
    },
    async idle() { while (active) await active; },
    kill() {
      if (!current) return null;
      const operation = log.operation(current.operation.id) ?? current.operation;
      if (!KILLABLE_STAGES.includes(current.stage)) return { operation, killed: false };
      current.controller.abort();
      return { operation, killed: true };
    },
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
