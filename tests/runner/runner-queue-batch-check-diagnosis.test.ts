import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/queue-batch-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import type { BatchCheckRecord } from "../../src/lib/release/batch-check.ts";
import type { BuildRouteAnswer } from "../../src/lib/build/build-admission.ts";
import type { OperationEvent, ReleaseAlertPayload } from "../../src/lib/runner/runner-types.ts";
import { batchCheck } from "./fixtures/batch-check-fixture.ts";

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
      await f.seedLanded({ [file]: `${file}\n` }, `Add ${file}`);
      landings.push(f.log.landings(REPO).at(-1)!.operationId);
    }
    await settle(f);
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
