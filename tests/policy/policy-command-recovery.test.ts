import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { patchTask, setPolicy, showPolicy } from "../../src/lib/policy/policy-command.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { controlRunner } from "../../src/lib/runner/runner-client.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { slowGate } from "./fixtures/policy-command-fixture.ts";

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
