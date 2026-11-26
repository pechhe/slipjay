import assert from "node:assert/strict";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { landingOutcome } from "../../src/lib/landing/landing-outcome.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";
import { controlledRemote, events } from "./fixtures/screening-fixture.ts";

test("a screen behind a failing screen screens again on the tip; only the pass publishes, once", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const base = f.main();
    const failed = f.submit(await f.candidate("fail"));
    const passed = f.submit(await f.candidate("pass.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.deepEqual(r.opened.map((entry) => entry.screening), [true, true]);
    assert.notEqual(r.opened[0]!.slot, r.opened[1]!.slot);
    assert.equal(r.opened[0]!.base, base);
    assert.ok(r.opened[1]!.files.includes("fail"), "the second screen runs behind the first");
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(failed)?.type, "failed");
    assert.equal(f.result(passed)?.type, "landed", JSON.stringify(f.result(passed)));
    assert.equal(r.opened.length, 3);
    assert.equal(r.opened[2]!.screening, true);
    assert.equal(r.opened[2]!.base, base);
    assert.ok(!r.opened[2]!.files.includes("fail"), "the fresh screen runs on the tip alone");
    const failedEvents = events(f, failed);
    assert.ok(!failedEvents.some((event) => event.type === "publication_intent"));
    assert.equal(failedEvents.find((event) => event.type === "classified")?.cause, "gate");
    const passedEvents = events(f, passed);
    assert.ok(passedEvents.some((event) => event.type === "yielded"), "its result behind the failed screen is not its verdict");
    assert.ok(!passedEvents.some((event) => event.type === "classified"));
    assert.equal(passedEvents.find((event) => event.type === "screen_reused")?.base, base);
    assert.equal(r.closed.length, 3);
    const metrics = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z");
    assert.ok((landingOutcome(f.log.operation(passed)! as import("../../src/lib/runner/runner-types.ts").LandingOperation, f.log.events()).screening?.durationMs ?? -1) >= 0);
    assert.ok(metrics.groups.find((group) => group.kind === "landing")?.stages.screening);
    assert.equal(f.log.events().filter(({ event }) => event.type === "publication_intent").length, 1);
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a passed screen publishes while another repository's gate holds every worker", async () => {
  const r = controlledRemote();
  const holdingGate = (root: string) => `const fs=require("node:fs");while(fs.existsSync(${JSON.stringify(join(root, "hold-gates"))})&&!fs.existsSync("unheld"))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);`;
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, other: true, remoteVerification: r.remote, gates: (root) => [holdingGate(root)] });
  const holdFile = join(f.root, "hold-gates");
  try {
    await writeFile(holdFile, "");
    const screen = f.submit(await f.candidate("unheld"));
    f.queue.wake();
    await until(() => r.opened.length === 1 || undefined);
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await until(() => f.log.operation(other)?.status === "running" || undefined);
    r.releaseAll();
    await until(() => f.result(screen) || undefined);
    assert.equal(f.result(screen)?.type, "landed", JSON.stringify(f.result(screen)));
    assert.equal(f.result(other), undefined, "the other repository's gate still holds the only worker");
    await rm(holdFile, { force: true });
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
  } finally { r.releaseAll(); await rm(holdFile, { force: true }); await f.dispose(); }
}, 120_000);

test("a screen behind a slower one waits for it, then publishes on its own screen with no second gate", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const slow = f.submit(await f.candidate("slow.txt"));
    const fast = f.submit(await f.candidate("fast.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    const behind = r.opened.find((entry) => entry.files.includes("fast.txt"))!;
    assert.ok(behind.files.includes("slow.txt"));
    behind.release();
    await until(() => f.log.operation(fast)?.stage === "waiting-for-predecessor" || undefined);
    assert.equal(f.result(fast), undefined);
    assert.equal(f.result(slow), undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(slow)?.type, "landed", JSON.stringify(f.result(slow)));
    assert.equal(f.result(fast)?.type, "landed", JSON.stringify(f.result(fast)));
    assert.equal(r.opened.length, 2, "neither landing ran its gate a second time");
    assert.deepEqual(f.log.events().filter(({ event }) => event.type === "landed").map((row) => row.operationId), [slow, fast]);
    const reused = events(f, fast).find((event) => event.type === "screen_reused");
    assert.equal(reused?.type === "screen_reused" ? reused.behind : undefined, slow);
    assert.match(reused?.type === "screen_reused" ? reused.reason : "", /predicted prefix/);
    assert.ok(!events(f, fast).some((event) => event.type === "attempt_invalidated"));
    assert.equal(f.remoteFile("slow.txt"), "slow.txt");
    assert.equal(f.remoteFile("fast.txt"), "fast.txt");
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a publication the prediction did not include re-gates a passed screen on the exact tip", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const id = f.submit(await f.candidate("screened.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 1 || undefined);
    const tip = await f.seedMain({ "elsewhere.txt": "elsewhere\n" });
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
    assert.equal(r.opened.length, 2);
    assert.equal(r.opened[1]!.screening, false);
    assert.equal(r.opened[1]!.base, tip);
    assert.ok(!events(f, id).some((event) => event.type === "screen_reused"));
  } finally { r.releaseAll(); await f.dispose(); }
});

test("zero screening lanes preserves the ordinary landing path", async () => {
  const r = controlledRemote();
  r.releaseAll();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 0, remoteVerification: r.remote });
  try {
    assert.equal((await f.land(f.submit(await f.candidate("ordinary.txt"))))?.type, "landed");
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0]!.screening, false);
    assert.ok(!f.log.events().some(({ event }) => event.type === "stage" && event.stage === "screening"));
  } finally { await f.dispose(); }
});
