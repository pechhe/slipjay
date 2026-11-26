import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, batchEvents } from "./fixtures/automatic-promotion.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import { workbenchCheck, MINUTE, tenHourSchedule } from "./fixtures/background-check-fixture.ts";

test("a background check starts on its interval only when something new landed, never overlaps, diagnoses after the last green tip and routes a culprit once", async () => {
  let clock = Date.now();
  const requests: BatchCheckRecord[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: tenHourSchedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20, retryMinutes: 3 }, releaseGates: (root) => [workbenchCheck(root)],
      recordBatchCheck: async (record) => { requests.push(record); return { kind: "accepted", value: { number: 7001, specId: "s", runId: "r" } }; } });
  try {
    // The first landing promotes at once, after its scheduled check.
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    const checks = () => f.log.verifications(REPO);
    assert.equal(checks().length, 1);

    // A landing inside the interval waits for it.
    clock = promotedAt + MINUTE;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const one = f.main();
    assert.equal(checks().length, 1, "the interval has not passed");

    clock = promotedAt + 4 * MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.equal(checks().length, 1, "a green check does not use the shorter recovery interval");

    // Once the ordinary interval has passed, the newest tip is checked in the background and nothing promotes.
    clock = promotedAt + 21 * MINUTE;
    await f.queue.recover();
    await settle(f);
    const green = checks().find((entry) => entry.commitId === one)!;
    assert.equal(green.status, "verified");
    assert.ok(green.submittedBy.endsWith(":background"));
    const [started] = batchEvents(f, green.id, "batch_started");
    assert.equal(started!.background, true);
    assert.equal(f.log.releases(REPO).length, 1, "a background check promotes nothing before the schedule is due");

    // Nothing new: no check, however long it waits. (The ledger records real time, so the interval runs from the check's own record.)
    const greenAt = Date.parse(green.submittedAt);
    clock = greenAt + 45 * MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.equal(checks().length, 2);

    // Two landings inside the next interval, the first breaking `workbench`.
    clock = greenAt + 5 * MINUTE;
    for (const file of ["break-a", "two.txt"]) { await f.land(f.submit(await f.candidate(file))); await settle(f); }
    const [breaking, two] = f.log.landings(REPO).slice(-2);
    assert.equal(checks().length, 2, "landings inside the interval start nothing");
    clock = greenAt + 21 * MINUTE;
    await f.queue.recover();
    await settle(f);
    const red = checks().find((entry) => entry.commitId === two!.commitId)!;
    assert.equal(red.status, "failed");
    const [redStart] = batchEvents(f, red.id, "batch_started");
    assert.equal(redStart!.after, one, "diagnosis starts after the newest green-checked tip");
    assert.deepEqual(redStart!.landings.map((entry) => entry.commitId), [breaking!.commitId, two!.commitId]);
    const [outcome] = batchEvents(f, red.id, "batch_outcome");
    assert.deepEqual(outcome!.culprits!.map((culprit) => culprit.commitId), [breaking!.commitId]);
    const diagnosed = (await f.lines("batch-env.jsonl")).map((line) => JSON.parse(line) as { head: string; suites: string | null }).filter((entry) => entry.suites);
    assert.ok(!diagnosed.some((entry) => entry.head === one), "the green tip is not diagnosed again");
    await until(() => batchEvents(f, red.id, "batch_routed").length || undefined);
    assert.equal(requests.length, 1);

    // A known red head starts nothing until something new lands.
    clock = Date.parse(red.submittedAt) + 60 * MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.equal(checks().length, 3);

    // A new head waits through recovery, but not through the full green cadence.
    const recoveryAt = Date.parse(red.finishedAt!) + 3 * MINUTE;
    clock = recoveryAt - MINUTE;
    await f.land(f.submit(await f.candidate("three.txt")));
    await settle(f);
    assert.equal(checks().length, 3);
    clock = recoveryAt;
    await f.queue.recover();
    await settle(f);
    // It names the same culprit for the same suite, which is not routed again.
    const three = f.main();
    const again = checks().find((entry) => entry.commitId === three)!;
    assert.equal(again.status, "failed");
    await until(() => batchEvents(f, again.id, "batch_unrouted").length || undefined);
    assert.match(batchEvents(f, again.id, "batch_unrouted")[0]!.reason, new RegExp(`already routed by batch check ${red.id}`));
    assert.equal(requests.length, 1);
    assert.ok(!checks().some((a) => checks().some((b) => a !== b && a.status === "running" && b.status === "running")), "never two at once");
  } finally { await f.dispose(); }
}, 300_000);
