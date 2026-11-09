import assert from "node:assert/strict";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { MachineVerification, OperationEvent, RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";

const schedule = (everyMinutes: number) => ({ everyMinutes, from: "00:00", until: "23:59", timeZone: "Europe/London" });
const events = <T extends OperationEvent["type"]>(f: Awaited<ReturnType<typeof fixture>>, id: string, type: T) =>
  f.log.events({ operationId: id }).map((row) => row.event).filter((event): event is Extract<OperationEvent, { type: T }> => event.type === type);

/** A machine's release-check place that runs each command here, in the runner's own checkout, and counts its opens. */
function checkPlace(state: { up: boolean; opened: number; closed: number }): MachineVerification {
  return {
    available: () => state.up,
    reason: () => state.up ? "" : "peach-box unreachable",
    async open() {
      state.opened += 1;
      return { executor: { host: "peach-box", run: runBoundedProcess }, machine: { verifier: "machine", id: "peach-box/check", name: "peach-box", size: "machine", image: "fixed SSH machine" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() { state.closed += 1; } };
    },
  };
}
/** A boat pool that records that it was used. */
function boat(used: string[]): RemoteVerification {
  return {
    async open(input) {
      used.push(input.pool ?? "");
      return { executor: { host: "boat", run: runBoundedProcess }, machine: { verifier: "boat", id: "vm-1", name: "release-check", size: "fixture", image: "fixture" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() {} };
    },
  };
}

test("a batch check whose machine names a release-check place runs there, apart from the gate places, and never on boat", async () => {
  const state = { up: true, opened: 0, closed: 0 };
  const used: string[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "peach-box" }, batchRemote: boat(used),
      machineCheckVerifications: { "peach-box": checkPlace(state) }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    const started = events(f, check.id, "batch_started")[0]!;
    assert.equal(started.machine, "machine:peach-box");
    assert.equal(events(f, check.id, "batch_outcome")[0]?.outcome, "green");
    assert.ok(state.opened >= 1 && state.closed === state.opened, "each attempt on the place is closed");
    assert.deepEqual(used, [], "boat was not used");
    assert.ok(events(f, check.id, "remote_verification").every((event) => event.phase !== "ready" || event.placement === "machine:peach-box"));
  } finally { await f.dispose(); }
}, 120_000);

test("a check a release waits on goes first on its machine, whatever the machine's load", async () => {
  const state = { up: true, opened: 0, closed: 0 };
  const stamped: (string | null)[] = [];
  const hostShell = (machine: string | null) => async (script: string) => {
    if (script.includes("flock")) { stamped.push(machine); return "claimed\n"; }
    return `${machine === "peach-box" ? "99 99" : "1 1"} 1.00 1/100 200\n32\n`;
  };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "peach-box" }, batchRemote: boat([]), hostShell,
      machineCheckVerifications: { "peach-box": checkPlace(state) }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    assert.ok(!check.submittedBy.endsWith(":background"));
    assert.deepEqual(events(f, check.id, "host_budget_waited"), []);
    assert.ok(!events(f, check.id, "stage").some((event) => event.stage === "waiting-for-budget"));
    assert.ok(stamped.includes("peach-box"), "it still says it started, so background work leaves room after it");
  } finally { await f.dispose(); }
}, 120_000);

test("a background check waits for the CPU budget of its machine", async () => {
  let clock = Date.now();
  const state = { up: true, opened: 0, closed: 0 };
  let reads = 0;
  const hostShell = (machine: string | null) => async (script: string) => {
    if (script.includes("flock")) return "claimed\n";
    return `${machine === "peach-box" && !reads++ ? "99 99" : "1 1"} 1.00 1/100 200\n32\n`;
  };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(600), now: () => clock, batchVerification: { machine: "peach-box", everyMinutes: 20 }, batchRemote: boat([]), hostShell,
      machineCheckVerifications: { "peach-box": checkPlace(state) }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    // The first landing promotes at once. Nothing else is due for hours, so only the background interval checks the second.
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    reads = 0;
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    clock = promotedAt + 21 * 60_000;
    await f.queue.recover();
    await settle(f);
    const check = await until(() => f.log.verifications(REPO).find((entry) => entry.submittedBy.endsWith(":background") && entry.result));
    assert.ok(events(f, check.id, "host_budget_waited").some((event) => event.placement === "machine:peach-box"));
    assert.ok(events(f, check.id, "progress").some((event) => /This verification is waiting for peach-box's CPU budget: load 99\.0 is over 24\.0/.test(event.line)));
    const stages = events(f, check.id, "stage").map((event) => event.stage);
    assert.equal(stages[stages.indexOf("waiting-for-budget") + 1], "verifying", "verifying restarts after the wait, so its deadline does not include it");
  } finally { await f.dispose(); }
}, 180_000);

test("with the release-check place down, a batch check says so and runs on the boat pool instead", async () => {
  const state = { up: false, opened: 0, closed: 0 };
  const used: string[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "peach-box" }, batchRemote: boat(used),
      machineCheckVerifications: { "peach-box": checkPlace(state) }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    assert.equal(events(f, check.id, "batch_started")[0]!.machine, "peach-box", "the boat pool named by the policy");
    assert.equal(state.opened, 0);
    assert.ok(used.length >= 1);
    assert.ok(f.log.events({ operationId: "runner" }).some((row) => row.event.type === "machine_place" && row.event.name === "peach-box" && row.event.state === "down"),
      "the outage is recorded on the runner's own record");
  } finally { await f.dispose(); }
}, 120_000);

test("the nightly audit runs on the release-check place its head's batch machine names, not on the runner host", async () => {
  const state = { up: true, opened: 0, closed: 0 };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "peach-box" }, failingAudit: true,
      machineCheckVerifications: { "peach-box": checkPlace(state) }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const opened = state.opened;
    const audit = newOperationId();
    f.log.append(audit, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    f.queue.wake();
    await until(() => f.log.operation(audit)?.result ?? undefined);
    assert.equal(state.opened, opened + 1, "the audit opened one attempt on the place");
    assert.equal(state.closed, state.opened);
    assert.deepEqual(events(f, audit, "remote_verification").filter((event) => event.phase === "ready").map((event) => event.placement), ["machine:peach-box"]);
    assert.ok(events(f, audit, "run_finished").length >= 1, "its commands ran there");
  } finally { await f.dispose(); }
}, 120_000);

test("a release-check place that starts quarantined, as after a restart, is recovered and used, never reported down", async () => {
  const state = { up: false, opened: 0, closed: 0 };
  const used: string[] = [];
  let recoveries = 0;
  const place: MachineVerification = { ...checkPlace(state), async recover() { recoveries += 1; state.up = true; } };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "peach-box" }, batchRemote: boat(used),
      machineCheckVerifications: { "peach-box": place }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    assert.ok(recoveries >= 1);
    assert.equal(events(f, check.id, "batch_started")[0]!.machine, "machine:peach-box");
    assert.deepEqual(used, [], "boat was not used");
    assert.ok(!f.log.events({ operationId: "runner" }).some((row) => row.event.type === "machine_place" && row.event.state === "down"));
  } finally { await f.dispose(); }
}, 120_000);
