import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as serialTest } from "vite-plus/test";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import { batchCheck, localRemote, preemptionWaitMs } from "./fixtures/batch-check-fixture.ts";

serialTest("a confirm of a newer commit stops a scheduled batch's in-flight head check", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" },
      releaseGates: (root) => [`${batchCheck(root)}
const held = at("hold-head");
while (fs.existsSync(held) && fs.readFileSync(held, "utf8") === process.env.SLIPJAY_RELEASE_HEAD)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`],
      recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("one.txt")));
    const older = f.main();
    await writeFile(join(f.root, "hold-head"), older);

    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    f.queue.wake();
    const scheduled = f.log.verifications(REPO, older).find((check) => check.submittedBy.endsWith(":batch"));
    assert.ok(scheduled, "recovery schedules a batch for the older head");
    await until(async () => {
      assert.equal(f.log.operation(scheduled.id)?.result, undefined, "the batch has not ended before its head check");
      return (await f.lines("batch-env.jsonl")).some((line) => line.includes(older)) || undefined;
    }, preemptionWaitMs);

    const landing = f.submit(await f.candidate("two.txt"));
    f.queue.wake();
    await until(() => f.log.operation(landing)?.result?.type === "landed" || undefined, preemptionWaitMs);
    const head = f.main();
    assert.equal(f.log.operation(scheduled.id)?.status, "running");

    const confirm = await f.queue.requestBatchCheck(REPO, head);
    assert.ok(confirm?.requested && confirm.operation.submittedBy.endsWith(":confirm"));
    // The older head's command is still held: only an abort can free the place for the confirm.
    await until(() => f.log.operation(confirm.operation.id)?.result, preemptionWaitMs);
    assert.equal(f.log.operation(confirm.operation.id)?.status, "verified");
    assert.equal(f.log.operation(scheduled.id)?.status, "cancelled");
    const outcomes = batchEvents(f, scheduled.id, "batch_outcome");
    assert.deepEqual(outcomes.map(({ outcome }) => outcome), ["stopped"]);
    assert.match(outcomes[0]!.reason!, /stopped for the release of/);
    assert.equal(outcomes[0]!.shorterCandidate, undefined);
    assert.deepEqual(batchEvents(f, scheduled.id, "batch_run"), []);
    assert.equal(routed, 0);
  } finally {
    await rm(join(f.root, "hold-head"), { force: true });
    await f.dispose();
  }
}, 300_000);

test("a confirm arriving during the completed probe's remote finish leaves its verdict reusable", async () => {
  let clock = Date.now();
  let culprit: string | undefined;
  const finishing = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  const remote = localRemote();
  let probes = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" },
      releaseGates: (root) => [batchCheck(root)],
      batchRemote: { async open(input) {
        const attempt = await remote.open(input);
        if (input.candidate !== culprit) return attempt;
        probes++;
        return { ...attempt, async finish() {
          finishing.resolve(input.signal!);
          await finish.promise;
          input.signal!.throwIfAborted();
          return attempt.finish();
        } };
      } } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    clock = Date.parse(f.log.releases(REPO)[0]!.submittedAt) + 60_000;
    await f.land(f.submit(await f.candidate("break-a")));
    culprit = f.main();
    await f.land(f.submit(await f.candidate("second.txt")));
    const second = f.main();
    await f.land(f.submit(await f.candidate("third.txt")));
    const original = await f.queue.requestBatchCheck(REPO, f.main());
    const signal = await finishing.promise;
    const waiting = await f.queue.requestBatchCheck(REPO, second);
    assert.ok(original?.requested && waiting?.requested);
    assert.equal(signal.aborted, false, "remote finish is not in-flight diagnosis");
    finish.resolve();
    await settle(f);
    const [outcome] = batchEvents(f, original.operation.id, "batch_outcome");
    assert.ok(outcome?.outcome === "red");
    assert.equal(outcome.diagnosis, "complete");
    assert.equal(probes, 1, "the queued confirm reused the cleanly finished historical probe");
    assert.ok(batchEvents(f, waiting.operation.id, "progress").some(({ line }) => line.includes("reusing cached diagnosis result")));
  } finally {
    finish.resolve();
    await f.dispose();
  }
}, 180_000);
