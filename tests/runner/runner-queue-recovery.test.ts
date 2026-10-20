import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES, recoveryKey } from "../../src/lib/runner/runner-contract.ts";
import { test, jj, fixture, until } from "./fixtures/runner-queue-fixture.ts";

test("recovery fails interrupted verification and leaves queued operations for wake", async () => {
  const f = await fixture();
  try {
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    const queued = f.submit(await f.candidate("queued.txt"));
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "verifying", reason: "runner restarted during verifying; land again" });
    assert.equal(f.log.operation(queued)!.status, "queued");
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(queued)?.type, "landed", JSON.stringify(f.result(queued)));
  } finally { await f.dispose(); }
}, 120_000);

test("restart recovery closes both interrupted lanes once, preserves a pause and leaves unrelated queued work recoverable", async () => {
  const f = await fixture(false, true, undefined, false, { other: true });
  try {
    const integration = f.main();
    const releaseBase = f.releaseRef();
    const candidate = await f.candidate("interrupted.txt");
    const landing = f.submit(candidate);
    const release = f.submitRelease(integration);
    const other = f.submit(await f.candidate("queued.txt", f.otherAuthor, "fixture/other"));
    f.log.append(landing, { type: "stage", stage: "verifying" });
    f.log.append(release, { type: "stage", stage: "verifying" });
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    await f.queue.recover();
    await f.queue.recover();
    for (const id of [landing, release]) {
      assert.equal(f.result(id)?.type, "failed");
      assert.equal(f.log.events({ operationId: id }).filter(({ event }) => TERMINAL_EVENT_TYPES.includes(event.type as never)).length, 1);
    }
    assert.equal(f.main(), integration);
    assert.equal(f.releaseRef(), releaseBase);
    assert.equal(f.log.operation(other)!.stage, "paused");
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(other)!.status, "queued");
    // Recovery never invents a source retry or publication for either interrupted operation.
    assert.equal(jj(f.author, ["--ignore-working-copy", "log", "-r", candidate.commitId, "--no-graph", "-T", "commit_id"]), candidate.commitId);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    assert.equal((await f.land(other))?.type, "landed");
    assert.equal(f.result(landing)?.type, "failed");
    assert.equal(f.result(release)?.type, "failed");
  } finally { await f.dispose(); }
}, 120_000);

test("recovery recognizes an integrated commit published before the runner stopped", async () => {
  const f = await fixture();
  try {
    const request = await f.candidate("published.txt");
    const original = f.submit(request);
    f.queue.wake(); await f.queue.idle();
    const landed = f.result(original);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    if (landed?.type !== "landed") throw new Error("Expected publication");
    const interrupted = f.submit(request);
    f.log.append(interrupted, { type: "stage", stage: "publishing" });
    f.log.append(interrupted, { type: "integrated", base: landed.base, commitId: landed.commitId });
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["git", "remote", "set-url", "origin", join(f.root, "unavailable-origin.git")]);
    try {
      await f.queue.recover();
      // The unreachable remote ends the recovery it queued at the fetch, before it touches the hold.
      await f.queue.idle();
      assert.deepEqual(f.result(interrupted), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
      const [hold] = f.log.snapshot(f.executor.host).held;
      assert.ok(hold);
      assert.equal(hold.repo, "fixture/repo");
      assert.equal(hold.commitId, landed.commitId);
      assert.match(hold.reason, /unconfirmed/);
      assert.equal(f.log.openOperations().length, 0);
      await f.queue.recover();
      await f.queue.idle();
      assert.deepEqual(f.log.snapshot(f.executor.host).held, [hold]);
    } finally {
      jj(checkout, ["git", "remote", "set-url", "origin", f.origin]);
    }
    await f.queue.recover();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    const recovering = f.submit(request);
    f.log.append(recovering, { type: "stage", stage: "publishing" });
    f.log.append(recovering, { type: "integrated", base: landed.base, commitId: landed.commitId });
    await f.queue.recover();
    assert.deepEqual(f.result(recovering), landed);
    const unpublished = f.submit(request);
    f.log.append(unpublished, { type: "stage", stage: "publishing" });
    f.log.append(unpublished, { type: "integrated", base: landed.base, commitId: "f".repeat(40) });
    await f.queue.recover();
    assert.deepEqual(f.result(unpublished), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
  } finally { await f.dispose(); }
}, 120_000);

const recoveriesOf = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.log.events().filter((row) => row.event.type === "submitted" && row.event.kind === "recovery").map((row) => f.log.operation(row.operationId)!);

test("a restart publishes the integration a landing left held, with no further submission", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("stranded.txt");
    await writeFile(join(f.root, "reject-push"), "");
    const stranded = f.submit(request);
    const failure = await f.land(stranded);
    assert.equal(failure?.type === "failed" && failure.stage, "publishing", JSON.stringify(failure));
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    assert.equal(f.main(), before);
    // Nothing is queued and the remote is back: the restart alone has to publish it.
    await rm(join(f.root, "reject-push"));
    assert.equal(f.log.openOperations().length, 0);
    await f.queue.recover();
    await f.queue.idle();
    assert.equal(f.main(), hold.commitId);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    const [recovery, ...rest] = recoveriesOf(f);
    assert.deepEqual(rest, []);
    assert.equal(recovery?.result?.type, "landed", JSON.stringify(recovery));
    assert.equal(recovery?.result?.type === "landed" && recovery.result.commitId, hold.commitId);
    // The failed landing keeps its verdict; Build learns the publication from the confirmation recorded after it.
    assert.equal(f.result(stranded)?.type, "failed");
    const confirmations = f.log.publicationRecoveries().get(recoveryKey("fixture/repo", hold.commitId)) ?? [];
    const failedAt = f.log.events({ operationId: stranded }).find((row) => row.event.type === "failed")!.seq;
    assert.ok(confirmations.some((row) => row.seq > failedAt));
    // A second restart finds nothing held.
    await f.queue.recover();
    await f.queue.idle();
    assert.equal(recoveriesOf(f).length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a hold whose commit a person discarded is released, and the commit lands again as an ordinary submission", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("discarded.txt");
    await writeFile(join(f.root, "reject-push"), "");
    const stranded = f.submit(request);
    const failure = await f.land(stranded);
    assert.equal(failure?.type === "failed" && failure.stage, "publishing", JSON.stringify(failure));
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    // The README's manual fix: the runner checkout's bookmark goes back to the remote, discarding the integration.
    await rm(join(f.root, "reject-push"));
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["bookmark", "set", "main", "-r", "main@origin", "--allow-backwards"]);
    jj(checkout, ["abandon", `${hold.commitId}`]);
    assert.equal(f.main(), before);
    await f.queue.recover();
    await f.queue.idle();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    const [recovery, ...rest] = recoveriesOf(f);
    assert.deepEqual(rest, []);
    assert.equal(recovery?.result?.type, "cancelled", JSON.stringify(recovery));
    assert.ok(f.log.events({ operationId: recovery!.id }).some((row) => row.event.type === "integration_released" && row.event.commitId === hold.commitId));
    // Nothing is held, so the reland is not sent back to a recovery: it is submitted and lands.
    assert.equal(f.queue.recoverHeld("fixture/repo"), null);
    const again = f.submit(await f.candidate("discarded-again.txt"));
    assert.equal((await f.land(again))?.type, "landed");
    assert.equal(recoveriesOf(f).length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a recovery that fails is queued again until it publishes, with no submission", async () => {
  const f = await fixture(false, false, undefined, false, { recoveryRetryMs: 100 });
  try {
    const request = await f.candidate("retried.txt");
    await writeFile(join(f.root, "reject-push"), "");
    const failure = await f.land(f.submit(request));
    assert.equal(failure?.type === "failed" && failure.stage, "publishing", JSON.stringify(failure));
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    // The remote still refuses the push, so the restart's recovery fails and the hold stays.
    await f.queue.recover();
    await f.queue.idle();
    assert.equal(recoveriesOf(f)[0]?.result?.type, "failed");
    assert.equal(f.log.snapshot(f.executor.host).held.length, 1);
    // The remote comes back: the runner retries by itself.
    await rm(join(f.root, "reject-push"));
    await until(() => f.log.snapshot(f.executor.host).held.length === 0 || undefined);
    await f.queue.idle();
    assert.equal(f.main(), hold.commitId);
    assert.ok(recoveriesOf(f).length >= 2);
    assert.equal(recoveriesOf(f).at(-1)?.result?.type, "landed");
  } finally { await f.dispose(); }
}, 120_000);

test("a recovery interrupted by a restart queues again, and ends cancelled when nothing is held", async () => {
  const f = await fixture();
  try {
    const recovery = "recovery-interrupted";
    f.log.append(recovery, { type: "submitted", kind: "recovery", repo: "fixture/repo", commitId: "f".repeat(40), submittedBy: `${f.executor.host}:recovery` });
    f.log.append(recovery, { type: "stage", stage: "finalizing" });
    assert.equal(f.log.operation(recovery)!.status, "running");
    await f.queue.recover();
    await f.queue.idle();
    assert.equal(f.log.operation(recovery)!.result?.type, "cancelled", JSON.stringify(f.log.operation(recovery)));
  } finally { await f.dispose(); }
}, 120_000);

test("draining waits for a landing that is finalizing and admits nothing new", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    const first = f.submit(await f.candidate("schema/draining.ts"));
    f.queue.wake();
    await until(() => f.log.operation(first)!.stage === "finalizing" || undefined);
    let drained = false;
    const draining = f.queue.drain().then(() => { drained = true; });
    const behind = f.submit(await f.candidate("behind.txt"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(drained, false);
    await rm(join(f.root, "hold-finalize"));
    await draining;
    assert.equal(f.result(first)?.type, "landed", JSON.stringify(f.result(first)));
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(behind)!.status, "queued");
  } finally { await f.dispose(); }
}, 120_000);
