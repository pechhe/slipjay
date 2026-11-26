import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule } from "./fixtures/automatic-promotion.ts";
import { batchCheck } from "./fixtures/batch-check-fixture.ts";

for (const refresh of ["background", "batch"] as const) {
  test(`a stale background pass is refreshed by ${refresh} before automatic promotion`, async () => {
    const minute = 60_000;
    let clock = Date.now();
    const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
      { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch", everyMinutes: 5 },
        releaseGates: (root) => [batchCheck(root)] });
    try {
      await f.land(f.submit(await f.candidate("zero.txt")));
      await settle(f);
      const first = f.log.releases(REPO)[0]!;
      clock = Date.parse(first.submittedAt) + minute;
      await f.land(f.submit(await f.candidate("one.txt")));
      await settle(f);
      const one = f.main();
      await f.queue.requestBatchCheck(REPO, one);
      await settle(f);

      await f.land(f.submit(await f.candidate("two.txt")));
      await settle(f);
      const two = f.main();
      clock = Date.parse(f.log.verifications(REPO)[0]!.submittedAt) + 6 * minute;
      await f.queue.recover();
      await settle(f);
      const initial = f.log.verifications(REPO, two)[0]!;
      assert.ok(initial.submittedBy.endsWith(":background"));
      assert.equal(initial.result?.type, "verified");
      const oldBase = initial.result.base;

      const ownerRelease = "op_00release_one_aaaaaaaaaaaaaaaa";
      f.log.append(ownerRelease, { type: "submitted", kind: "release", repo: REPO, commitId: one, migrationsReady: false, submittedBy: "owner" });
      // Keep the clock inside the ordinary check interval while the owner advances the release branch.
      clock = Date.parse(initial.submittedAt) + minute;
      f.queue.wake();
      await settle(f);
      await until(() => f.log.deployments(REPO, "production").find((entry) => entry.commitId === one && entry.result?.type === "deployed"));

      const released = f.log.operation(ownerRelease)!.result;
      assert.equal(released?.type, "released");
      const releaseBase = released.result.merge;
      const stale = "op_00release_stale_aaaaaaaaaaaaaa";
      if (refresh === "background") {
        // Model a stale refusal an older runner could have recorded. It must not block recovery.
        f.log.append(stale, { type: "submitted", kind: "release", repo: REPO, commitId: two, migrationsReady: false, submittedBy: "old-runner:automatic",
          automatic: { setting: "process", value: "development" } });
        f.log.append(stale, { type: "failed", stage: "verifying", reason: `Not promoted automatically: no pre-verification of ${two} passed against master ${releaseBase}` });
      }
      const slot = Date.parse(f.log.releases(REPO)[0]!.submittedAt) + 31 * minute;
      clock = refresh === "background" ? Date.parse(initial.submittedAt) + 6 * minute : slot;
      await f.queue.recover();
      await settle(f);
      const [fresh, previous] = f.log.verifications(REPO, two);
      assert.equal(previous?.id, initial.id);
      assert.ok(fresh!.submittedBy.endsWith(`:${refresh}`));
      assert.equal(fresh!.result?.type, "verified");
      assert.notEqual(fresh!.result.base, oldBase);
      assert.equal(fresh!.result.base, releaseBase);
      if (refresh === "background") {
        assert.deepEqual(f.log.releases(REPO, two).map((entry) => entry.id), [stale]);
        clock = slot;
        await f.queue.recover();
        await settle(f);
      }
      assert.deepEqual(f.log.releases(REPO, two).map((entry) => entry.status),
        refresh === "background" ? ["released", "failed"] : ["released"], "no doomed release was submitted by the current runner");
    } finally { await f.dispose(); }
  }, 300_000);
}
