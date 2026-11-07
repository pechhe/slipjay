import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import type { OperationEvent } from "../../src/lib/runner/runner-types.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";

/**
 * YardSmith's batch command, in miniature: suite `workbench` fails while `break-a` is in the tree, and the check waits
 * while `hold` exists beside the fixture, so a test can catch it running.
 */
const batchCheck = (root: string) => `const fs=require("node:fs"), path=require("node:path"); const at=(name)=>path.join(${JSON.stringify(root)}, name);
fs.appendFileSync(at("batch-env.jsonl"), JSON.stringify({ head: process.env.SLIPJAY_RELEASE_HEAD, suites: process.env.SLIPJAY_RELEASE_SUITES ?? null }) + "\\n");
const wait = Date.now() + 60000; while (fs.existsSync(at("hold")) && Date.now() < wait) { fs.writeFileSync(at("held"), ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
const broken = fs.existsSync("break-a");
const reports = process.env.SLIPJAY_TEST_REPORT_DIR;
if (reports) fs.writeFileSync(path.join(reports, "slipjay-test-reports.json"), JSON.stringify({ version: 1, reports: [], outcomes: [{ suite: "workbench", outcome: broken ? "failed" : "passed" }] }));
if (broken) { process.stderr.write("FAIL tests/workbench.test.ts > workbench > a breaks\\n"); process.exit(1); }`;

/** As `batchCheck`, failing `workbench` once while `flaky-once` exists beside the fixture. */
const flakyOnce = (root: string) => batchCheck(root).replace(`const broken = fs.existsSync("break-a");`,
  `let broken = fs.existsSync("break-a"); if (fs.existsSync(at("flaky-once"))) { fs.rmSync(at("flaky-once")); broken = true; }`);

/** Promotions every ten hours, so only the background interval checks anything during a test. */
const schedule = { everyMinutes: 600, from: "00:00", until: "23:59", timeZone: "Europe/London" };
const MINUTE = 60_000;
const events = <T extends OperationEvent["type"]>(f: Awaited<ReturnType<typeof fixture>>, id: string, type: T) =>
  f.log.events({ operationId: id }).map((row) => row.event).filter((event): event is Extract<OperationEvent, { type: T }> => event.type === type);

test("a background check starts on its interval only when something new landed, never overlaps, diagnoses after the last green tip and routes a culprit once", async () => {
  let clock = Date.now();
  const requests: BatchCheckRecord[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [batchCheck(root)],
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

    // Once it has, the newest tip is checked in the background from the commit Production serves, and nothing promotes.
    clock = promotedAt + 21 * MINUTE;
    await f.queue.recover();
    await settle(f);
    const green = checks().find((entry) => entry.commitId === one)!;
    assert.equal(green.status, "verified");
    assert.ok(green.submittedBy.endsWith(":background"));
    const [started] = events(f, green.id, "batch_started");
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
    const [redStart] = events(f, red.id, "batch_started");
    assert.equal(redStart!.after, one, "diagnosis starts after the newest green-checked tip");
    assert.deepEqual(redStart!.landings.map((entry) => entry.commitId), [breaking!.commitId, two!.commitId]);
    const [outcome] = events(f, red.id, "batch_outcome");
    assert.deepEqual(outcome!.culprits!.map((culprit) => culprit.commitId), [breaking!.commitId]);
    const diagnosed = (await f.lines("batch-env.jsonl")).map((line) => JSON.parse(line) as { head: string; suites: string | null }).filter((entry) => entry.suites);
    assert.ok(!diagnosed.some((entry) => entry.head === one), "the green tip is not diagnosed again");
    await until(() => events(f, red.id, "batch_routed").length || undefined);
    assert.equal(requests.length, 1);

    // A known red head starts nothing until something new lands.
    clock = Date.parse(red.submittedAt) + 60 * MINUTE;
    await f.queue.recover();
    await settle(f);
    assert.equal(checks().length, 3);

    // The next landing is checked; it names the same culprit for the same suite, which is not routed again.
    await f.land(f.submit(await f.candidate("three.txt")));
    await settle(f);
    const three = f.main();
    const again = checks().find((entry) => entry.commitId === three)!;
    assert.equal(again.status, "failed");
    await until(() => events(f, again.id, "batch_unrouted").length || undefined);
    assert.match(events(f, again.id, "batch_unrouted")[0]!.reason, new RegExp(`already routed by batch check ${red.id}`));
    assert.equal(requests.length, 1);
    assert.ok(!checks().some((a) => checks().some((b) => a !== b && a.status === "running" && b.status === "running")), "never two at once");
  } finally { await f.dispose(); }
}, 300_000);

test("a release the owner pushes stops a running background check, which ends stopped, routes nothing and is checked again later", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [batchCheck(root)],
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
    const [outcome] = events(f, background.id, "batch_outcome");
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
    { process: "development", promotionSchedule: schedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [batchCheck(root)] });
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

/** As `batchCheck`, with a second suite, `ledger`, that `break-a` also breaks. */
const twoSuites = (root: string) => batchCheck(root).replace(
  `outcomes: [{ suite: "workbench", outcome: broken ? "failed" : "passed" }]`,
  `outcomes: [{ suite: "workbench", outcome: broken ? "failed" : "passed" }, { suite: "ledger", outcome: broken ? "failed" : "passed" }]`);

test("a culprit already routed for one suite is routed again only for the suite it newly breaks", async () => {
  let clock = Date.now();
  const requests: BatchCheckRecord[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [twoSuites(root)],
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
    await until(() => events(f, red.id, "batch_routed").length || undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]!.failedSuites, ["ledger"], "only the suite not routed before is sent");
  } finally { await f.dispose(); }
}, 300_000);

test("a background check that ends flaky is checked again on the interval, without waiting for a new landing", async () => {
  let clock = Date.now();
  let routed = 0;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule, now: () => clock, batchVerification: { machine: "batch", everyMinutes: 20 }, releaseGates: (root) => [flakyOnce(root)],
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
    clock = promotedAt + 21 * MINUTE;
    await f.queue.recover();
    await settle(f);
    // Nothing new has landed, yet the head is checked again (at once here: the test clock is already past the next
    // interval), and the second check passes.
    await until(() => f.log.verifications(REPO).some((entry) => entry.commitId === one && entry.status === "verified") || undefined);
    const [first, second] = f.log.verifications(REPO).filter((entry) => entry.commitId === one).reverse();
    assert.equal(events(f, first!.id, "batch_outcome")[0]!.outcome, "flaky");
    assert.ok(second!.submittedBy.endsWith(":background"));
    assert.equal(events(f, second!.id, "batch_outcome")[0]!.outcome, "green");
    assert.equal(f.log.verifications(REPO).filter((entry) => entry.commitId === one).length, 2);
    assert.equal(routed, 0);
  } finally { await f.dispose(); }
}, 300_000);
