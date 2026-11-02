import assert from "node:assert/strict";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";

test("a promotionSchedule batches development promotions and a confirmed promotion is never held", async () => {
  // Operations record wall-clock times, so the test clock is set relative to the newest release's.
  let clock = Date.now();
  const promotionSchedule = { everyMinutes: 30, from: "00:00", until: "23:59", timeZone: "Europe/London" };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development", promotionSchedule, now: () => clock });
  try {
    // Nothing promoted yet: the first pre-verified landing promotes at once.
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    const first = f.main();
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [first]);

    // Ten minutes later the next landing waits for the batch, and says why on its pre-verification.
    const promotedAt = () => Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt() + 10 * 60_000;
    await f.land(f.submit(await f.candidate("b.txt")));
    await settle(f);
    const second = f.main();
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [first]);
    const waiting = f.log.verifications(REPO).find((entry) => entry.commitId === second)!;
    assert.ok(f.log.events({ operationId: waiting.id }).some((stored) => stored.event.type === "progress"
      && /waiting for the next scheduled promotion: promotions are batched every 30 min/.test(stored.event.line)));

    // Once the interval has passed, asking again promotes the batch.
    clock = promotedAt() + 31 * 60_000;
    await f.queue.recover();
    await settle(f);
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [second, first]);

    // An owner's confirm inside the interval is not held.
    clock = promotedAt() + 60_000;
    await f.land(f.submit(await f.candidate("c.txt")));
    await settle(f);
    assert.equal(f.log.releases(REPO).length, 2, "the automatic promotion waits");
    await f.land(f.submitRelease(f.main()));
    await settle(f);
    assert.equal(f.log.releases(REPO)[0]?.commitId, f.main());
    assert.ok(f.log.releases(REPO)[0]?.result?.type === "released", JSON.stringify(f.log.releases(REPO)[0]?.result));
  } finally { await f.dispose(); }
}, 240_000);
