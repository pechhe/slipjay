import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { createRunnerQueue } from "../../src/lib/runner/runner-queue.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { landingOutcome } from "../../src/lib/landing/landing-outcome.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";

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

test("a failed screen never joins or invalidates the publication queue; a concurrent pass publishes once", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const failed = f.submit(await f.candidate("fail"));
    const passed = f.submit(await f.candidate("pass.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.deepEqual(r.opened.map((entry) => entry.screening), [true, true]);
    assert.notEqual(r.opened[0]!.slot, r.opened[1]!.slot);
    assert.equal(r.opened[0]!.base, r.opened[1]!.base);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(failed)?.type, "failed");
    assert.equal(f.result(passed)?.type, "landed", JSON.stringify(f.result(passed)));
    assert.equal(r.opened.length, 2, "current pass uses its original evidence");
    const failedEvents = f.log.events({ operationId: failed }).map(({ event }) => event);
    assert.ok(!failedEvents.some((event) => event.type === "publication_intent"));
    assert.equal(failedEvents.find((event) => event.type === "classified")?.cause, "gate");
    assert.ok(!f.log.events({ operationId: passed }).some(({ event }) => event.type === "attempt_invalidated"));
    assert.equal(r.closed.length, 2);
    const metrics = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z");
    assert.ok((landingOutcome(f.log.operation(passed)! as import("../../src/lib/runner/runner-types.ts").LandingOperation, f.log.events()).screening?.durationMs ?? -1) >= 0);
    assert.ok(metrics.groups.find((group) => group.kind === "landing")?.stages.screening);
    assert.equal(f.log.events().filter(({ event }) => event.type === "publication_intent").length, 1);
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a slow screen holds no passed screen back, and its stale pass reruns on the new exact tip", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const slow = f.submit(await f.candidate("slow.txt"));
    const fast = f.submit(await f.candidate("fast.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    r.opened.find((entry) => entry.files.includes("fast.txt"))!.release();
    await until(() => f.result(fast) || undefined);
    assert.equal(f.result(fast)?.type, "landed");
    assert.equal(f.result(slow), undefined);
    const newTip = f.main();
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(slow)?.type, "landed", JSON.stringify(f.result(slow)));
    assert.equal(r.opened.length, 3);
    assert.equal(r.opened[2]!.screening, false);
    assert.equal(r.opened[2]!.base, newTip);
    assert.equal(f.remoteFile("slow.txt"), "slow.txt");
    assert.equal(f.remoteFile("fast.txt"), "fast.txt");
  } finally { r.releaseAll(); await f.dispose(); }
});

for (const control of ["kill", "supersede"] as const) test(`${control} during screening closes only its own lease`, async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const stopped = f.submit(await f.candidate("stopped.txt"));
    const survivor = f.submit(await f.candidate("survivor.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    if (control === "kill") assert.equal(f.queue.kill(stopped).status, "killed");
    else f.log.append(stopped, { type: "superseded", by: "replacement" });
    await until(() => r.closed.length === 1 || undefined);
    assert.equal(f.result(survivor), undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(stopped)?.type, control === "kill" ? "cancelled" : "superseded");
    assert.equal(f.result(survivor)?.type, "landed");
    assert.equal(r.closed.length, 2);
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
    await restarted.recover();
    await restarted.idle();
    assert.deepEqual(recovered, ["fixture/repo"]);
    const outcome = f.result(id);
    assert.equal(outcome?.type, "failed");
    assert.match(outcome?.type === "failed" ? outcome.reason : "", /restart.*screening/);
    assert.ok(!f.log.events({ operationId: id }).some(({ event }) => event.type === "publication_intent"));
  } finally { restarted?.close(); await restarted?.idle(); await f.dispose(); }
});

test("screens that pass while paused enter the authoritative lane in pass order", async () => {
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
    assert.deepEqual(published, [secondSubmitted, firstSubmitted]);
    assert.equal(r.opened.length, 3, "the second published screen reruns after the first moves the tip");
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
    f.submit(await f.candidate("second.txt"));
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
    r.opened.find((entry) => entry.files.includes("fail"))!.release();
    await until(() => f.result(failed) || undefined);
    await until(() => r.opened.length === 3 || undefined);
    assert.equal(r.opened[2]!.slot, r.opened.find((entry) => entry.files.includes("fail"))!.slot, "only the released screen slot is reused");
    r.releaseAll();
    await f.queue.idle();
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
