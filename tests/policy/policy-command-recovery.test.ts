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

test("policy set recovers interrupted runs, pre-patch attempts, and already-applied leftovers without double-submitting", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      // 1. A rerun after an interrupted policy set reattaches to its operation and never submits twice.
      const { revision } = await showPolicy(f.repo);
      assert.equal((await controlRunner(location, "pause", env)).ok, true);
      const followed: string[] = [];
      const following = new AbortController();
      const first = setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location, env, signal: following.signal, onOperation: (id) => { followed.push(id); } });
      await vi.waitFor(() => assert.equal(followed.length, 1), { timeout: 60_000, interval: 20 });
      following.abort(new Error("stopped following"));
      const interrupted = await first;
      assert.equal(interrupted.phase, "uncertain", JSON.stringify(interrupted));
      assert.equal((await controlRunner(location, "resume", env)).ok, true);
      const rerunLines: string[] = [];
      const result = await setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location, env, onLine: (line) => { rerunLines.push(line); }, onOperation: (id) => { followed.push(id); } });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      assert.ok(rerunLines.some((line) => line.startsWith("Reattaching")));
      assert.deepEqual(followed, [followed[0], followed[0]]);
      assert.equal(result.phase === "landed" && result.operationId, followed[0]);

      // 2. A rerun after an attempt that failed before writing its patch prepares and lands it.
      const view = await showPolicy(f.repo);
      const patch = { spares: 3 };
      await createWorkspace(patchTask(view.digest!, patch), f.repo);
      const lines: string[] = [];
      const second = await setPolicy(f.repo, { base: view.revision, patch, location, env, onLine: (line) => { lines.push(line); } });
      assert.equal(second.phase, "landed", JSON.stringify(second));
      assert.ok(!lines.some((line) => line.startsWith("Reattaching")));
      assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 3);

      // 3. A rerun once the patch is on the integration branch reports it applied and releases the leftover attempt.
      const leftover = (await createWorkspace(patchTask(view.digest!, patch), f.repo)).workspacePath;
      const rerun = await setPolicy(f.repo, { base: view.revision, patch, location, env });
      assert.equal(rerun.phase, "already-applied", JSON.stringify(rerun));
      await vi.waitFor(() => assert.equal(existsSync(leftover), false), { timeout: 120_000, interval: 20 });
    });
    const log = openOperationLog(join(f.root, "runner", "operations.sqlite"));
    try { assert.equal(log.events().filter((row) => row.event.type === "submitted").length, 2); }
    finally { log.close(); }
  } finally { await f.dispose(); }
}, 240_000);
