import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, hanging, started, stagesOf, seqOf } from "./fixtures/runner-queue-fixture.ts";

test("a release verifies its exact candidate in a checkout of its own while the repository's landings go on, then publishes the release branch", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    // The landing submitted behind the release lands while the release is still verifying.
    const behind = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.result(behind));
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
    assert.equal(f.log.operation(release)!.stage, "verifying");
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.equal(f.releaseRef(), outcome.result.merge);
    assert.deepEqual(f.parents(outcome.result.merge), [base, candidate], "the pinned candidate, not the newer integration");
    assert.deepEqual(stagesOf(f, release), ["fetching", "installing", "verifying", "publishing", "finalizing"]);
    // The check ran once, through the executor, in the runner's release checkout.
    assert.deepEqual(await f.lines("release-verified.log"), [join(f.home, "releases", "fixture/repo")]);
    assert.equal(f.log.operation(release)!.runs.length, 1);
    assert.equal(f.log.operation(release)!.runs[0]!.exitCode, 0);
  } finally { await f.dispose(); }
}, 120_000);

test("a verified release publishes only after the repository's running landing, and says it is waiting", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(() => f.log.events({ operationId: release }).some((stored) => stored.event.type === "progress" && /^Verified; publishing after /.test(stored.event.line)) || undefined);
    assert.equal(f.releaseRef(), base, "nothing publishes while the landing holds the repository lane");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(stuck)?.type, "cancelled");
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.deepEqual(f.parents(f.releaseRef()), [base, candidate]);
  } finally { await f.dispose(); }
}, 120_000);

test("a release killed while it waits for the repository's running landing publishes nothing when the landing ends", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(() => f.log.events({ operationId: release }).some((stored) => stored.event.type === "progress" && /^Verified; publishing after /.test(stored.event.line)) || undefined);
    assert.equal(f.queue.kill(release).status, "killed");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.deepEqual(f.result(release), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.result(stuck)?.type, "cancelled");
    assert.equal(f.releaseRef(), base, "a killed release publishes nothing once the lane frees");
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("a pause lets a verifying release publish but admits no new landing until resumed", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const behind = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    assert.equal(f.log.operation(behind)!.stage, "paused");
    await rm(join(f.root, "hold-release"));
    await until(() => f.result(release));
    assert.equal(f.result(release)?.type, "released", JSON.stringify(f.result(release)));
    assert.equal(f.log.operation(behind)!.status, "queued", "the pause still holds the landing");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
  } finally { await f.dispose(); }
}, 120_000);

/** The log position of `id`'s first event of `type`. */
test("a release of a repository in a shared lane verifies only once the lane's running landing has finished", async () => {
  const f = await fixture(false, true, undefined, false, { other: true, lane: "shared-database" });
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const request = await hanging(f, pids, f.otherAuthor, "fixture/other");
    const stuck = f.submit(request);
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    assert.equal(f.log.operation(release)!.waitingFor, `landing ${request.changeId.slice(0, 12)}`);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.equal(f.releaseRef(), outcome.result.merge);
    assert.deepEqual(f.parents(f.releaseRef()), [base, candidate]);
    assert.ok(seqOf(f, release, "stage") > seqOf(f, stuck, "cancelled"), "the release started after the shared lane's landing ended");
  } finally { await f.dispose(); }
}, 120_000);
