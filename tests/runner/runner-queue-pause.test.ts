import assert from "node:assert/strict";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { fixture, test } from "./fixtures/runner-queue-fixture.ts";

test("priority without a bypass waits for resume and then lands first", async () => {
  const f = await fixture();
  try {
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const normal = f.submit(await f.candidate("normal.txt"));
    const priority = f.submit(await f.candidate("priority.txt"));
    assert.ok(f.queue.prioritize(priority).ok);
    await f.queue.idle();
    assert.deepEqual(f.log.openOperations().map(({ id, stage }) => [id, stage]), [[priority, "paused"], [normal, "paused"]]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake();
    await f.queue.idle();
    assert.deepEqual(f.log.events().filter(({ event }) => event.type === "landed").map(({ operationId }) => operationId), [priority, normal]);
  } finally { await f.dispose(); }
}, 120_000);

test("only a pause-bypass landing may screen, retry remotely and publish while paused", async () => {
  let opened = 0;
  const remoteVerification: RemoteVerification = {
    async open({ signal }) {
      signal.throwIfAborted();
      if (++opened === 1) throw Object.assign(new Error("verifier still starting"), { machineUnavailable: true });
      return {
        machine: { verifier: "boat", id: "fake", name: "fake", size: "test", image: "fake" }, tree: "tree", usage: null,
        executor: { host: "fake", run: runBoundedProcess },
        finish: async () => ({ tree: "tree", trackedChanges: 0, usage: null }),
        close: async () => {},
      };
    },
  };
  const f = await fixture(false, false, undefined, false, { screeningLanes: 1, remoteVerification });
  try {
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const normal = f.submit(await f.candidate("normal.txt"));
    const later = f.submit(await f.candidate("later.txt"));
    const fix = f.submit(await f.candidate("fix.txt"));
    assert.ok(f.queue.prioritize(later).ok);
    assert.ok(f.queue.prioritize(fix, { whilePaused: true }).ok);
    await f.queue.idle();
    assert.equal(f.result(fix)?.type, "landed", JSON.stringify(f.result(fix)));
    assert.equal(opened, 2);
    assert.ok(f.log.paused());
    assert.deepEqual(f.log.openOperations().map(({ id, stage }) => [id, stage]), [[later, "paused"], [normal, "paused"]]);
  } finally { await f.dispose(); }
}, 120_000);
