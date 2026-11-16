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


/** The newest "Not promoting" note on the newest landing's pre-verification, which the watch reports from. */
const latestHold = (f: Awaited<ReturnType<typeof fixture>>) => {
  const verification = f.log.verifications(REPO).find((entry) => entry.commitId === f.main())!;
  const note = f.log.events({ operationId: verification.id }).map((stored) => stored.event)
    .findLast((event) => event.type === "progress" && event.line.startsWith("Not promoting "));
  return note?.type === "progress" ? { line: note.line, hold: note.hold } : undefined;
};

test("a scheduled commit the owner must decide on waits for its slot before it is withheld (T3-700)", async () => {
  let clock = Date.now();
  const promotionSchedule = { everyMinutes: 30, from: "00:00", until: "23:59", timeZone: "Europe/London" };
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" }, false, { process: "development", promotionSchedule, now: () => clock });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    assert.equal(f.log.releases(REPO).length, 1, "the first landing promotes at once");
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);

    // Inside the interval, a non-additive migration waits for the slot like any landing, and says when it is.
    clock = promotedAt + 10 * 60_000;
    await f.land(f.submit(await f.candidate("schema/drop")));
    await settle(f);
    const scheduled = latestHold(f);
    assert.equal(scheduled?.hold?.kind, "slot", JSON.stringify(scheduled));
    assert.ok(scheduled?.hold?.kind === "slot" && Date.parse(scheduled.hold.at) > clock, JSON.stringify(scheduled));

    // The slot refuses it: from then on it waits for someone to decide.
    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    await settle(f);
    assert.equal(f.log.releases(REPO).length, 1, "nothing promotes it");
    const withheld = latestHold(f);
    assert.deepEqual(withheld?.hold, { kind: "decision" });
    assert.match(withheld?.line ?? "", /non-additive migrations/);
  } finally { await f.dispose(); }
}, 240_000);

test("with no schedule, a commit the owner must decide on is withheld at once (T3-700)", async () => {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" }, false, { process: "development" });
  try {
    await f.land(f.submit(await f.candidate("schema/drop")));
    await settle(f);
    assert.deepEqual(latestHold(f)?.hold, { kind: "decision" });
  } finally { await f.dispose(); }
}, 240_000);
