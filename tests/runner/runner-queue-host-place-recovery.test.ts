import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { fixture, jj, test, until } from "./fixtures/queue-verifier-fixture.ts";
import { fakeBoat, hold, holdingGate, hostGatesNow, placements, release, SLOT_NOT_READY, terminal } from "./fixtures/host-place-fixture.ts";

test("while boat is held a landing still gates in the free host place", async () => {
  let available = false;
  const boat = fakeBoat(async () => available ? undefined : Object.assign(new Error("Remote executor unavailable (boat): could not reach the Boat API"), { boatUnavailable: true }));
  boat.remote.probe = async () => { if (!available) throw new Error("still unreachable"); };
  const f = await fixture(true, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, boatProbeMs: 10, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    // A migration change is not predicted past, so the landing after it screens on the tip alone.
    const a = f.submit(await f.candidate("schema/table.sql"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // The host place is busy, so the next gate goes to boat, which is down: the hold opens and it waits queued.
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.events().some(({ event }) => event.type === "boat_circuit" && event.state === "open" && event.hostPlace) || undefined);
    await release(f);
    const [first, second] = await terminal(f, a, b);
    assert.equal(first?.type, "landed");
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.deepEqual(placements(f, b), ["host"], "the held landing gated in the host place once it was free");
    assert.equal(boat.opened.length, 0);
    const circuits = f.log.events().flatMap(({ event }) => event.type === "boat_circuit" ? [event.state] : []);
    assert.deepEqual(circuits, ["open"], "boat is still held");
  } finally { await release(f); available = true; await f.dispose(); }
}, 240_000);

test("a retry of a VM that was not ready runs in the host place when it finds it free", async () => {
  let refused = 0;
  const boat = fakeBoat(async () => refused++ ? undefined : Object.assign(new Error(SLOT_NOT_READY), { machineUnavailable: true }));
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    const a = f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // The host place is busy, so the gate behind it opens boat, whose VM is not ready; it retries once the one ahead lands.
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => refused || undefined);
    await release(f);
    const [first, second] = await terminal(f, a, b);
    assert.equal(first?.type, "landed");
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.deepEqual(f.log.events({ operationId: b }).flatMap(({ event }) => event.type === "yielded" ? [event.to] : []), ["a remote executor that was not ready"]);
    assert.deepEqual(placements(f, b), ["host"], "the retry found the host place free and ran there");
    assert.equal(boat.opened.length, 0);
  } finally { await release(f); await f.dispose(); }
}, 240_000);

test("a retry of a VM that was not ready waits on boat while the host place is busy", async () => {
  let refused = 0;
  const boat = fakeBoat(async () => refused++ ? undefined : Object.assign(new Error(SLOT_NOT_READY), { machineUnavailable: true }));
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    const a = f.submit(await f.candidate("shared.txt"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // A landing that conflicts with the one ahead screens on the tip alone, so its retry does not wait for that one.
    jj(f.author, ["new", "-m", "Rewrite shared.txt", "main@origin"]);
    await writeFile(join(f.author, "shared.txt"), "conflicting\n");
    const b = f.submit(await f.push());
    f.queue.wake();
    await until(() => placements(f, b).length || undefined);
    assert.deepEqual(placements(f, b), ["boat"]);
    assert.deepEqual(f.log.events({ operationId: b }).flatMap(({ event }) => event.type === "yielded" && event.to === "a remote executor that was not ready" ? [event.to] : []), ["a remote executor that was not ready"]);
    assert.deepEqual(boat.opened.map((entry) => entry.retrying), [true], "the retry waits on the slot's VM, forking none");
    assert.equal(hostGatesNow(f), 1, "the host place still holds the gate ahead");
    await release(f);
    // Whichever publishes first, the other then conflicts with it.
    const results = await terminal(f, a, b);
    assert.deepEqual(results.map((result) => result?.type).sort(), ["failed", "landed"], JSON.stringify(results));
  } finally { await release(f); await f.dispose(); }
}, 240_000);

test("a boat hold of a repository with a host place says a free host place still takes a gate", async () => {
  const log = openOperationLog(":memory:");
  const id = newOperationId();
  log.append(id, { type: "submitted", repo: "pechhe/yardsmith", changeId: "c".repeat(32), commitId: "a".repeat(40), bookmark: "slipjay/changes/x", submittedBy: "test" });
  log.append(RUNNER_CONTROL_ID, { type: "boat_circuit", repo: "pechhe/yardsmith", state: "open", reason: "could not reach the Boat API", hostPlace: true });
  assert.equal(log.openOperations().find((operation) => operation.id === id)?.waitingFor, "boat: could not reach the Boat API; a free runner-host gate place still takes a gate");
});
