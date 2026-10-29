import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import * as workspace from "../../src/lib/infra/workspace-jj.ts";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { fixture, until } from "./fixtures/runner-queue-fixture.ts";

for (const ending of ["kill", "deadline"] as const) {
  test(`pre-verification ${ending} interrupts fetching before any executor command`, async () => {
    const f = await fixture(false, true, undefined, false, { workers: 1,
      ...(ending === "deadline" ? { verificationStageTimeoutMs: 5000 } : {}) });
    let release!: () => void;
    let entered = false;
    let resumed = false;
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    const context = workspace.workspaceContext;
    const spy = vi.spyOn(workspace, "workspaceContext").mockImplementation(async (...args) => {
      if (args[0]?.includes("/releases/")) {
        entered = true;
        await stuck;
        resumed = true;
      }
      return context(...args);
    });
    try {
      assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
      const id = newOperationId();
      f.log.append(id, { type: "submitted", kind: "verification", repo: "fixture/repo", commitId: f.main(), submittedBy: "test" });
      f.queue.wake();
      await until(() => entered || undefined);
      assert.equal(f.log.operation(id)?.stage, "fetching");
      if (ending === "kill") assert.equal(f.queue.kill(id).status, "killed");
      await until(() => f.result(id));
      await f.queue.idle();
      const result = f.result(id);
      if (ending === "kill") assert.deepEqual(result, { type: "cancelled", reason: OWNER_KILL_REASON });
      else {
        assert.ok(result?.type === "failed", JSON.stringify(result));
        assert.equal(result.stage, "fetching");
        assert.match(result.reason, /Pre-verification timed out during fetching/);
      }
      assert.equal(f.log.operation(id)?.runs.length, 0);
      assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
      release();
      await until(() => resumed || undefined);
      assert.deepEqual(f.result(id), result);
    } finally {
      release();
      spy.mockRestore();
      await f.dispose();
    }
  }, 120_000);
}
