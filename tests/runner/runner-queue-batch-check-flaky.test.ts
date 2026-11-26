import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture } from "./fixtures/queue-batch-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import { batchCheck, localRemote } from "./fixtures/batch-check-fixture.ts";

test("a flaky batch routes nothing and its head deploys only after a complete green check, on the batch machine", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(1), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      batchRemote: localRemote(), recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);

    clock = promotedAt + 30_000;
    await writeFile(join(f.root, "flaky-once"), "");
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const head = f.main();

    clock = promotedAt + 61_000;
    await f.queue.recover();
    await settle(f);
    const checks = f.log.verifications(REPO).filter((entry) => entry.commitId === head);
    assert.deepEqual(checks.map((entry) => entry.status), ["verified", "failed"]);
    assert.deepEqual(batchEvents(f, checks[1]!.id, "batch_outcome").map((event) => [event.outcome, event.keys]), [["flaky", ["workbench"]]]);
    assert.equal(routed, 0);
    assert.equal(batchEvents(f, checks[0]!.id, "batch_started")[0]!.machine, "batch");
    const release = f.log.releases(REPO)[0]!;
    assert.equal(release.commitId, head);
    assert.ok(Date.parse(release.submittedAt) >= Date.parse(checks[0]!.finishedAt!));
  } finally { await f.dispose(); }
}, 300_000);

test("with promoteFlaky, a flaky batch whose rerun passed verifies its head and deploys it, routing nothing", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(1), now: () => clock, batchVerification: { machine: "batch", promoteFlaky: true }, releaseGates: (root) => [batchCheck(root)],
      batchRemote: localRemote(), recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);

    clock = promotedAt + 30_000;
    await writeFile(join(f.root, "flaky-once"), "");
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const head = f.main();

    clock = promotedAt + 61_000;
    await f.queue.recover();
    await settle(f);
    const checks = f.log.verifications(REPO).filter((entry) => entry.commitId === head);
    // One check: it failed once, passed its rerun, and that verified the head without a second complete check.
    assert.deepEqual(checks.map((entry) => entry.status), ["verified"]);
    assert.deepEqual(batchEvents(f, checks[0]!.id, "batch_outcome").map((event) => [event.outcome, event.keys, event.verified]), [["flaky", ["workbench"], true]]);
    assert.equal(routed, 0);
    assert.equal(f.log.releases(REPO)[0]!.commitId, head);
  } finally { await f.dispose(); }
}, 300_000);
