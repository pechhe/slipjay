import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import type { BuildRouteAnswer } from "../../src/lib/build/build-admission.ts";
import type { OperationEvent, RemoteVerification } from "../../src/lib/runner/runner-types.ts";

/**
 * YardSmith's batch command, in miniature: one suite, `workbench`, which fails while landing 2's regression is in the
 * tree and unrepaired, or landing 4's is; once only while `flaky-once` exists beside the fixture. It reports the suite's
 * outcome in its test-report manifest and records the release environment it was given.
 */
const batchCheck = (root: string) => `const fs=require("node:fs"), path=require("node:path"); const at=(name)=>path.join(${JSON.stringify(root)}, name);
fs.appendFileSync(at("batch-env.jsonl"), JSON.stringify({ base: process.env.SLIPJAY_RELEASE_BASE, head: process.env.SLIPJAY_RELEASE_HEAD, suites: process.env.SLIPJAY_RELEASE_SUITES ?? null }) + "\\n");
let broken = (fs.existsSync("break-a") && !fs.existsSync("fix-a")) || fs.existsSync("break-b");
if (fs.existsSync(at("flaky-once"))) { fs.rmSync(at("flaky-once")); broken = true; }
const reports = process.env.SLIPJAY_TEST_REPORT_DIR;
if (reports) fs.writeFileSync(path.join(reports, "slipjay-test-reports.json"), JSON.stringify({ version: 1, reports: [], outcomes: [{ suite: "workbench", outcome: broken ? "failed" : "passed" }] }));
if (broken) { process.stderr.write("FAIL tests/workbench.test.ts > workbench > " + (fs.existsSync("break-b") ? "b" : "a") + " breaks\\n"); process.exit(1); }`;

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
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)], recordBatchCheck });
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
    for (const file of ["one.txt", "break-a", "fix-a", "break-b", "needs-a.txt"]) {
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
    assert.deepEqual(outcome!.culprits!.map((culprit) => culprit.failingTests), [["tests/workbench.test.ts > workbench > a breaks"], ["tests/workbench.test.ts > workbench > b breaks"]]);
    assert.equal(outcome!.shorterCandidate, commits[0]);
    // Only the failing suite reran at each landing, measured from the same base.
    const env = (await f.lines("batch-env.jsonl")).map((line) => JSON.parse(line) as { base: string; head: string; suites: string | null });
    assert.deepEqual(env.filter((entry) => entry.suites === "workbench").map((entry) => entry.head), [commits[4], ...commits.slice(0, 4)]);
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
