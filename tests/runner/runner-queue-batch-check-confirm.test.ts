import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/queue-batch-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import { batchCheck } from "./fixtures/batch-check-fixture.ts";

test("a confirm's batch check runs now, before the schedule is due, and a passed one stands for the next confirm", async () => {
  let clock = Date.now();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const head = f.main();
    assert.equal(f.log.verifications(REPO).filter((entry) => entry.commitId === head).length, 0, "the schedule is not due yet");

    const asked = await f.queue.requestBatchCheck(REPO, head);
    assert.equal(asked?.requested, true);
    await settle(f);
    const [check] = f.log.verifications(REPO).filter((entry) => entry.commitId === head);
    assert.equal(check!.status, "verified");
    assert.ok(check!.submittedBy.endsWith(":confirm"));
    assert.equal(batchEvents(f, check!.id, "batch_started")[0]!.scheduled, false);
    const again = await f.queue.requestBatchCheck(REPO, head);
    assert.deepEqual([again?.requested, again?.operation.id], [false, check!.id]);
  } finally { await f.dispose(); }
}, 300_000);

test("a confirm after another promotion does not reuse a check measured from the old base: it checks the commit again from the new one", async () => {
  let clock = Date.now();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const zero = f.main();
    clock = Date.parse(f.log.releases(REPO)[0]!.submittedAt) + 60_000;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const one = f.main();
    await f.queue.requestBatchCheck(REPO, one);
    await settle(f);
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const two = f.main();
    await f.queue.requestBatchCheck(REPO, two);
    await settle(f);
    const [old] = f.log.verifications(REPO).filter((entry) => entry.commitId === two);
    assert.equal(old!.status, "verified");
    assert.equal(batchEvents(f, old!.id, "batch_started")[0]!.base, zero);

    // The owner promotes `one` meanwhile: Production now serves it.
    f.log.append("op_00release_one_aaaaaaaaaaaaaaaa", { type: "submitted", kind: "release", repo: REPO, commitId: one, migrationsReady: false, submittedBy: "owner" });
    f.queue.wake();
    await settle(f);
    await until(() => f.log.deployments(REPO, "production").find((entry) => entry.commitId === one && entry.result?.type === "deployed") ?? undefined);

    const again = await f.queue.requestBatchCheck(REPO, two);
    assert.equal(again?.requested, true, "the check from the old base is stale");
    await settle(f);
    const fresh = f.log.verifications(REPO).find((entry) => entry.id === again!.operation.id)!;
    assert.equal(fresh.status, "verified");
    assert.equal(batchEvents(f, fresh.id, "batch_started")[0]!.base, one);
  } finally { await f.dispose(); }
}, 300_000);
