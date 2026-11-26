import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, batchEvents } from "./fixtures/automatic-promotion.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import { flakyOnce, MINUTE, twoSuites, tenHourSchedule } from "./fixtures/background-check-fixture.ts";

test("a culprit already routed for one suite is routed again only for the suite it newly breaks", async () => {
  let clock = Date.now();
  const requests: BatchCheckRecord[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: tenHourSchedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [twoSuites(root)],
      recordBatchCheck: async (record) => { requests.push(record); return { kind: "accepted", value: { number: 7002, specId: "s", runId: "r" } }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + MINUTE;
    const breaking = f.submit(await f.candidate("break-a"));
    await f.land(breaking);
    await settle(f);
    const culprit = f.main();
    // An earlier check, recorded before `ledger` existed, routed this culprit for `workbench` alone.
    const earlier = "op_00seeded_earlier_check_aaaaaaaa";
    f.log.append(earlier, { type: "submitted", kind: "verification", repo: REPO, commitId: culprit, submittedBy: "test:background" });
    f.log.append(earlier, { type: "batch_outcome", outcome: "red", base: culprit, head: culprit, machine: "batch",
      culprits: [{ commitId: culprit, operationId: breaking, workspace: null, keys: ["workbench"], failingTests: [], command: null, output: "" }] });
    f.log.append(earlier, { type: "batch_routed", commitId: culprit, operationId: breaking, specId: "s", number: 7001, runId: "r", noteId: null });
    f.log.append(earlier, { type: "failed", stage: "verifying", reason: "seeded" });

    await f.land(f.submit(await f.candidate("two.txt")));
    clock = promotedAt + 25 * MINUTE;
    await f.queue.recover();
    await settle(f);
    const red = f.log.verifications(REPO).find((entry) => entry.commitId === f.main())!;
    assert.equal(red.status, "failed");
    await until(() => batchEvents(f, red.id, "batch_routed").length || undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.failedSuites, ["ledger"], "only the suite not routed before is sent");
  } finally { await f.dispose(); }
}, 300_000);

test("a background check that ends flaky retries on the recovery interval without a new landing", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: tenHourSchedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [flakyOnce(root)],
      recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + MINUTE;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const one = f.main();
    // `workbench` fails once, then passes its rerun: the check ends flaky.
    await writeFile(join(f.root, "flaky-once"), "");
    await writeFile(join(f.root, "hold"), "");
    clock = promotedAt + 21 * MINUTE;
    await f.queue.recover();
    await until(async () => (await f.lines("batch-env.jsonl")).some((line) => JSON.parse(line).head === one) || undefined);
    // The ledger uses real time. Bring the test clock back before letting the check finish, so it cannot skip recovery.
    clock = Date.now();
    await rm(join(f.root, "hold"));
    await settle(f);
    const failed = f.log.verifications(REPO).find((entry) => entry.commitId === one)!;
    assert.equal(failed.status, "failed");
    const recoveryAt = Date.parse(failed.finishedAt!) + 10 * MINUTE;
    clock = recoveryAt - MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.equal(f.log.verifications(REPO).filter((entry) => entry.commitId === one).length, 1);
    // Nothing new has landed, yet the same head retries at the default ten-minute recovery interval.
    clock = recoveryAt;
    await f.queue.recover();
    await settle(f);
    const [first, second] = f.log.verifications(REPO).filter((entry) => entry.commitId === one).reverse();
    assert.equal(batchEvents(f, first!.id, "batch_outcome")[0]!.outcome, "flaky");
    assert.ok(second!.submittedBy.endsWith(":background"));
    assert.equal(batchEvents(f, second!.id, "batch_outcome")[0]!.outcome, "green");
    assert.equal(f.log.verifications(REPO).filter((entry) => entry.commitId === one).length, 2);
    assert.equal(routed, 0);
  } finally { await f.dispose(); }
}, 300_000);
