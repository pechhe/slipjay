import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { patchTask, setPolicy, showPolicy } from "../src/lib/policy-command.ts";
import { createWorkspace } from "../src/lib/workspace-create.ts";
import { controlRunner, landThroughRunner, readRunLog } from "../src/lib/runner-client.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { jj, project, withTestRunner } from "./support/workspace-project.ts";

// A landing check that takes five minutes: a settings landing that ran it would time the test out.
const slowGate = () => "setTimeout(() => {}, 300_000)";

test("policy set lands settings without the landing check, and a second clone reads them after fetch", async () => {
  const f = await project({ verify: slowGate, policy: { parallelExecution: true } });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const before = await showPolicy(f.repo);
      assert.deepEqual(before.settings.spares, 1);
      assert.equal(before.settings.process, "standard");
      assert.deepEqual(before.retired, ["parallelExecution"]);
      const started = Date.now();
      const result = await setPolicy(f.repo, { base: before.revision, patch: { spares: 3, process: "light" }, location, env });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      if (result.phase !== "landed") return;
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
      const log = await readRunLog(location, result.operationId, env);
      assert.match(log, /verification_skipped/);
      assert.doesNotMatch(log, /setTimeout/);

      const clone = join(f.root, "second-clone");
      jj(f.root, ["git", "clone", `file://${f.remote}`, clone]);
      jj(clone, ["git", "fetch"]);
      const after = await showPolicy(clone);
      assert.equal(after.revision, result.revision);
      assert.equal(after.settings.spares, 3);
      assert.equal(after.settings.process, "light");
      assert.deepEqual(after.retired, []);

      // Removing the check is a settings change too; a save from the earlier read is refused as stale.
      const removed = await setPolicy(f.repo, { base: after.revision, patch: { requiredLandingVerification: [] }, location, env });
      assert.equal(removed.phase, "landed", JSON.stringify(removed));
      const stale = await setPolicy(f.repo, { base: before.revision, patch: { spares: 2 }, location, env });
      assert.equal(stale.phase, "refused");
      assert.match(stale.phase === "refused" ? stale.reason : "", /Stale base/);
    });
  } finally { await f.dispose(); }
}, 180_000);

test("policy set refuses fields outside the settings and checks it cannot run, distinguishing refusal from failure", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const { revision } = await showPolicy(f.repo);
      const outside = await setPolicy(f.repo, { base: revision, patch: { releaseBranch: "release" }, location, env });
      assert.deepEqual(outside.phase, "refused");
      assert.match(outside.phase === "refused" ? outside.reason : "", /refused releaseBranch/);
      const invalid = await setPolicy(f.repo, { base: revision, patch: { process: "minimal" }, location, env });
      assert.equal(invalid.phase, "refused");
      const missing = await setPolicy(f.repo, { base: revision, patch: { requiredLandingVerification: [{ executable: "slipjay-no-such-tool", args: [] }] }, location, env });
      assert.equal(missing.phase, "rejected", JSON.stringify(missing));
      assert.match(missing.phase === "rejected" ? missing.reason : "", /does not resolve on the runner host/);
      assert.equal((await showPolicy(f.repo)).revision, revision);
    });
  } finally { await f.dispose(); }
}, 180_000);

test("a rerun after an interrupted policy set reattaches to its operation and never submits twice", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const { revision } = await showPolicy(f.repo);
      assert.equal((await controlRunner(location, "pause", env)).ok, true);
      const followed: string[] = [];
      const following = new AbortController();
      // The operation is reported while it still waits in the paused queue, not only with the outcome.
      const first = setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location, env, signal: following.signal, onOperation: (id) => { followed.push(id); } });
      await vi.waitFor(() => assert.equal(followed.length, 1), { timeout: 60_000, interval: 50 });
      following.abort(new Error("stopped following"));
      const interrupted = await first;
      assert.equal(interrupted.phase, "uncertain", JSON.stringify(interrupted));
      assert.equal((await controlRunner(location, "resume", env)).ok, true);
      const rerun: string[] = [];
      const result = await setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location, env, onLine: (line) => { rerun.push(line); }, onOperation: (id) => { followed.push(id); } });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      assert.ok(rerun.some((line) => line.startsWith("Reattaching")));
      // The rerun follows the same operation it reported first, and lands it.
      assert.deepEqual(followed, [followed[0], followed[0]]);
      assert.equal(result.phase === "landed" && result.operationId, followed[0]);
    });
    const log = openOperationLog(join(f.root, "runner", "operations.sqlite"));
    try { assert.equal(log.events().filter((row) => row.event.type === "submitted").length, 1); }
    finally { log.close(); }
  } finally { await f.dispose(); }
}, 180_000);

test("a rerun after an attempt that failed before writing its patch prepares it and lands it", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const view = await showPolicy(f.repo);
      const patch = { spares: 2 };
      // The earlier attempt allocated its workspace and stopped there.
      await createWorkspace(patchTask(view.digest!, patch), f.repo);
      const lines: string[] = [];
      const result = await setPolicy(f.repo, { base: view.revision, patch, location, env, onLine: (line) => { lines.push(line); } });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      assert.ok(!lines.some((line) => line.startsWith("Reattaching")));
      assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 2);
    });
  } finally { await f.dispose(); }
}, 180_000);

test("policy set lands an added check without running any check, and the next landing runs it", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const { revision } = await showPolicy(f.repo);
      const added = { executable: "node", args: ["-e", "console.log('added check ran')"] };
      const started = Date.now();
      const result = await setPolicy(f.repo, { base: revision, patch: { requiredLandingVerification: [added] }, location, env });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      if (result.phase !== "landed") return;
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
      assert.doesNotMatch(await readRunLog(location, result.operationId, env), /added check ran|setTimeout/);
      // An ordinary landing after it is gated by the new check.
      const next = (await createWorkspace("ordinary change", f.repo)).workspacePath;
      await writeFile(join(next, "ordinary.txt"), "ordinary\n");
      jj(next, ["describe", "-m", "Add an ordinary file"]);
      const landed = await landThroughRunner(next, { location, env });
      assert.equal(landed.operation.result?.type, "landed", JSON.stringify(landed.operation.result));
      assert.match(await readRunLog(location, landed.operation.id, env), /added check ran|console\.log/);
    });
  } finally { await f.dispose(); }
}, 180_000);

test("a rerun once the patch is on the integration branch reports it applied and releases the earlier attempt", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const view = await showPolicy(f.repo);
      const patch = { spares: 2 };
      assert.equal((await setPolicy(f.repo, { base: view.revision, patch, location, env })).phase, "landed");
      // An attempt left behind, as by a run that stopped after its landing published.
      const leftover = (await createWorkspace(patchTask(view.digest!, patch), f.repo)).workspacePath;
      const rerun = await setPolicy(f.repo, { base: view.revision, patch, location, env });
      assert.equal(rerun.phase, "already-applied", JSON.stringify(rerun));
      await vi.waitFor(() => assert.equal(existsSync(leftover), false), { timeout: 30_000, interval: 50 });
    });
  } finally { await f.dispose(); }
}, 180_000);
