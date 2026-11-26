import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule } from "./fixtures/automatic-promotion.ts";
import { nextPromotionAt } from "../../src/lib/policy/promotion-schedule.ts";
import { stand } from "./fixtures/prebuild-fixture.ts";

test("a check killed while its build runs is never verified, and stops waiting for the build", async () => {
  const s = stand();
  const directory = mkdtempSync(join(tmpdir(), "prebuild-kill-"));
  const [checked, release] = [join(directory, "checked"), join(directory, "release-build")];
  // The build keeps running past the kill and ends once the test releases it, rather than at its own 30 s limit,
  // which the fixture's teardown would otherwise wait out.
  const build = `const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 50)`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images",
    prebuild: `${s.prebuild}; ${build}` }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } },
      releaseGates: () => [`require("node:fs").writeFileSync(${JSON.stringify(checked)}, "done"); console.log("release checks pass")`] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await until(() => existsSync(checked) || undefined);
    const check = await until(() => f.log.verifications(REPO)[0]);
    const killedAt = Date.now();
    assert.equal(f.queue.kill(check.id).status, "killed");
    const result = await until(() => f.log.operation(check.id)?.result ?? undefined);
    assert.equal(result.type, "cancelled", "a killed check ends cancelled, never verified");
    assert.ok(Date.now() - killedAt < 30_000, "it did not wait out the build");
  } finally { writeFileSync(release, ""); await f.dispose(); }
}, 120_000);

test("a landing waiting for its scheduled promotion starts building fifteen minutes before it, on the fixed machine", async () => {
  let clock = Date.now();
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    // The first landing promotes at once; the second waits for the slot thirty minutes after it.
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    await f.queue.idle();
    const first = s.prebuilt().length;
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    const due = nextPromotionAt(schedule(30), promotedAt, promotedAt);
    clock = due - 15 * 60_000 - 1_500;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const head = f.log.lastLanded(REPO)!.commitId;
    await until(() => s.prebuilt().slice(first).find((line) => line.includes(head)));
    assert.deepEqual(s.prebuilt().slice(first), [`production ${head} ssh-peach-box`], "it built the landing the slot will check, once");
    assert.equal(f.log.releases(REPO).length, 1, "it promoted nothing early");
    assert.ok(!s.leases.some((lease) => lease.startsWith("boat")), "boat built nothing");
  } finally { await f.dispose(); }
}, 120_000);

for (const configured of [true, false]) test(`successive red batches do not re-route permanent refusals (webhook configured: ${configured})`, async () => {
  let clock = Date.now();
  const s = stand();
  const build = `${s.prebuild}; if (require("node:fs").existsSync("broken.txt")) { console.error("Error: the app does not build"); process.exit(1) }`;
  const routed: string[] = [];
  const alerts: string[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: build }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } },
      releaseAlertWebhook: configured ? { url: "https://example.test/release" } : undefined,
      sendReleaseAlert: async (_url, alert) => { alerts.push(alert.operationId); },
      recordBatchCheck: async (record) => { routed.push(record.culprit.commitId); return { kind: "refused", code: "batch_culprit_unassociated" }; },
      releaseGates: (root) => [`const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(join(root, "checked"))}, process.env.SLIPJAY_RELEASE_HEAD + "\\n");
        const failed = fs.existsSync("broken.txt");
        fs.writeFileSync(require("node:path").join(process.env.SLIPJAY_TEST_REPORT_DIR, "slipjay-test-reports.json"),
          JSON.stringify({ version: 1, reports: [], outcomes: [{ suite: "app", outcome: failed ? "failed" : "passed" }] }));
        if (failed) { console.error("FAIL tests/app.test.ts > app > verifies"); process.exit(1) }`] });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("broken.txt")));
    const culprit = f.main();
    await f.land(f.submit(await f.candidate("second.txt")));
    const head = f.main();
    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    await settle(f);
    const red = f.log.verifications(REPO, head)[0]!;
    assert.equal(red.status, "failed");
    assert.equal(s.prebuilt().filter((line) => line.includes(culprit)).length, 1);
    assert.deepEqual(routed, [culprit]);

    await f.land(f.submit(await f.candidate("third.txt")));
    await settle(f);
    const newest = f.main();
    const [check] = f.log.verifications(REPO, newest);
    assert.equal(check?.status, "failed");
    assert.equal(s.prebuilt().filter((line) => line.includes(culprit)).length, 1, "historical build was not spawned again");
    assert.equal((await f.lines("checked")).filter((line) => line === culprit).length, 1, "historical suite was not spawned again");
    assert.equal(s.prebuilt().filter((line) => line.includes(newest)).length, 2, "the head and its rerun are fresh");
    assert.equal((await f.lines("checked")).filter((line) => line === newest).length, 2);
    assert.deepEqual(routed, [culprit], "permanent refusal is not sent to Forge again");
    assert.deepEqual(alerts, configured ? [red.id] : [], "only a configured webhook sees the fresh refusal");
    const events = f.log.events({ operationId: check!.id }).map(({ event }) => event);
    assert.ok(events.some((event) => event.type === "progress" && event.line.includes("reusing cached diagnosis result")));
    assert.ok(events.some((event) => event.type === "batch_unrouted" && /already unassociated in batch check .* for app, prebuild/.test(event.reason)));
  } finally { await f.dispose(); }
}, 180_000);
