import assert from "node:assert/strict";
import { vi, test } from "vite-plus/test";
import * as dependencies from "../../src/lib/workspace/workspace-dependencies.ts";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { fixture, until } from "./fixtures/runner-queue-fixture.ts";

// Serial: the dependency-preparation spy belongs to this fixture only.
for (const ending of ["kill", "deadline"] as const) {
  test(`a pre-verification stuck after a successful install ends on ${ending} and frees landings`, async () => {
    const f = await fixture(false, true, undefined, false, { workers: 1,
      ...(ending === "deadline" ? { verificationStageTimeoutMs: 5000 } : {}) });
    const prepare = dependencies.prepareWorkspaceDependencies;
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(dependencies, "prepareWorkspaceDependencies").mockImplementation(async (checkout, options) => {
      if (!checkout.includes("/releases/")) return prepare(checkout, options);
      // A successful dependency command followed by a post-install await which never settles.
      await options!.runCommand!({ executable: "node", args: ["-e", ""], cwd: checkout, timeoutMs: 30_000, maxOutputBytes: 1024 });
      await stuck;
      return { state: "ready", packageManager: "bun", installInputs: null };
    });
    try {
      await f.candidate("a.txt");
      assert.equal((await f.land(f.submit(await f.push())))?.type, "landed");
      const id = newOperationId();
      f.log.append(id, { type: "submitted", kind: "verification", repo: "fixture/repo", commitId: f.main(), submittedBy: "test" });
      f.queue.wake();
      await until(() => f.log.operation(id)?.runs.some((run) => run.purpose === "dependencies" && run.exitCode === 0) || undefined);
      assert.equal(f.log.operation(id)?.stage, "installing");
      const landing = f.submit(await f.candidate("b.txt"));
      f.queue.wake();
      assert.equal(f.log.operation(landing)?.status, "queued", "the verification holds the only worker");
      if (ending === "kill") assert.equal(f.queue.kill(id).status, "killed");
      await until(() => f.result(id));
      const result = f.result(id);
      if (ending === "kill") assert.deepEqual(result, { type: "cancelled", reason: OWNER_KILL_REASON });
      else {
        assert.ok(result?.type === "failed", JSON.stringify(result));
        assert.equal(result.stage, "installing");
        assert.match(result.reason, /Pre-verification timed out during installing after 5000ms/);
      }
      // The queue must go idle and land while the original await is STILL unresolved.
      await f.queue.idle();
      assert.equal(f.result(landing)?.type, "landed", JSON.stringify(f.result(landing)));
      release();
      await stuck;
      await f.queue.idle();
      assert.deepEqual(f.result(id), result, "late success cannot replace cancellation/failure");
      assert.equal(f.log.events({ operationId: id }).some(({ event }) => event.type === "stage" && event.stage === "verifying"), false);
      assert.equal(await f.lines("release-verified.log").then((lines) => lines.length), 0);
    } finally {
      release();
      spy.mockRestore();
      await f.dispose();
    }
  }, 120_000);
}
