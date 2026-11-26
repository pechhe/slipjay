import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule } from "./fixtures/automatic-promotion.ts";
import { stand, started } from "./fixtures/prebuild-fixture.ts";

test("a background check builds its head beside its checks, and its build is part of the check", async () => {
  let clock = Date.now();
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(600), now: () => clock, batchVerification: { machine: "release-check", everyMinutes: 20 }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    clock = promotedAt + 21 * 60_000;
    await f.queue.recover();
    await settle(f);
    const check = await until(() => f.log.verifications(REPO).find((entry) => entry.submittedBy.endsWith(":background") && entry.result));
    await f.queue.idle();
    assert.match(started(f, check.id)[0] ?? "", /building .* on peach-box beside this check/);
    assert.ok(s.prebuilt().includes(`production ${check.commitId} ssh-peach-box`));
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    assert.ok(!s.leases.some((lease) => lease.startsWith("boat")), "a background check never builds on boat");
  } finally { await f.dispose(); }
}, 180_000);

for (const stopWhileWaiting of [false, true]) test(stopWhileWaiting
  ? "a background check stopped while a busy host holds it back builds nothing"
  : "a background check on a busy host starts its build only once the host admits its checks", async () => {
  let clock = Date.now();
  const s = stand();
  const host = { busy: false };
  const hostShell = () => async (script: string) => script.includes("flock") ? "claimed\n" : `${host.busy ? "99 99" : "1 1"} 1.00 1/100 200\n14\n`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(600), now: () => clock, batchVerification: { machine: "release-check", everyMinutes: 20 },
      hostShell, machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const head = f.log.lastLanded(REPO)!.commitId;
    host.busy = true;
    clock = promotedAt + 21 * 60_000;
    await f.queue.recover();
    const check = await until(() => f.log.verifications(REPO).find((entry) => entry.submittedBy.endsWith(":background")));
    await until(() => f.log.events({ operationId: check.id }).some(({ event }) => event.type === "stage" && event.stage === "waiting-for-budget") || undefined);
    assert.ok(!s.prebuilt().some((line) => line.includes(head)), "nothing builds while the host holds the check back");
    if (stopWhileWaiting) {
      assert.equal(f.queue.kill(check.id).status, "killed");
      assert.equal((await until(() => f.log.operation(check.id)?.result ?? undefined)).type, "cancelled");
      host.busy = false;
      await f.queue.idle();
      assert.ok(!s.prebuilt().some((line) => line.includes(head)), "a check stopped while it waited builds nothing");
      return;
    }
    host.busy = false;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    const events = f.log.events({ operationId: check.id }).map(({ event }) => event);
    const waited = events.findIndex((event) => event.type === "host_budget_waited");
    const built = events.findIndex((event) => event.type === "progress" && event.line.startsWith("[prebuild] building"));
    assert.ok(waited >= 0 && built > waited, "the build starts after the admission");
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
  } finally { await f.dispose(); }
}, 180_000);
