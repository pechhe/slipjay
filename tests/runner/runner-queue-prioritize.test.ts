import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { fixture, test, until } from "./fixtures/queue-maintenance-fixture.ts";

test("priority preserves the running landing, then takes queued fixes in priority-request order", async () => {
  const f = await fixture(false, false, undefined, false, { workers: 1, gates: (root) => [
    ...["active", "newest"].map((name) =>
      `const fs=require("node:fs");while(fs.existsSync(${JSON.stringify(name + ".txt")})&&fs.existsSync(${JSON.stringify(join(root, "hold-" + name))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);`),
  ] });
  const activeHold = join(f.root, "hold-active");
  const newestHold = join(f.root, "hold-newest");
  try {
    await Promise.all([writeFile(activeHold, ""), writeFile(newestHold, "")]);
    const active = f.submit(await f.candidate("active.txt"));
    const older = f.submit(await f.candidate("older.txt"));
    const urgent = f.submit(await f.candidate("urgent.txt"));
    const newest = f.submit(await f.candidate("newest.txt"));
    f.queue.wake();
    await until(() => f.log.operation(active)?.stage === "verifying" || undefined);
    const first = f.queue.prioritize(newest, { reason: "repair integration" });
    assert.ok(first.ok);
    assert.ok(f.queue.prioritize(urgent).ok);
    const repeat = f.queue.prioritize(newest, { whilePaused: true });
    assert.ok(repeat.ok);
    assert.deepEqual(repeat.operation.prioritized, { seq: first.operation.prioritized?.seq, reason: "repair integration", whilePaused: true });
    assert.deepEqual(f.log.openOperations("fixture/repo").map(({ id, position }) => [id, position]), [
      [active, 1], [newest, 2], [urgent, 3], [older, 4],
    ]);

    await rm(activeHold);
    await until(() => f.log.operation(newest)?.stage === "verifying" || undefined);
    assert.deepEqual(f.log.openOperations("fixture/repo").map(({ id, position }) => [id, position]), [[newest, 1], [urgent, 2], [older, 3]]);
    await rm(newestHold);
    await f.queue.idle();
    assert.deepEqual(f.log.events().filter(({ event }) => event.type === "landed").map(({ operationId }) => operationId), [active, newest, urgent, older]);
  } finally {
    await Promise.all([rm(activeHold, { force: true }), rm(newestHold, { force: true })]);
    await f.dispose();
  }
}, 120_000);

test("priority refuses unknown, non-landing and finished operations without appending a priority", async () => {
  const f = await fixture();
  try {
    const reset = f.submitReset();
    const finished = f.submit(await f.candidate("finished.txt"));
    f.log.append(finished, { type: "cancelled", reason: "not needed" });
    const seq = f.log.latestSeq();
    for (const [id, status, message] of [["unknown", 404, /Unknown operation/], [reset, 409, /not a landing/], [finished, 409, /already finished.*cancelled/]] as const) {
      const result = f.queue.prioritize(id);
      assert.ok(!result.ok);
      assert.equal(result.status, status);
      assert.match(result.error, message);
    }
    assert.equal(f.log.latestSeq(), seq);
  } finally { await f.dispose(); }
});

for (const kind of ["release", "reset"] as const) test(`a queued ${kind} still fences a prioritized screen while paused`, async () => {
  const f = await fixture(false, false, undefined, false, { screeningLanes: 1 });
  try {
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const older = f.submit(await f.candidate("older.txt"));
    const fence = kind === "reset" ? f.submitReset() : f.submitRelease(f.main());
    const fix = f.submit(await f.candidate("fix.txt"));
    assert.ok(f.queue.prioritize(fix, { whilePaused: true }).ok);
    await f.queue.idle();
    assert.deepEqual(f.log.openOperations().map(({ id, status }) => [id, status]), [[older, "queued"], [fence, "queued"], [fix, "queued"]]);
    assert.match(f.log.operation(fix)!.waitingFor ?? "", new RegExp(`^${kind} `));
  } finally { await f.dispose(); }
}, 120_000);
