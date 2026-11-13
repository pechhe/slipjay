import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { admitMachineCapacity, decodeCapacityPolicy, HostCapacityUnavailable } from "../../src/lib/runner/host-capacity-remote.ts";

const input = () => ({ id: "a".repeat(32), job: "fixture gate", lane: "landing" as const,
  owner: { kind: "holder" as const, path: "/fixture/holder/id", identity: "a".repeat(32) }, slice: "slipjay-attempt-fixture.slice", signal: new AbortController().signal });
const receipt = (outcome: string) => JSON.stringify({ configured: true, outcome, decision: { reason: "fixture memory wait", oldestWaitMs: 1000 } });

test("unconfigured admission spends no extra SSH round trip after holder acquisition", async () => {
  assert.equal(await admitMachineCapacity({ ...input(), policy: { configured: false }, control: async () => { throw new Error("unnecessary control call"); } }), 0);
});

test("machine memory waiting is visible and independent of command timeouts", async () => {
  let clock = 0, polls = 0;
  const notices: Array<{ line: string; waited: number; finished: boolean }> = [];
  const scripts: string[] = [];
  const elapsed = await admitMachineCapacity({ ...input(), policy: { configured: true },
    control: async (script) => {
      scripts.push(script);
      return script.startsWith("systemctl") ? "/fixture/cgroup" : receipt(++polls === 3 ? "admitted" : "waiting");
    }, now: () => clock, sleep: async (ms) => { clock += ms; }, onWait: (line, waited, finished) => { notices.push({ line, waited, finished }); },
  });
  assert.equal(elapsed, 2000);
  assert.equal(notices[0]?.finished, false);
  assert.equal(notices.at(-1)?.finished, true);
  assert.equal(notices.at(-1)?.waited, 2000);
  assert.match(scripts[1]!, /host-budget poll/);
  assert.match(scripts[1]!, /holder/);
});

test("capacity expiry is distinct from machine failure and abort cannot start a command", async () => {
  await assert.rejects(admitMachineCapacity({ ...input(), policy: { configured: true }, control: async (script) => script.startsWith("systemctl") ? "/fixture/cgroup" : receipt("unavailable") }), HostCapacityUnavailable);
  const controller = new AbortController();
  let polls = 0;
  await assert.rejects(admitMachineCapacity({ ...input(), signal: controller.signal, policy: { configured: true },
    control: async (script) => script.startsWith("systemctl") ? "/fixture/cgroup" : (polls++, receipt("waiting")),
    sleep: async () => { controller.abort(); },
  }), /abort/i);
  assert.equal(polls, 1);
});


test("configured cgroup, control, ledger and decoding failures are explicit capacity unavailability", async () => {
  for (const failure of ["cgroup", "control", "json", "receipt"]) {
    await assert.rejects(admitMachineCapacity({ ...input(), policy: { configured: true }, control: async (script) => {
      if (script.startsWith("systemctl")) return failure === "cgroup" ? "" : "/fixture/cgroup";
      if (failure === "control") throw new Error("ledger unreadable");
      return failure === "json" ? "invalid-json" : '{"configured":true}';
    } }), HostCapacityUnavailable);
  }
  assert.throws(() => decodeCapacityPolicy('{"configured":true,"unavailable":"policy unreadable"}'), HostCapacityUnavailable);
  assert.throws(() => decodeCapacityPolicy('invalid-json'), HostCapacityUnavailable);
  const unavailable = new Error("SSH unreachable before policy discovery");
  await assert.rejects(admitMachineCapacity({ ...input(), control: async () => { throw unavailable; } }), (error) => error === unavailable);
});
