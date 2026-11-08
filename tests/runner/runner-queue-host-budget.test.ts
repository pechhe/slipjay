import assert from "node:assert/strict";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";

const REPO = "fixture/repo";

/** A host over budget for its first `busy` readings, recording which machine each job asked about. */
function overloaded(busy: number) {
  const asked: (string | null)[] = [];
  let reads = 0;
  const hostShell = (machine: string | null) => async (script: string) => {
    if (script.includes("flock")) return "claimed\n";
    asked.push(machine);
    return `${reads++ < busy ? "99 99" : "1 1"} 1.00 1/100 200\n14\n`;
  };
  return { hostShell, asked };
}

/** The ledger positions that matter: the budget's wait must end before the job's first command starts. */
function waitThenRun(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const events = f.log.events({ operationId: id });
  const waited = events.findIndex(({ event }) => event.type === "host_budget_waited");
  const firstGate = events.findIndex(({ event }) => event.type === "run_started" && event.purpose === "gate");
  const lines = events.flatMap(({ event }) => event.type === "progress" ? [event.line] : []);
  return { waited, firstGate, line: lines.find((line) => line.includes("CPU budget: load")) };
}

test("a landing gate over its host's CPU budget waits before its commands start, names what it waits for and lands", async () => {
  const host = overloaded(2);
  const f = await fixture(false, false, undefined, false, { hostShell: host.hostShell, gates: () => ['console.log("gate")'] });
  try {
    const id = f.submit(await f.candidate("one.txt"));
    assert.equal((await f.land(id))?.type, "landed");
    const { waited, firstGate, line } = waitThenRun(f, id);
    assert.ok(waited >= 0 && firstGate > waited, "the wait comes before the first gate command, so its timeout has not begun");
    assert.match(line!, /This landing is waiting for .*'s CPU budget: load 99\.0 is over 14\.0 of its 14 CPUs/);
    assert.ok(host.asked.every((machine) => machine === null), "a gate on the runner host reads the runner host");
    const stages = f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "stage" ? [event.stage] : []);
    assert.deepEqual(stages.slice(stages.indexOf("waiting-for-budget") - 1, stages.indexOf("waiting-for-budget") + 2).slice(1), ["waiting-for-budget", "verifying"], "the wait is a stage of its own");
  } finally { await f.dispose(); }
}, 120_000);

test("a landing on a host with room records no wait", async () => {
  const host = overloaded(0);
  const f = await fixture(false, false, undefined, false, { hostShell: host.hostShell, gates: () => ['console.log("gate")'] });
  try {
    const id = f.submit(await f.candidate("one.txt"));
    assert.equal((await f.land(id))?.type, "landed");
    assert.equal(waitThenRun(f, id).waited, -1);
    assert.equal(host.asked.length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a nightly audit waits for the budget of the host it runs on, leaving a quarter of it free", async () => {
  const host = overloaded(1);
  const f = await fixture(false, false, undefined, false, { hostShell: host.hostShell, process: "development", failingAudit: true });
  try {
    const audit = newOperationId();
    f.log.append(audit, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    f.queue.wake();
    await until(() => f.log.operation(audit)?.result ?? undefined);
    const { waited, firstGate, line } = waitThenRun(f, audit);
    assert.ok(waited >= 0 && firstGate > waited);
    assert.match(line!, /This audit is waiting for .*'s CPU budget: load 99\.0 is over 10\.5 of its 14 CPUs/);
  } finally { await f.dispose(); }
}, 120_000);
