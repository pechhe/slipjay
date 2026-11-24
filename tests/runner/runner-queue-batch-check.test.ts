import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test as serialTest } from "vite-plus/test";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import type { BuildRouteAnswer } from "../../src/lib/build/build-admission.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { OperationEvent, ReleaseAlertPayload, RemoteVerification } from "../../src/lib/runner/runner-types.ts";

/**
 * YardSmith's batch command in miniature: two independent suites fail when their respective break lands.
 * The workbench fails once while `flaky-once` exists. The command honors suite selection and records its environment.
 */
const batchCheck = (root: string) => `const fs=require("node:fs"), path=require("node:path"); const at=(name)=>path.join(${JSON.stringify(root)}, name);
const suites = process.env.SLIPJAY_RELEASE_SUITES ?? null;
fs.appendFileSync(at("batch-env.jsonl"), JSON.stringify({ base: process.env.SLIPJAY_RELEASE_BASE, head: process.env.SLIPJAY_RELEASE_HEAD, suites }) + "\\n");
let workbench = fs.existsSync("break-a");
if (fs.existsSync(at("flaky-once"))) { fs.rmSync(at("flaky-once")); workbench = true; }
const states = { workbench, yard: fs.existsSync("break-b") };
const outcomes = Object.entries(states).filter(([suite]) => !suites || suites.split(",").includes(suite))
  .map(([suite, broken]) => ({ suite, outcome: broken ? "failed" : "passed" }));
const reports = process.env.SLIPJAY_TEST_REPORT_DIR;
if (reports) fs.writeFileSync(path.join(reports, "slipjay-test-reports.json"), JSON.stringify({ version: 1, reports: [], outcomes }));
for (const { suite, outcome } of outcomes) if (outcome === "failed") {
  process.stderr.write("FAIL tests/" + suite + ".test.ts > " + suite + " > " + (suite === "yard" ? "b" : "a") + " breaks\\n");
  if (suite === "yard") {
    for (let n = 0; n < 40; n++) process.stderr.write("FAIL tests/yard.test.ts > yard > case " + n + "\\n");
    process.stderr.write("x".repeat(5000) + "\\n");
  }
  process.exitCode = 1;
}`;

const schedule = (everyMinutes: number) => ({ everyMinutes, from: "00:00", until: "23:59", timeZone: "Europe/London" });
const batchEvents = <T extends OperationEvent["type"]>(f: Awaited<ReturnType<typeof fixture>>, id: string, type: T) =>
  f.log.events({ operationId: id }).map((row) => row.event).filter((event): event is Extract<OperationEvent, { type: T }> => event.type === type);

/** A remote verifier whose machine runs each command here, in the runner's own checkout, as a warm boat VM would. */
function localRemote(): RemoteVerification {
  return {
    async open() {
      return { executor: { host: "boat:slipjay-fixture-repo-batch", run: runBoundedProcess }, machine: { verifier: "boat", id: "vm-1", name: "slipjay-fixture-repo-batch", size: "fixture", image: "fixture" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() {} };
    },
  };
}

test("a red five-landing batch names landings 2 and 4 separately, routes each once, and ships the part before them only after its own check", async () => {
  let clock = Date.now();
  const forge = new Map<string, BatchCheckRecord>();
  const requests: BatchCheckRecord[] = [];
  let unavailable = true;
  const alerts: ReleaseAlertPayload[] = [];
  const recordBatchCheck = async (record: BatchCheckRecord): Promise<BuildRouteAnswer> => {
    requests.push(record);
    // The first request is lost on its way, as an outage would lose it: the runner sends it again later.
    if (unavailable) { unavailable = false; return { kind: "unavailable", reason: "Build could not be reached" }; }
    if (record.culprit.operationId === landings[3]) return { kind: "refused", code: "batch_culprit_unassociated", message: "no Forge association" };
    const key = `${record.batchId}:${record.culprit.commitId}`;
    forge.set(key, forge.get(key) ?? record);
    return { kind: "accepted", value: { runId: `run-${key}`, specId: "spec-2", number: 2002, findingRef: "batch-regression", noteId: "note-2" } };
  };
  const landings: string[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)], recordBatchCheck,
      releaseAlertWebhook: { url: "https://example.test/release" },
      sendReleaseAlert: async (url, payload, timeout) => {
        assert.equal(url, "https://example.test/release");
        assert.equal(timeout, 10_000);
        alerts.push(payload);
        throw new Error("webhook not reachable");
      } });
  try {
    // Nothing promoted yet: the first landing's batch is due at once, passes and ships.
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const zero = f.main();
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [zero]);
    await until(() => f.log.deployments(REPO, "production").find((entry) => entry.result?.type === "deployed") ?? undefined);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);

    // Five landings inside the interval: none queues a check of its own.
    clock = promotedAt + 60_000;
    for (const file of ["one.txt", "break-a", "three.txt", "break-b", "needs-a.txt"]) {
      const id = f.submit(await f.candidate(file));
      await f.land(id);
      landings.push(id);
      await settle(f);
    }
    assert.equal(f.log.verifications(REPO).length, 1, "only the first batch was checked");
    const commits = landings.map((id) => (f.log.operation(id)!.result as Extract<OperationEvent, { type: "landed" }>).commitId);

    // The promotion falls due: the frozen head is checked once, then diagnosed.
    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    await settle(f);
    const red = f.log.verifications(REPO).find((entry) => entry.commitId === commits[4])!;
    assert.equal(red.status, "failed");
    const [started] = batchEvents(f, red.id, "batch_started");
    assert.equal(started!.base, zero, "measured from the commit Production serves");
    assert.deepEqual(started!.landings.map((entry) => entry.operationId), landings);
    const [outcome] = batchEvents(f, red.id, "batch_outcome");
    assert.equal(outcome!.outcome, "red");
    assert.deepEqual(outcome!.culprits!.map((culprit) => culprit.operationId), [landings[1], landings[3]]);
    assert.deepEqual(outcome!.culprits![0]!.failingTests, ["tests/workbench.test.ts > workbench > a breaks"]);
    assert.ok(outcome!.culprits![1]!.failingTests.includes("tests/yard.test.ts > yard > b breaks"));
    assert.equal(outcome!.shorterCandidate, commits[0]);
    // The rerun and first probe share both suites; later probes narrow to one suite, all from the same base.
    const env = (await f.lines("batch-env.jsonl")).map((line) => JSON.parse(line) as { base: string; head: string; suites: string | null });
    assert.deepEqual(env.filter((entry) => entry.suites !== null).map((entry) => [entry.head, entry.suites]), [
      [commits[4], "workbench,yard"], [commits[1], "workbench,yard"], [commits[2], "yard"],
      [commits[0], "workbench"], [commits[3], "yard"],
    ]);
    assert.ok(env.every((entry) => entry.head === zero || entry.base === zero));

    // Diagnosis promoted nothing: the commit before landing 2 shipped only once its own complete check passed.
    const shorter = f.log.verifications(REPO).find((entry) => entry.commitId === commits[0])!;
    assert.equal(shorter.result?.type, "verified");
    const release = f.log.releases(REPO)[0]!;
    assert.equal(release.commitId, commits[0]);
    assert.ok(Date.parse(release.submittedAt) >= Date.parse(shorter.finishedAt!));
    assert.ok(!f.log.releases(REPO).some((entry) => commits.slice(1).includes(entry.commitId)));

    // The lost request is sent again at the next start; each culprit is answered once, and a restart sends nothing more.
    await f.queue.recover();
    await settle(f);
    await until(() => batchEvents(f, red.id, "batch_routed").length + batchEvents(f, red.id, "batch_unrouted").length === 2 || undefined);
    await f.queue.recover();
    await settle(f);
    assert.equal(requests.length, 3);
    assert.equal(forge.size, 1);
    assert.deepEqual(batchEvents(f, red.id, "batch_routed").map((event) => [event.operationId, event.number, event.noteId]), [[landings[1], 2002, "note-2"]]);
    const [unrouted] = batchEvents(f, red.id, "batch_unrouted");
    assert.equal(unrouted!.operationId, landings[3]);
    assert.match(unrouted!.reason, /batch_culprit_unassociated/);
    assert.equal(requests[0]!.base, zero);
    assert.equal(requests[0]!.head, commits[4]);
    assert.equal(alerts.length, 1);
    const alert = alerts[0]!;
    assert.equal(alert.event, "batch_culprit_unassociated");
    assert.equal(alert.source, "slipjay-runner");
    assert.equal(alert.repo, REPO);
    assert.equal(alert.operationId, red.id);
    assert.equal(alert.headCommitId, commits[4]);
    assert.deepEqual(alert.suites, ["yard"]);
    assert.equal(alert.logCommand, `slipjay runner log ${red.id}`);
    assert.ok(Number.isFinite(Date.parse(alert.timestamp)));
    assert.deepEqual(alert.culprit, { commitId: commits[3], operationId: landings[3] });
    assert.equal(alert.command, outcome!.culprits![1]!.command);
    assert.equal(alert.failingTests.length, 30);
    assert.equal(alert.output.length, 4_000);
  } finally { await f.dispose(); }
}, 300_000);

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

test("a batch machine that never becomes ready is infrastructure: checked again a bounded number of times, never routed or promoted", async () => {
  let routed = 0;
  const unavailable: RemoteVerification = { async open() { throw Object.assign(new Error("Remote executor unavailable (boat): slipjay-fixture-repo-batch not reachable"), { machineUnavailable: true }); } };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      batchRemote: unavailable, recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const checks = f.log.verifications(REPO);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.equal(check.status, "failed");
      assert.deepEqual(batchEvents(f, check.id, "batch_outcome").map((event) => event.outcome), ["infrastructure"]);
      assert.match((check.result as { reason: string }).reason, /infrastructure, not a regression/);
    }
    assert.equal(routed, 0);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 300_000);

test("a batch check that changes the source it runs on is not evidence: the head fails and nothing ships", async () => {
  const edits = `require("node:fs").writeFileSync("zero.txt", "edited by the check\\n");`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "batch" }, releaseGates: () => [edits],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const [check] = f.log.verifications(REPO);
    assert.equal(check!.status, "failed");
    assert.match((check!.result as { reason: string }).reason, /not evidence for it: The release checks changed the source/);
    assert.deepEqual(batchEvents(f, check!.id, "batch_outcome").map((event) => event.outcome), ["infrastructure"]);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 300_000);

test("a confirm's batch check runs now, before the schedule is due, and a passed one stands for the next confirm", async () => {
  let clock = Date.now();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const head = f.main();
    assert.equal(f.log.verifications(REPO).filter((entry) => entry.commitId === head).length, 0, "the schedule is not due yet");

    const asked = await f.queue.requestBatchCheck(REPO, head);
    assert.equal(asked?.requested, true);
    await settle(f);
    const [check] = f.log.verifications(REPO).filter((entry) => entry.commitId === head);
    assert.equal(check!.status, "verified");
    assert.ok(check!.submittedBy.endsWith(":confirm"));
    assert.equal(batchEvents(f, check!.id, "batch_started")[0]!.scheduled, false);
    const again = await f.queue.requestBatchCheck(REPO, head);
    assert.deepEqual([again?.requested, again?.operation.id], [false, check!.id]);
  } finally { await f.dispose(); }
}, 300_000);

test("a confirm after another promotion does not reuse a check measured from the old base: it checks the commit again from the new one", async () => {
  let clock = Date.now();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const zero = f.main();
    clock = Date.parse(f.log.releases(REPO)[0]!.submittedAt) + 60_000;
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const one = f.main();
    await f.queue.requestBatchCheck(REPO, one);
    await settle(f);
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const two = f.main();
    await f.queue.requestBatchCheck(REPO, two);
    await settle(f);
    const [old] = f.log.verifications(REPO).filter((entry) => entry.commitId === two);
    assert.equal(old!.status, "verified");
    assert.equal(batchEvents(f, old!.id, "batch_started")[0]!.base, zero);

    // The owner promotes `one` meanwhile: Production now serves it.
    f.log.append("op_00release_one_aaaaaaaaaaaaaaaa", { type: "submitted", kind: "release", repo: REPO, commitId: one, migrationsReady: false, submittedBy: "owner" });
    f.queue.wake();
    await settle(f);
    await until(() => f.log.deployments(REPO, "production").find((entry) => entry.commitId === one && entry.result?.type === "deployed") ?? undefined);

    const again = await f.queue.requestBatchCheck(REPO, two);
    assert.equal(again?.requested, true, "the check from the old base is stale");
    await settle(f);
    const fresh = f.log.verifications(REPO).find((entry) => entry.id === again!.operation.id)!;
    assert.equal(fresh.status, "verified");
    assert.equal(batchEvents(f, fresh.id, "batch_started")[0]!.base, one);
  } finally { await f.dispose(); }
}, 300_000);

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

// These preemption tests hold a check open while more landings run git/jj. Keep them out of
// this file's concurrent fixture group and give each queue transition room on a busy runner.
// After recovery explicitly wake admission; scheduling the batch is not evidence that its check has started.
const preemptionWaitMs = 120_000;

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

serialTest("a confirm stops an in-flight diagnosis without cancelling the red batch or superseding another confirm", async () => {
  let clock = Date.now();
  let heldCommit: string | undefined;
  let probeStarted = false;
  let batchId: string | undefined;
  let probeAborted = false;
  let probeClosed = false;
  const alerts: ReleaseAlertPayload[] = [];
  const remote = localRemote();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" },
      releaseGates: (root) => [batchCheck(root)],
      releaseAlertWebhook: { url: "https://example.test/release", timeoutMs: 1_000 },
      sendReleaseAlert: (_url, payload) => {
        alerts.push(payload);
        return new Promise<void>(() => {}); // A transport that never settles cannot stall the queue.
      },
      batchRemote: { async open(input) {
        const attempt = await remote.open(input);
        if (input.candidate !== heldCommit) return attempt;
        return { ...attempt,
          executor: { ...attempt.executor, async run(request) {
            if (!probeStarted && request.env?.SLIPJAY_RELEASE_SUITES) {
              probeStarted = true;
              if (!request.abortSignal!.aborted)
                await new Promise<void>((resolve) => request.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
              probeAborted = true;
              request.abortSignal!.throwIfAborted();
            }
            return attempt.executor.run(request);
          } },
          async close() { if (probeStarted) probeClosed = true; },
        };
      } } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("break-a")));
    const older = f.main();
    const second = f.submit(await f.candidate("second.txt"));
    await f.land(second);
    heldCommit = older;
    const head = f.main();
    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    f.queue.wake();
    const original = f.log.verifications(REPO, head).find((check) => check.submittedBy.endsWith(":batch"));
    assert.ok(original, "recovery schedules a batch for diagnosis");
    batchId = original.id;
    await until(() => {
      assert.equal(f.log.operation(original.id)?.result, undefined, "the batch has not ended before its diagnosis probe");
      return probeStarted || undefined;
    }, preemptionWaitMs);

    const third = f.submit(await f.candidate("third.txt"));
    f.queue.wake();
    await until(() => f.log.operation(third)?.result?.type === "landed" || undefined, preemptionWaitMs);
    const newest = f.main();
    const fourth = f.submit(await f.candidate("fourth.txt"));
    f.queue.wake();
    await until(() => f.log.operation(fourth)?.result?.type === "landed" || undefined, preemptionWaitMs);
    const latest = f.main();
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    const first = await f.queue.requestBatchCheck(REPO, newest);
    const next = await f.queue.requestBatchCheck(REPO, older);
    assert.ok(first?.requested && next?.requested);
    await until(() => f.log.operation(original.id)?.result, preemptionWaitMs);
    assert.equal(probeAborted, true);
    assert.equal(probeClosed, true);
    const [outcome] = batchEvents(f, original.id, "batch_outcome");
    assert.ok(outcome?.outcome === "red");
    assert.equal(outcome.diagnosis, "incomplete");
    assert.equal(outcome.shorterCandidate, null);
    assert.match(outcome.reason!, /diagnosis stopped for the release of/);
    assert.equal(f.log.operation(original.id)?.status, "failed");

    await f.queue.recover();
    const queued = f.log.verifications(REPO).filter((entry) => entry.status === "queued");
    assert.deepEqual(new Set(queued.map((entry) => entry.id)), new Set([first.operation.id, next.operation.id]));
    assert.equal(f.log.verifications(REPO, latest).length, 0, "the scheduled batch waits while confirms are queued");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    await settle(f);
    const sequence = (id: string) => f.log.events({ operationId: id }).find(({ event }) => event.type === "batch_started")!.seq;
    assert.ok(sequence(first.operation.id) < sequence(next.operation.id), "the newer requested commit still checks first");
    const originalAlerts = alerts.filter(({ operationId }) => operationId === original.id);
    assert.equal(originalAlerts.length, 1);
    const alert = originalAlerts[0]!;
    assert.equal(alert.event, "batch_unattributed");
    assert.equal(alert.headCommitId, head);
    assert.deepEqual(alert.suites, ["workbench"]);
    assert.deepEqual(alert.unattributed, outcome.unattributed);
  } finally {
    if (batchId && f.log.operation(batchId)?.status === "running") f.queue.kill(batchId);
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
