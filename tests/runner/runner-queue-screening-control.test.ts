import assert from "node:assert/strict";
import { createRunnerQueue } from "../../src/lib/runner/runner-queue.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";
import { controlledRemote } from "./fixtures/screening-fixture.ts";

for (const control of ["kill", "supersede"] as const) test(`${control} during screening stops its own lease and re-screens the one behind it`, async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const stopped = f.submit(await f.candidate("stopped.txt"));
    const survivor = f.submit(await f.candidate("survivor.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    if (control === "kill") assert.equal(f.queue.kill(stopped).status, "killed");
    else f.log.append(stopped, { type: "superseded", by: "replacement" });
    // The survivor ran behind the stopped screen, so it screens again on the tip.
    await until(() => r.opened.length === 3 || undefined);
    assert.equal(f.result(survivor), undefined);
    assert.ok(!r.opened[2]!.files.includes("stopped.txt"));
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(stopped)?.type, control === "kill" ? "cancelled" : "superseded");
    assert.equal(f.result(survivor)?.type, "landed");
    assert.equal(r.closed.length, 3);
    assert.equal(f.log.events({ operationId: stopped }).filter(({ event }) => event.type === "publication_intent").length, 0);
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a pause lets a screen finish but prevents authoritative admission until resume", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 1, workers: 1, remoteVerification: r.remote });
  try {
    const id = f.submit(await f.candidate("paused.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 1 || undefined);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    r.releaseAll();
    await until(() => f.log.operation(id)?.stage === "waiting-for-predecessor" || undefined);
    assert.equal(r.closed.length, 1);
    assert.equal(f.result(id), undefined);
    assert.ok(!f.log.events().some(({ event }) => event.type === "publication_intent"));
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.result(id)?.type, "landed");
    assert.equal(r.opened.length, 1);
  } finally { r.releaseAll(); f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "cleanup" }); f.queue.wake(); await f.dispose(); }
});

test("restart during a screen recovers remote leases and records an interrupted outcome without publication", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  let recovered: readonly string[] = [];
  r.remote.recover = async (repos) => { recovered = repos; };
  let restarted: ReturnType<typeof createRunnerQueue> | undefined;
  try {
    const id = f.submit(await f.candidate("restart.txt"));
    // The prior process died with a durable stage, before any publication intent.
    f.log.append(id, { type: "stage", stage: "screening" });
    f.queue.close();
    restarted = createRunnerQueue({ log: f.log, executor: f.executor, home: f.home,
      config: { repos: { "fixture/repo": { url: f.origin, verifier: "boat", screeningLanes: 3 } } }, remoteVerification: r.remote });
    // Paused, so the requeued landing waits instead of opening a fresh screen this test would have to release.
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    await restarted.recover();
    await restarted.idle();
    assert.deepEqual(recovered, ["fixture/repo"]);
    // It had not integrated, so it waits in the queue for a fresh screen.
    assert.equal(f.log.operation(id)?.status, "queued");
    assert.equal(f.result(id), undefined);
    assert.ok(!f.log.events({ operationId: id }).some(({ event }) => event.type === "publication_intent"));
  } finally { r.releaseAll(); restarted?.close(); await restarted?.idle(); await f.dispose(); }
});
