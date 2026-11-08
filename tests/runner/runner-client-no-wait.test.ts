import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import type { BuildAdmission } from "../../src/lib/build/build-admission.ts";
import { runLand } from "../../src/launcher/landing-commands.ts";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { startLandingFollower } from "../../src/lib/workspace/workspace-background.ts";
import { landingFollowLogPath } from "../../src/lib/workspace/workspace-paths.ts";
import { fixture, released, waitFor } from "./fixtures/runner-client-fixture.ts";

// SJ-208: `slipjay land --no-wait` returns once the runner holds the landing, and the follower it
// leaves (`slipjay land --follow`) finishes the landing here without ever submitting.

const submissions = (f: Awaited<ReturnType<typeof fixture>>) => f.log.events().filter((stored) => stored.event.type === "submitted").length;
const reattached = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.log.events().filter((stored) => stored.event.type === "client" && stored.event.fact.kind === "land_follow" && stored.event.fact.reattached).length;

test("a no-wait submission returns once the runner holds the landing, and an unfollowed publication still releases the workspace", async () => {
  const f = await fixture();
  try {
    const submitted = await landThroughRunner(f.cwd, { ...f.options, submitOnly: true });
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.ok, true);
    assert.equal(submitted.operation.status, "queued", "returned before the runner had an outcome");
    await access(f.cwd);
    // The follower a no-wait submission leaves reattaches; the runner then publishes the candidate.
    const following = landThroughRunner(f.cwd, { ...f.options, followOnly: true });
    await waitFor(() => reattached(f) === 1);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", f.commit]);
    f.append(submitted.operation.id, { type: "landed", base: "fixture-base", commitId: f.commit, branch: "main", remote: "origin" });
    const result = await following;
    assert.equal(result.ok, true);
    assert.equal(result.operation.id, submitted.operation.id);
    assert.equal(submissions(f), 1);
    assert.equal(f.requestIds.length, 1, "following sends no submission");
    await released(f.cwd);
  } finally { await f.dispose(); }
});

test("following a no-wait landing that failed reports the failure, submits nothing and keeps the workspace for repair", async () => {
  const f = await fixture();
  try {
    const submitted = await landThroughRunner(f.cwd, { ...f.options, submitOnly: true });
    f.append(submitted.operation.id, { type: "failed", stage: "verifying", reason: "fixture gate failed" });
    const result = await landThroughRunner(f.cwd, { ...f.options, followOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.operation.id, submitted.operation.id);
    assert.equal(result.operation.result?.type, "failed");
    assert.equal(f.requestIds.length, 1, "a failed landing is never resubmitted by its follower");
    assert.equal(submissions(f), 1);
    await access(f.cwd);
  } finally { await f.dispose(); }
});

test("following with nothing submitted refuses and submits nothing", async () => {
  const f = await fixture();
  try {
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, followOnly: true }), /No submitted landing of [0-9a-f]{12} to follow; nothing was submitted/);
    assert.equal(f.requestIds.length, 0);
    assert.equal(submissions(f), 0);
  } finally { await f.dispose(); }
});

test("a no-wait submission whose acknowledgement is lost is not reported as submitted, and following reconciles it without resubmitting", async () => {
  const f = await fixture();
  try {
    f.failNextSubmission("lost");
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, submitOnly: true }), /Landing submission outcome is unknown/);
    const [op] = f.log.openOperations();
    assert.ok(op);
    const following = landThroughRunner(f.cwd, { ...f.options, followOnly: true });
    await waitFor(() => reattached(f) === 1);
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    const result = await following;
    assert.equal(result.operation.id, op.id);
    assert.equal(f.requestIds.length, 1, "the lost submission is reconciled, never resubmitted");
    assert.equal(submissions(f), 1);
  } finally { await f.dispose(); }
});

test("a no-wait submission the runner refuses is not reported as submitted", async () => {
  const f = await fixture(false, false, 503);
  try {
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, submitOnly: true }), /fixture refusal/);
    assert.equal(f.log.openOperations().length, 0);
  } finally { await f.dispose(); }
});

test("a no-wait submission whose Forge admission is deferred is not reported as submitted until a rerun is admitted", async () => {
  const answers: BuildAdmission[] = [{ outcome: "unavailable", reason: "Build did not answer in time" }];
  const f = await fixture(false, false, false, (request) => Promise.resolve(answers.shift() ?? { outcome: "admitted", sequence: request.sequence, sessionId: request.sessionId, recordedAt: null }));
  try {
    const handoff = { version: 1 as const, source: f.commit, intent: "Bound work", scope: [], spec: null, helpers: [], checks: [], reviews: [], toolchain: [], gaps: [],
      build: { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" } };
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, handoff, submitOnly: true }), /did not answer in time.*slipjay land again/);
    const pending = f.log.operation(f.log.events().find((row) => row.event.type === "submitted")!.operationId);
    assert.ok(pending?.kind === "landing" && pending.admission === "pending");
    const submitted = await landThroughRunner(f.cwd, { ...f.options, handoff, submitOnly: true });
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.operation.id, pending.id);
    assert.equal(submissions(f), 1);
  } finally { await f.dispose(); }
}, 60_000);

test("the landing follower runs detached in the landed workspace and writes to the landing-follow log", async () => {
  const root = await mkdtemp(join(tmpdir(), "slipjay-follower-"));
  const marker = join(root, "followed");
  const follower = await startLandingFollower(root, { command: ["sh", "-c", `pwd > ${JSON.stringify(marker)}`] });
  assert.equal(follower.started, true);
  assert.equal(follower.logPath, landingFollowLogPath());
  const expected = await realpath(root);
  await vi.waitFor(async () => assert.equal((await readFile(marker, "utf8").catch(() => "")).trim(), expected), { timeout: 10_000, interval: 20 });
});

test("the follower a no-wait submission starts finishes an unfollowed publication by itself, without resubmitting", async () => {
  const f = await fixture();
  try {
    const submitted = await landThroughRunner(f.cwd, { ...f.options, submitOnly: true });
    vi.stubEnv("SLIPJAY_RUNNER", f.server.url);
    vi.stubEnv("SLIPJAY_RUNNER_TOKEN", "test-token");
    const follower = await startLandingFollower(f.cwd);
    assert.equal(follower.started, true);
    await waitFor(() => reattached(f) === 1);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", f.commit]);
    f.append(submitted.operation.id, { type: "landed", base: "fixture-base", commitId: f.commit, branch: "main", remote: "origin" });
    await released(f.cwd);
    assert.equal(f.requestIds.length, 1);
    assert.equal(submissions(f), 1);
  } finally { vi.unstubAllEnvs(); await f.dispose(); }
}, 180_000);

test("a no-wait landing of the primary checkout is refused before anything is submitted", async () => {
  await assert.rejects(runLand(["--no-wait", "--direct"]), /--no-wait cannot land the primary checkout/);
  await assert.rejects(runLand(["--follow", "--no-wait"]), /Usage: slipjay land/);
});
