import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

// Build #3128: a landing whose submission response is lost, after a fetch of every bookmark
// imported the pushed candidate untracked and so made it immutable.
async function unknownOutcome(how: "lost" | "unreceived") {
  const f = await fixture();
  const metadata = metadataPath(f.workspaceName);
  await writeFile(metadata, JSON.stringify({ ...JSON.parse(await readFile(metadata, "utf8")), issueNumber: 3128 }));
  f.failNextSubmission(how);
  await assert.rejects(landThroughRunner(f.cwd, f.options), /Landing submission outcome is unknown \(request [a-f0-9-]{36}\); run slipjay land again/);
  jj(f.repo, ["git", "fetch"]);
  const candidate = jj(f.cwd, ["log", "-r", f.change, "--no-graph", "-T", "commit_id"]);
  assert.match(jj(f.cwd, ["log", "-r", candidate, "--no-graph", "-T", "description"]), /#3128/, "the candidate was described with its trailer before it was pushed");
  assert.equal(jj(f.cwd, ["log", "-r", candidate, "--no-graph", "-T", "immutable"]), "true");
  const pending = async () => Object.values((await workspaceMetadata(f.workspaceName))?.pendingLandingRequests as Record<string, string> ?? {});
  return { f, candidate, pending };
}

test("rerunning after a lost submission response reattaches to the runner's operation without rewriting the immutable candidate", async () => {
  const { f, candidate, pending } = await unknownOutcome("lost");
  try {
    const [op] = f.log.openOperations();
    assert.ok(op);
    assert.deepEqual(await pending(), [f.requestIds[0]]);
    const again = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.log.events().some((stored) => stored.event.type === "client" && stored.event.fact.kind === "land_follow" && stored.event.fact.reattached));
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    const result = await again;
    assert.equal(result.operation.id, op.id);
    assert.equal(f.requestIds.length, 1, "the rerun sends no second submission");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(jj(f.cwd, ["log", "-r", f.change, "--no-graph", "-T", "commit_id"]), candidate);
    assert.deepEqual(await pending(), [], "reconciled, the request is no longer pending");
  } finally { await f.dispose(); }
});

test("rerunning after a lost response whose operation has since finished reconciles to it under the same request", async () => {
  const { f, candidate, pending } = await unknownOutcome("lost");
  try {
    const [op] = f.log.openOperations();
    assert.ok(op);
    f.append(op.id, { type: "failed", stage: "verifying", reason: "fixture gate failed before the rerun" });
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.operation.id, op.id);
    assert.equal(result.ok, false);
    assert.deepEqual(f.requestIds, [f.requestIds[0], f.requestIds[0]], "the rerun resubmits under the persisted request, which the runner deduplicates");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(jj(f.cwd, ["log", "-r", f.change, "--no-graph", "-T", "commit_id"]), candidate);
    assert.deepEqual(await pending(), []);
  } finally { await f.dispose(); }
});

test("a submission the runner never received stays unknown until a rerun resubmits the same source under the same request", async () => {
  const { f, candidate, pending } = await unknownOutcome("unreceived");
  try {
    assert.equal(f.log.openOperations().length, 0);
    const [requestId] = f.requestIds;
    // Still unreachable: the outcome stays unknown and the request identity is kept.
    f.failNextSubmission("unreceived");
    await assert.rejects(landThroughRunner(f.cwd, f.options), /outcome is unknown/);
    assert.deepEqual(await pending(), [requestId]);
    const again = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.log.openOperations().length === 1);
    const op = f.log.openOperations()[0]!;
    assert.equal(op.commitId, candidate);
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    const result = await again;
    assert.equal(result.operation.id, op.id);
    assert.deepEqual(f.requestIds, [requestId, requestId, requestId]);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(jj(f.cwd, ["log", "-r", f.change, "--no-graph", "-T", "commit_id"]), candidate);
    assert.deepEqual(await pending(), [], "reconciled, the request is no longer pending");
  } finally { await f.dispose(); }
});
