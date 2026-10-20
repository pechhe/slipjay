import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { decideSystemd, onRunner, systemdTest } from "./systemd-gate.ts";

test("on the runner without systemd the decision fails and names the missing systemd", () => {
  const decision = decideSystemd({ platform: "linux", runtimeDir: undefined, onRunner: true });
  assert.equal(decision.action, "fail");
  assert.match(decision.action === "fail" ? decision.message : "", /user systemd unavailable \(XDG_RUNTIME_DIR unset\) on the runner/);
});

test("off the runner without systemd the decision skips, on a Mac or on Linux", () => {
  assert.deepEqual(decideSystemd({ platform: "darwin", runtimeDir: undefined, onRunner: false }), { action: "skip" });
  assert.deepEqual(decideSystemd({ platform: "linux", runtimeDir: undefined, onRunner: false }), { action: "skip" });
  assert.deepEqual(decideSystemd({ platform: "darwin", runtimeDir: "/run/user/1000", onRunner: false }), { action: "skip" });
});

test("with systemd the decision runs, on the runner or off it", () => {
  assert.deepEqual(decideSystemd({ platform: "linux", runtimeDir: "/run/user/1000", onRunner: true }), { action: "run" });
  assert.deepEqual(decideSystemd({ platform: "linux", runtimeDir: "/run/user/1000", onRunner: false }), { action: "run" });
});

test("a landing check on the runner is told by the report directory the runner names", () => {
  assert.equal(onRunner({ SLIPJAY_TEST_REPORT_DIR: "/tmp/reports/1" }), true);
  assert.equal(onRunner({}), false);
  assert.equal(onRunner({ SLIPJAY_TEST_REPORT_DIR: "" }), false);
});

test("the registrar runs, skips or registers a failing test according to the decision", () => {
  const registered: string[] = [];
  const bodies: Array<() => unknown> = [];
  const base = Object.assign((name: string, body: () => unknown) => { registered.push(`test:${name}`); bodies.push(body); },
    { skip: (name: string) => { registered.push(`skip:${name}`); } });
  systemdTest(base, { platform: "linux", runtimeDir: "/run/user/1", onRunner: true })("a", () => {});
  systemdTest(base, { platform: "darwin", onRunner: false })("b", () => {});
  systemdTest(base, { platform: "linux", onRunner: true })("c", () => {});
  assert.deepEqual(registered, ["test:a", "skip:b", "test:c"]);
  assert.throws(bodies[1]!, /user systemd unavailable \(XDG_RUNTIME_DIR unset\) on the runner/);
});
