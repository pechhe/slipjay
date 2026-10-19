import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { landThroughRunner, releaseThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { jj, project } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

test("failed gates print the command, output verbatim and run log URL", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const output = "  gate failed\nsecond line\n";
    f.append(op.id, { type: "failed", stage: "verifying", reason: "gate failed", command: "bun run check", output });
    const result = await running;
    assert.equal(result.ok, false);
    assert.ok(f.lines.includes(output));
    assert.ok(f.lines.includes("bun run check"));
    assert.ok(f.lines.includes(result.logUrl));
    assert.ok(f.lines.some((line) => line.includes("failed at verifying")));
    // The candidate stays the editable working copy, so a fix amends it rather than stacking on it.
    assert.equal(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), f.commit);
  } finally { await f.dispose(); }
});

test("queued positions and stage changes name the runner", async () => {
  const f = await fixture();
  try {
    f.append("ahead", { type: "submitted", repo: "fixture/project", changeId: "kkkkkkkkkkkk", commitId: "older", bookmark: candidateBookmark("kkkkkkkkkkkk"), submittedBy: "fixture" });
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 2)"));
    const operation = f.log.operationsForChange("fixture/project", f.change)[0]!;
    f.append("ahead", { type: "cancelled", reason: "fixture" });
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 1)"));
    f.append(operation.id, { type: "stage", stage: "verifying" });
    await waitFor(() => f.lines.includes("[runner test-runner] verifying"));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    await running;
  } finally { await f.dispose(); }
});

test("a release confirm waits behind running work, follows its release to the verdict and reattaches on a rerun", async () => {
  const f = await fixture();
  try {
    f.append("ahead", { type: "submitted", kind: "release", repo: "fixture/project", commitId: "o".repeat(40), migrationsReady: false, submittedBy: "fixture" });
    f.append("ahead", { type: "stage", stage: "verifying" });
    const candidate = "c".repeat(40);
    const options = { ...f.options, candidate, remote: "origin", migrationsReady: false };
    const following = new AbortController();
    const detached = releaseThroughRunner(f.cwd, { ...options, signal: following.signal });
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 2, behind release oooooooooooo)"));
    following.abort(new Error("detached"));
    await assert.rejects(detached, /detached/);
    const release = f.log.openOperations().find((op) => op.kind === "release" && op.commitId === candidate)!;
    const rerun = releaseThroughRunner(f.cwd, options);
    await waitFor(() => f.lines.includes(`[runner test-runner] following the open release of ${candidate.slice(0, 12)}`));
    assert.equal(f.log.openOperations().filter((op) => op.kind === "release" && op.commitId === candidate).length, 1, "the rerun submitted no second release");
    f.append("ahead", { type: "cancelled", reason: "fixture" });
    f.append(release.id, { type: "stage", stage: "verifying" });
    f.append(release.id, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run verify:release", output: "boom\n" });
    const { operation, logUrl } = await rerun;
    assert.equal(operation.id, release.id);
    assert.deepEqual(operation.result, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run verify:release", output: "boom\n" });
    assert.equal(logUrl, `slipjay runner log ${release.id}`);
  } finally { await f.dispose(); }
});

test("a dropped stream reconnects from the last event without repeating progress", async () => {
  const f = await fixture(true);
  try {
    const running = landThroughRunner(f.cwd, { ...f.options, env: { ...f.options.env, SLIPJAY_RUNNER_VERBOSE: "1" } });
    void running.catch(() => {});
    await waitFor(() => f.streamRequests.length === 2);
    assert.equal(f.streamRequests[1], f.droppedSeq());
    const op = f.log.openOperations()[0]!;
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await running;
    assert.equal(f.lines.filter((line) => line === "before reconnect").length, 1);
  } finally { await f.dispose(); }
});

test("a runner restart mid-follow reconnects and reports the verdict", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const back = await f.goDown();
    await waitFor(() => f.lines.some((line) => line.includes("connection lost; reconnecting")));
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await back();
    const result = await running;
    assert.equal(result.operation.id, op.id);
    assert.equal(result.operation.status, "cancelled");
  } finally { await f.dispose(); }
});
