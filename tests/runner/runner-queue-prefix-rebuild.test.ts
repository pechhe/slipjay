import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, exactPrefixGate, dependentWaitingOnRebuild } from "./fixtures/runner-queue-fixture.ts";

test("depth-two dependent waiting on its predecessor's rebuild can be killed, and is not rebuilt", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    assert.equal(f.queue.kill(waiting.b).status, "killed", "the waiting dependent is still the owner's to stop");
    await until(() => f.result(waiting.b));
    assert.deepEqual(f.result(waiting.b), { type: "cancelled", reason: OWNER_KILL_REASON });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a killed dependent never rebuilds");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent waiting on its predecessor's rebuild does not rebuild once the runner is paused", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    const outcome = f.result(waiting.b);
    assert.ok(outcome?.type === "failed" && /predecessor invalidated/.test(outcome.reason), JSON.stringify(outcome));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a pause stops the rebuild");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent rebuilt behind a held predecessor lands on it once the hold publishes", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    await writeFile(join(f.root, "hold-a"), "");
    // B's rebuild first verifies on the remote tip, before the held A publishes under it.
    await writeFile(join(f.root, "a-gone"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    // The outage ends as soon as A is held: B's rebuild then finishes A first, and lands after it.
    unsubscribe = f.log.subscribe((row) => { if (row.operationId === a && row.event.type === "failed") rmSync(join(f.root, "reject-push"), { force: true }); });
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    await writeFile(join(f.root, "reject-push"), "");
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    const landed = f.result(b);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.main(), landed.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt", "the held predecessor published first");
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await rm(join(f.root, "reject-push"), { force: true }); await f.dispose(); }
}, 120_000);
