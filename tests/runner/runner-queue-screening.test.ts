import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, rm, writeFile } from "node:fs/promises";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { createRunnerQueue } from "../../src/lib/runner/runner-queue.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { landingOutcome } from "../../src/lib/landing/landing-outcome.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { fixture, jj, test, until } from "./fixtures/runner-queue-fixture.ts";

function controlledRemote() {
  const opened: { slot: number; screening?: boolean; base: string; candidate: string; files: string[]; release(): void }[] = [];
  const closed: string[] = [];
  let hold = true;
  const remote: RemoteVerification = {
    async open(input) {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const entry = { ...input, files: await readdir(input.checkout), release };
      opened.push(entry);
      const name = `fake-${input.screening ? "screen" : "authoritative"}-${input.slot}`;
      return {
        machine: { verifier: "boat", id: name, name, size: "large", image: "image" }, tree: "tree", usage: null,
        executor: { host: name, async run(request) {
          if (hold) await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("cancelled"));
            request.abortSignal?.addEventListener("abort", abort, { once: true });
            if (request.abortSignal?.aborted) abort();
            void ready.then(() => { request.abortSignal?.removeEventListener("abort", abort); resolve(); });
          });
          return runBoundedProcess(request);
        } },
        finish: async () => ({ tree: "tree", trackedChanges: 0, usage: null }),
        close: async () => { closed.push(name); },
      };
    },
  };
  return { remote, opened, closed, releaseAll() { hold = false; for (const entry of opened) entry.release(); } };
}

const events = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.log.events({ operationId: id }).map(({ event }) => event);

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

test("a screen that conflicts with the screen ahead screens on the tip alone, and restarts on the new tip once that one lands", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const base = f.main();
    const ahead = f.submit(await f.candidate("shared.txt"));
    jj(f.author, ["new", "-m", "Rewrite shared.txt", "main@origin"]);
    await writeFile(join(f.author, "shared.txt"), "conflicting\n");
    const conflicting = f.submit(await f.push());
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.equal(r.opened[1]!.base, base, "the conflicting landing screens on the tip");
    r.opened[0]!.release();
    await until(() => f.result(ahead) || undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(ahead)?.type, "landed");
    const outcome = f.result(conflicting);
    assert.equal(outcome?.type, "failed", JSON.stringify(outcome));
    assert.match(outcome?.type === "failed" ? outcome.reason : "", /conflict/i);
    const starts = events(f, conflicting).filter((event) => event.type === "screen_started");
    // Behind the one ahead, then on the tip alone (the conflict), then once more on the tip it published.
    assert.equal(starts.length, 3);
    assert.equal(starts[0]?.type === "screen_started" ? starts[0].behind : undefined, ahead);
    assert.equal(starts[1]?.type === "screen_started" ? starts[1].behind : "x", undefined);
    assert.ok(events(f, conflicting).some((event) => event.type === "yielded" && event.to === "the moved integration tip"));
    assert.ok(events(f, conflicting).some((event) => event.type === "attempt_invalidated" && new RegExp(`${ahead} published past this screen's base`).test(event.reason)),
      "its screen on the old tip stops when the one ahead publishes, rather than running on to a pass it could not publish");
    assert.ok(!events(f, conflicting).some((event) => event.type === "publication_intent"));
    assert.equal(r.opened.length, 2, "the rebuilt attempt stops at its conflict, before any gate");
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a failing screen behind a prefix that lands keeps its verdict and screens no second time", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const ahead = f.submit(await f.candidate("ahead.txt"));
    const failing = f.submit(await f.candidate("fail"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.ok(r.opened[1]!.files.includes("ahead.txt"));
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(ahead)?.type, "landed");
    assert.equal(f.result(failing)?.type, "failed", JSON.stringify(f.result(failing)));
    assert.equal(r.opened.length, 2, "its failure behind a prefix that landed is its verdict");
    assert.ok(!events(f, failing).some((event) => event.type === "yielded"));
    assert.equal(events(f, failing).find((event) => event.type === "classified")?.cause, "gate");
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a screen ahead that changes migrations is not predicted past, and the screen behind it screens again on what it published", async () => {
  const r = controlledRemote();
  const f = await fixture(true, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const base = f.main();
    const migrating = f.submit(await f.candidate("schema/table.sql"));
    const behind = f.submit(await f.candidate("plain.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    const second = r.opened.find((entry) => entry.files.includes("plain.txt"))!;
    assert.equal(second.base, base, "a screen is not predicted past a migration change");
    assert.ok(!second.files.includes("schema"));
    r.opened.find((entry) => entry.files.includes("schema"))!.release();
    await until(() => f.result(migrating) || undefined);
    assert.equal(f.result(migrating)?.type, "landed", JSON.stringify(f.result(migrating)));
    const published = f.main();
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
    assert.equal(r.opened.length, 3, "the overtaken screen stopped and screened once more");
    assert.equal(r.opened[2]!.screening, true, "a fresh screen, not an authoritative rebuild");
    assert.equal(r.opened[2]!.base, published);
    assert.ok(events(f, behind).some((event) => event.type === "attempt_invalidated" && new RegExp(`${migrating} published past this screen's base`).test(event.reason)));
    assert.equal(events(f, behind).find((event) => event.type === "screen_reused")?.base, published, "it publishes on its fresh screen with no second gate");
  } finally { r.releaseAll(); await f.dispose(); }
});

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

test("screens that pass while paused publish in predicted order, each on its own screen", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const firstSubmitted = f.submit(await f.candidate("first.txt"));
    const secondSubmitted = f.submit(await f.candidate("second.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    r.opened.find((entry) => entry.files.includes("second.txt"))!.release();
    await until(() => f.log.operation(secondSubmitted)?.stage === "waiting-for-predecessor" || undefined);
    r.opened.find((entry) => entry.files.includes("first.txt"))!.release();
    await until(() => f.log.operation(firstSubmitted)?.stage === "waiting-for-predecessor" || undefined);
    r.releaseAll();
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    f.queue.wake();
    await f.queue.idle();
    const published = f.log.events().filter(({ event }) => event.type === "landed").map((row) => row.operationId);
    assert.deepEqual(published, [firstSubmitted, secondSubmitted]);
    assert.equal(r.opened.length, 2, "the second screen ran behind the first, so neither reruns");
  } finally { r.releaseAll(); f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "cleanup" }); f.queue.wake(); await f.dispose(); }
});

test("a pause while opening a screen yields the untouched operation and resumes with a fresh attempt", async () => {
  const r = controlledRemote();
  const open = r.remote.open;
  let opening = false;
  r.remote.open = async ({ signal }) => {
    opening = true;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("paused")), { once: true }));
  };
  const f = await fixture(false, false, undefined, false, { screeningLanes: 1, workers: 1, remoteVerification: r.remote });
  try {
    const id = f.submit(await f.candidate("opening.txt"));
    f.queue.wake();
    await until(() => opening || undefined);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    await f.queue.idle();
    assert.equal(f.log.operation(id)?.status, "queued");
    assert.equal(f.result(id), undefined);
    r.remote.open = open;
    r.releaseAll();
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    assert.equal((await f.land(id))?.type, "landed");
    const attempts = f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "attempt_started" ? [event.attempt] : []);
    assert.deepEqual(attempts, [1, 2]);
  } finally { r.releaseAll(); await f.dispose(); }
});

test("screen capacity is independent of the host preparation worker limit", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const failed = f.submit(await f.candidate("fail"));
    const second = f.submit(await f.candidate("second.txt"));
    const third = f.submit(await f.candidate("third.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.equal(f.log.operation(third)?.status, "queued", "two screens occupy exactly two lanes");
    const preparing = new Set<string>();
    for (const { operationId, event } of f.log.events()) {
      if (event.type !== "stage") continue;
      if (event.stage === "fetching") preparing.add(operationId);
      if (event.stage === "screening") preparing.delete(operationId);
      assert.ok(preparing.size <= 1, "screens share the existing host preparation worker budget");
    }
    r.opened[0]!.release();
    await until(() => f.result(failed) || undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(second)?.type, "landed");
    assert.equal(f.result(third)?.type, "landed");
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


test("replacing a screen through HTTP stops its lease and preserves the replacement source bookmark", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const first = f.submit(await f.candidate("original.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 1 || undefined);
    await writeFile(join(f.author, "replacement.txt"), "replacement");
    const source = await f.push();
    const handler = createRunnerHandler({ log: f.log, token: "screen-test", runnerName: "test", readLog: f.queue.readLog,
      onSubmitted: () => f.queue.wake(), kill: (id) => f.queue.kill(id), subscribe: (listener) => f.log.subscribe(listener) });
    const response = await handler(new Request("http://runner/v1/operations", { method: "POST",
      headers: { authorization: "Bearer screen-test" }, body: JSON.stringify(source) }));
    assert.equal(response.status, 200);
    const body = await response.json() as { operation: { id: string }; superseded: string };
    assert.equal(body.superseded, first);
    await until(() => r.opened.length === 2 && r.closed.length === 1 || undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(first)?.type, "superseded");
    assert.equal(f.result(body.operation.id)?.type, "landed", JSON.stringify(f.result(body.operation.id)));
    assert.equal(f.remoteFile("replacement.txt"), "replacement");
    assert.equal(r.closed.length, 2);
  } finally { r.releaseAll(); await f.dispose(); }
});
