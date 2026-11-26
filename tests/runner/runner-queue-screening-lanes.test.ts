import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";
import { controlledRemote, events } from "./fixtures/screening-fixture.ts";

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

for (const secondFails of [false, true]) test(`a ${secondFails ? "failed" : "passed"} screen waiting for its prefix frees a lane but retains its slot`, async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 2, workers: 1, remoteVerification: r.remote });
  try {
    const first = f.submit(await f.candidate("first.txt"));
    const secondFile = secondFails ? "fail" : "second.txt";
    const second = f.submit(await f.candidate(secondFile));
    const third = f.submit(await f.candidate("third.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.equal(f.log.operation(third)?.status, "queued", "the remote gates use both execution lanes");

    const firstScreen = r.opened.find((entry) => !entry.files.includes(secondFile))!;
    const secondScreen = r.opened.find((entry) => entry.files.includes(secondFile))!;
    assert.equal(secondScreen.base, firstScreen.candidate);
    secondScreen.release();
    const thirdScreen = await until(() => r.opened.find((entry) => entry.files.includes("third.txt")));
    assert.equal(f.result(first), undefined);
    assert.equal(f.result(second), undefined, "the settled screen is still waiting for its prefix");
    assert.equal(r.closed.length, 1, "one gate ended before the third opened");
    assert.equal(new Set([firstScreen.slot, secondScreen.slot, thirdScreen.slot]).size, 3);
    const predicted = secondFails ? { screen: firstScreen, id: first } : { screen: secondScreen, id: second };
    assert.equal(thirdScreen.base, predicted.screen.candidate);
    assert.equal(thirdScreen.files.includes(secondFile), !secondFails);
    thirdScreen.release();
    await until(() => f.log.operation(third)?.stage === "waiting-for-predecessor" || undefined);

    firstScreen.release();
    await f.queue.idle();
    assert.equal(f.result(first)?.type, "landed");
    assert.equal(f.result(second)?.type, secondFails ? "failed" : "landed");
    if (!secondFails) assert.equal(events(f, second).find((event) => event.type === "screen_reused")?.behind, first);
    assert.equal(f.result(third)?.type, "landed", JSON.stringify(f.result(third)));
    assert.equal(events(f, third).find((event) => event.type === "screen_reused")?.behind, predicted.id);
    assert.equal(r.opened.length, 3, "none of the screens reran verification");
  } finally { r.releaseAll(); await f.dispose(); }
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
