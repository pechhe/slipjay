import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, batchEvents } from "./fixtures/automatic-promotion.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { workbenchCheck, MINUTE, tenHourSchedule } from "./fixtures/background-check-fixture.ts";

test("a release the owner pushes stops a running background check, which ends stopped, routes nothing and is checked again later", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: tenHourSchedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [workbenchCheck(root)],
      recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + MINUTE;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const one = f.main();
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const two = f.main();

    // The background check of `two` holds in its command.
    await writeFile(join(f.root, "hold"), "");
    clock = promotedAt + 21 * MINUTE;
    void f.queue.recover();
    const background = await until(() => f.log.verifications(REPO).find((entry) => entry.commitId === two && entry.status === "running"));
    await until(async () => (await f.lines("batch-env.jsonl").catch(() => [])).some((line) => line.includes(two)) || undefined);

    // The owner pushes `one`: the background check stops and the confirm's own check runs.
    const asked = await f.queue.requestBatchCheck(REPO, one);
    assert.equal(asked?.requested, true);
    await rm(join(f.root, "hold"));
    await settle(f);
    const stopped = f.log.operation(background.id)!;
    assert.equal(stopped.status, "cancelled");
    const [outcome] = batchEvents(f, background.id, "batch_outcome");
    assert.equal(outcome!.outcome, "stopped");
    assert.match(outcome!.reason!, /stopped for the release of/);
    assert.equal(f.log.verifications(REPO).find((entry) => entry.id === asked!.operation.id)!.status, "verified");
    assert.equal(routed, 0);

    // The stopped head is checked again on the interval.
    clock = promotedAt + 45 * MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.ok(f.log.verifications(REPO).some((entry) => entry.commitId === two && entry.status === "verified" && entry.id !== background.id));
  } finally { await f.dispose(); }
}, 300_000);

test("a background check waits while a landing is queued, and starts once the queue is clear", async () => {
  let clock = Date.now();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: tenHourSchedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [workbenchCheck(root)] });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + MINUTE;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);

    // The runner is paused, so the next landing stays queued while the interval passes.
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const queued = f.submit(await f.candidate("two.txt"));
    clock = promotedAt + 21 * MINUTE;
    await f.queue.recover();
    assert.equal(f.log.operation(queued)!.status, "queued");
    assert.equal(f.log.verifications(REPO).length, 1, "the gate goes first: no background check while a landing is queued");

    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    await f.land(queued);
    await settle(f);
    const two = f.main();
    await until(() => f.log.verifications(REPO).find((entry) => entry.commitId === two && entry.result) ?? undefined);
    assert.ok(f.log.verifications(REPO).find((entry) => entry.commitId === two)!.submittedBy.endsWith(":background"));
  } finally { await f.dispose(); }
}, 300_000);
