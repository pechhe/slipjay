import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "vite-plus/test";
import { retainCommandArtifact } from "../src/lib/command-artifact.ts";
import { expiredEvidence, pruneRetainedEvidence } from "../src/lib/evidence-retention.ts";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { localExecutor } from "../src/lib/runner-queue.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import { retainSubmissionSource, submissionStorePath } from "../src/lib/submission-source.ts";
import type { OperationLog } from "../src/lib/runner-contract.ts";
import { jj, project } from "./support/workspace-project.ts";

const DAY = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(Date.now() + days * DAY);

/** A failed landing whose source, manifest and one command artifact the runner retained. */
async function failedAttempt(log: OperationLog, operationId: string, f: Awaited<ReturnType<typeof project>> & { home: string }) {
  await writeFile(join(f.repo, `${operationId}.txt`), "retained\n");
  jj(f.repo, ["describe", "-m", operationId]);
  const commitId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const changeId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
  const bookmark = candidateBookmark(changeId);
  execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", "--force", f.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });
  const request = { repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "fixture", requestId: randomUUID() };
  log.append(operationId, { type: "submitted", ...request });
  log.append(operationId, await retainSubmissionSource({ home: f.home, operationId, request, url: f.remote, executor: localExecutor() }));
  const artifact = await retainCommandArtifact({ home: f.home, operationId, runId: "run", request: { executable: "bun", args: ["test"], cwd: f.home, timeoutMs: 1000, maxOutputBytes: 1000 },
    result: { stdout: "1 failed", stderr: "", stdoutTruncated: false, stderrTruncated: false, finishedAt: new Date().toISOString(), exitCode: 1, signal: null, timedOut: false, cancelled: false, outputSha256: "x" } });
  log.append(operationId, { type: "run_started", runId: "run", command: "bun test", host: "fixture", timeoutMs: 1000, purpose: "gate" });
  log.append(operationId, { type: "run_finished", runId: "run", exitCode: 1, signal: null, timedOut: false, durationMs: 1, artifact });
  log.append(operationId, { type: "failed", stage: "verifying", reason: "gate failed" });
  log.append(operationId, { type: "classified", ruleVersion: 1, cause: "gate", failingTests: [], diagnostics: [] });
  return { changeId, commitId, bookmark };
}
const refs = (home: string) => execFileSync("git", ["--git-dir", submissionStorePath(home, "owner/repo"), "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim();
const files = (dir: string) => readdir(dir).catch(() => [] as string[]);

test("retained evidence expires on its documented schedule, leaves ledger records, and readers say it expired", async () => {
  const base = await project();
  const f = { ...base, home: join(base.root, "runner") };
  await mkdir(f.home);
  const log = openOperationLog(join(f.home, "operations.sqlite"));
  try {
    const failed = await failedAttempt(log, "op_failed", f);
    assert.deepEqual(expiredEvidence(log, later(29)), [], "an unadopted failure keeps its evidence for 30 days");
    // An active repair claim keeps the evidence however old it is.
    log.append("op_failed", { type: "repair_claimed", claimId: "claim", tokenSha256: "0".repeat(64), source: failed.commitId, workspace: "repair", by: "worker" });
    assert.deepEqual(expiredEvidence(log, later(365)), []);
    log.append("op_failed", { type: "repair_released", claimId: "claim", by: "worker", reason: "released" });
    assert.deepEqual(expiredEvidence(log, later(31)).map(({ operation, policy }) => [operation.id, policy]), [["op_failed", "unadopted"]]);

    // Unconfirmed publication waits for reconciliation, never for a clock.
    jj(f.repo, ["new"]);
    await failedAttempt(log, "op_unconfirmed", f);
    log.append("op_unconfirmed", { type: "integrated", base: "b".repeat(40), commitId: "c".repeat(40) });
    assert.deepEqual(expiredEvidence(log, later(365)).map(({ operation }) => operation.id), ["op_failed"]);

    const h = createRunnerHandler({ log, token: "t", runnerName: "fixture", readLog: async () => "", onSubmitted: () => {}, kill: () => ({ status: "idle" }), subscribe: log.subscribe });
    const get = (path: string) => h(new Request(`http://runner/v1/operations/${path}`, { headers: { authorization: "Bearer t" } }));
    assert.deepEqual(await pruneRetainedEvidence({ home: f.home, log, executor: localExecutor(), now: later(31) }), ["op_failed"]);
    assert.doesNotMatch(refs(f.home), new RegExp(log.events({ operationId: "op_failed" }).flatMap((row) => row.event.type === "source_retained" ? [row.event.sourceRef] : [])[0]!));
    assert.equal((await files(join(f.home, "submissions"))).length, 1, "only the unconfirmed attempt's manifest remains");
    assert.equal((await files(join(f.home, "command-artifacts"))).length, 1);
    const operation = log.operation("op_failed");
    assert.ok(operation?.kind === "landing" && operation.outcome?.evidenceExpired?.policy === "unadopted");
    assert.ok(operation.outcome.evidence.gaps.some((gap) => /expired under the unadopted retention policy/.test(gap)));
    assert.equal(operation.runs[0]!.exitCode, 1, "the ledger's own record of the run remains");
    for (const path of ["op_failed/handoff", "op_failed/source", "op_failed/artifacts/run"]) {
      const response = await get(path);
      assert.equal(response.status, 410, path);
      assert.match((await response.json() as { error: string }).error, /expired under the runner's unadopted retention policy/);
    }
    assert.deepEqual(await pruneRetainedEvidence({ home: f.home, log, executor: localExecutor(), now: later(400) }), [], "expiry is recorded once");
  } finally { log.close(); await f.dispose(); }
}, 120_000);

test("once a logical change published, every attempt's evidence expires after 14 days", async () => {
  const base = await project();
  const f = { ...base, home: join(base.root, "runner") };
  await mkdir(f.home);
  const log = openOperationLog(join(f.home, "operations.sqlite"));
  try {
    const failed = await failedAttempt(log, "op_first", f);
    log.append("op_landed", { type: "submitted", repo: "owner/repo", changeId: failed.changeId, commitId: failed.commitId, bookmark: failed.bookmark, submittedBy: "fixture" });
    log.append("op_landed", { type: "landed", base: "b".repeat(40), commitId: failed.commitId, branch: "main", remote: "origin" });
    assert.deepEqual(expiredEvidence(log, later(13)), []);
    assert.deepEqual(expiredEvidence(log, later(15)).map(({ operation, policy }) => [operation.id, policy]), [["op_first", "published"]]);
  } finally { log.close(); await f.dispose(); }
}, 120_000);
