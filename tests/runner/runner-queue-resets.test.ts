import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, stagesOf, seqOf, exactPrefixGate } from "./fixtures/queue-maintenance-fixture.ts";

test("a repository's first landing resets its target at once from the integration tip, with the declared key, keeping the output out of the log", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [reset] = f.log.resets("fixture/repo");
    assert.ok(reset, "the landing scheduled a reset");
    assert.deepEqual(reset.result, { type: "reset", target: "fixture-development-db", source: f.main() });
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })), /private-customer-record-fixture/);
    assert.match(await readFile(join(f.home, "logs", `${reset.id}.reset-output`), "utf8"), /private-customer-record-fixture/);
    assert.equal(reset.submittedBy, `${f.executor.host}:schedule`);
    assert.deepEqual(stagesOf(f, reset.id), ["fetching", "resetting"]);
    assert.deepEqual(reset.runs.map((run) => run.exitCode), [0, 0], "probe and command ran through the executor");
    assert.deepEqual((await f.lines("reset.jsonl")).map((line) => JSON.parse(line)),
      [{ target: "fixture-development-db", source: f.main(), reasonFile: true, key: "from-runner", head: f.main() }]);
    const output = join(f.home, "logs", `${reset.id}.reset-output`);
    assert.match(await readFile(output, "utf8"), /owner:from-runner@/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })) + await f.queue.readLog(reset.id), /from-runner/);
    // The next landing falls within the interval.
    assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a failed reset reports the step's reason line and keeps its output out of events; a probe that names another target runs nothing", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "fail-reset"), "");
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [failed] = f.log.resets("fixture/repo");
    const result = failed?.result;
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.equal(result.stage, "resetting");
    assert.equal(result.reason, `Reset command failed: Scrub refused:  a real-customer tenant; its output is in ${join(f.home, "logs", `${failed!.id}.reset-output`)}`);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: failed!.id })), /from-runner|second-line/);
    await rm(join(f.root, "fail-reset"));
    await writeFile(join(f.root, "wrong-target"), "");
    const mismatched = await f.land(f.submitReset());
    assert.deepEqual(mismatched, { type: "failed", stage: "resetting", reason: "The reset target probe did not confirm fixture-development-db; the reset command did not run" });
    assert.equal((await f.lines("reset.jsonl")).length, 1, "only the first reset's command ran");
    await rm(join(f.root, "wrong-target"));
    assert.equal((await f.land(f.submitReset()))?.type, "reset");
    assert.equal(f.log.resets("fixture/repo").length, 3, "a failed reset is not retried on its own");
  } finally { await f.dispose(); }
}, 120_000);

test("the owner's kill stops a running reset: cancelled, never passed, and the schedule does not start it again", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "hold-reset"), "");
    f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    const resets = f.log.resets("fixture/repo");
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0]!.result, { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.deepEqual(await f.lines("reset.jsonl"), []);
  } finally { await rm(join(f.root, "hold-reset"), { force: true }); await f.dispose(); }
}, 120_000);

test("a reset of a repository that declares none fails, and recovery fails a reset interrupted by a restart", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 0, "nothing schedules a reset that is not declared");
    assert.deepEqual(await f.land(f.submitReset()), { type: "failed", stage: "fetching", reason: `${f.main().slice(0, 12)} declares no reset` });
    const interrupted = f.submitReset();
    f.log.append(interrupted, { type: "stage", stage: "resetting" });
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "resetting", reason: "runner restarted during resetting; run slipjay reset again" });
  } finally { await f.dispose(); }
}, 120_000);

test("depth-two queued reset fences later landing admission and uses the preceding published source", async () => {
  const f = await fixture(false, false, undefined, true, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "hold-reset"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const reset = f.submitReset();
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "a-started")).then(() => true, () => undefined));
    assert.equal(f.log.operation(reset)?.status, "queued");
    assert.equal(f.log.operation(b)?.status, "queued");
    await rm(join(f.root, "hold-a"));
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    const landed = f.result(a);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.log.operation(b)?.status, "queued");
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_started"));
    await rm(join(f.root, "hold-reset")); await f.queue.idle();
    assert.equal(f.result(reset)?.type, "reset", JSON.stringify(f.result(reset)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.equal(JSON.parse((await f.lines("reset.jsonl"))[0]!).source, landed.commitId);
    assert.ok(seqOf(f, b, "stage") > seqOf(f, reset, "reset"));
  } finally {
    await rm(join(f.root, "hold-a"), { force: true });
    await rm(join(f.root, "hold-reset"), { force: true });
    await f.dispose();
  }
}, 120_000);
