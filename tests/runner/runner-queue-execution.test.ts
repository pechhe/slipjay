import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { readCommandArtifact } from "../../src/lib/runner/command-artifact.ts";
import { runContainment } from "../../src/lib/runner/local-executor.ts";
import { runnerWorkers } from "../../src/lib/runner/runner-queue.ts";
import { TEST_SLICE, testExecutor } from "../support/executor.ts";
import { gateFailureOutput, gate, command, test, fixture, until, alive, cgroupOf, hanging, started, systemdTest } from "./fixtures/runner-queue-fixture.ts";
import { assertSystemdOrSkip } from "./fixtures/systemd-gate.ts";

test("gate failure preserves main and verbatim evidence; an amended change can land again", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("fail");
    const failed = f.submit(request);
    f.queue.wake(); await f.queue.idle();
    const failure = f.result(failed);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected failed gate");
    assert.equal(failure.stage, "verifying");
    assert.equal(failure.command, command);
    assert.equal(failure.output, gateFailureOutput);
    assert.equal(f.log.operation(failed)!.runs[0]!.exitCode, 3);
    const context = f.log.operation(failed)!.runs[0]!.commandEvidence;
    assert.equal(context?.status, "recorded");
    if (context?.status !== "recorded") throw new Error("Expected structured gate command");
    assert.equal(context.executable, "node");
    assert.deepEqual(context.args, ["-e", gate]);
    assert.equal(context.cwd, ".");
    assert.equal(context.redacted, false);
    assert.ok(context.environmentNames.includes("PATH"));
    assert.doesNotMatch(JSON.stringify(context), /SLIPJAY_RUNNER_TOKEN/);
    assert.equal(f.main(), before);
    await rm(join(f.author, "fail"));
    await writeFile(join(f.author, "fixed.txt"), "fixed\n");
    const amended = await f.push();
    assert.equal(amended.changeId, request.changeId);
    assert.notEqual(amended.commitId, request.commitId);
    const retry = f.submit(amended);
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(retry)?.type, "landed", JSON.stringify(f.result(retry)));
    assert.equal(f.remoteFile("fixed.txt"), "fixed");
  } finally { await f.dispose(); }
}, 120_000);

test("middle failure diagnostics survive queue events and durable log retrieval", async () => {
  const f = await fixture(false, false, undefined, false, { durable: true, prefixGate: () =>
    `const fs=require('node:fs'); const noise='ordinary progress\\n'.repeat(7000);
    fs.writeSync(2,noise); fs.writeSync(2,' FAIL tests/hidden.test.ts > rejects stale source\\nAssertionError: stale source was accepted\\n ❯ tests/hidden.test.ts:27:3\\n');
    fs.writeSync(2,noise); process.exitCode=1;` });
  try {
    const before = f.main();
    const id = f.submit(await f.candidate("diagnostic.txt"));
    const result = await f.land(id);
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.match(result.reason, /tests\/hidden.test.ts > rejects stale source/);
    assert.match(result.reason, /AssertionError: stale source was accepted/);
    const run = f.log.operation(id)!.runs.at(-1)!;
    assert.deepEqual(run.failingTests, ["tests/hidden.test.ts > rejects stale source"]);
    assert.ok(run.diagnostics?.some((line) => line.includes("tests/hidden.test.ts:27:3")));
    assert.equal(run.diagnosticCapture, "selected");
    assert.equal(run.artifact?.status, "retained");
    if (run.artifact?.status !== "retained") throw new Error("Expected retained command artifact");
    assert.equal(run.artifact.complete, false);
    const artifact = await readCommandArtifact(f.home, id, run.runId, run.artifact, 0, 16384);
    assert.match(Buffer.from(artifact.dataBase64, "base64").toString("utf8"), /tests\/hidden.test.ts:27:3/);
    assert.equal(f.main(), before);
    const reopened = openOperationLog(f.logPath);
    try {
      assert.deepEqual(reopened.operation(id)!.runs.at(-1)!.failingTests, run.failingTests);
      assert.match(JSON.stringify(reopened.events({ operationId: id })), /stale source was accepted/);
    } finally { reopened.close(); }
    const retrieved = await f.queue.readLog(id);
    assert.match(retrieved!, /tests\/hidden.test.ts:27:3/);
  } finally { await f.dispose(); }
}, 120_000);

test("artifact capture failure keeps the original failed gate and selected diagnostics", async () => {
  const f = await fixture();
  try {
    await mkdir(f.home, { recursive: true });
    await writeFile(join(f.home, "command-artifacts"), "storage unavailable");
    const before = f.main();
    const id = f.submit(await f.candidate("fail"));
    const result = await f.land(id);
    assert.equal(result?.type, "failed");
    assert.equal(f.main(), before);
    const run = f.log.operation(id)!.runs[0]!;
    assert.equal(run.exitCode, 3);
    assert.deepEqual(run.artifact, { status: "unavailable", reason: "capture-failed" });
    assert.equal(run.diagnosticCapture, "selected");
  } finally { await f.dispose(); }
}, 120_000);

/** Resolves once `check` holds, polling; fails after `timeoutMs`. */
test("the owner's kill stops a running gate: cancelled, never passed, main unchanged, and the queue moves on", async () => {
  const f = await fixture(false, false, undefined, false, { scopes: true });
  try {
    const before = f.main();
    const pids = join(f.root, "gate-pids.json");
    await f.candidate("hang");
    await writeFile(join(f.author, "hang"), `${pids}\n`);
    const killed = f.submit(await f.push());
    const next = f.submit(await f.candidate("next.txt"));
    assert.deepEqual(f.queue.kill(), { status: "idle" }, "an idle runner has nothing to kill");
    f.queue.wake();
    const [gatePid, childPid, toolPid, scopedPid] = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as [number, number, number, number?] : undefined;
    });
    const outcome = f.queue.kill();
    assert.ok(outcome.status === "killed" && outcome.operation.id === killed, JSON.stringify(outcome));
    await f.queue.idle();
    assert.deepEqual(f.result(killed), { type: "cancelled", reason: OWNER_KILL_REASON });
    const landed = f.result(next);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, before, "the killed change never integrated");
    assert.deepEqual(landed.declaredEnvironments, [], "a repository that declares no deployments says so");
    assert.equal(alive(gatePid), false, "the gate process is gone");
    await until(() => alive(childPid) ? undefined : true, 5_000);
    // A systemd scope reaches the tool's own process group; a bare process group cannot.
    if (assertSystemdOrSkip()) {
      assert.equal(alive(toolPid), false, "the gate's detached tool is gone");
      assert.equal(alive(scopedPid!), false, "the tool in the gate's own nested scope is gone");
    } else process.kill(toolPid, "SIGKILL");
    assert.deepEqual(f.queue.kill(), { status: "idle" });
  } finally { await f.dispose(); }
}, 120_000);

test("without enforced combined limits the runner runs one operation at a time and refuses concurrent workers", async () => {
  assert.equal(runnerWorkers({}, { combinedLimits: true }), 2);
  assert.equal(runnerWorkers({ workers: 3 }, { combinedLimits: true }), 3);
  assert.equal(runnerWorkers({}, {}), 1);
  assert.equal(runnerWorkers({ workers: 1 }, { combinedLimits: false }), 1);
  assert.throws(() => runnerWorkers({ workers: 2 }, {}), /2 workers require an executor with enforced combined resource limits/);
  const f = await fixture(false, false, undefined, false, { other: true, combinedLimits: false });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    assert.equal(f.log.operation(other)!.status, "queued", "another repository's landing does not run beside it");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
  } finally { await f.dispose(); }
}, 120_000);

test("without systemd the executor runs one command at a time, stops each command's group, and recovers a killed runner's group", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-group-"));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    // No XDG_RUNTIME_DIR: the process-group executor, on every platform.
    const executor = testExecutor({ env: {}, home });
    assert.equal(executor.combinedLimits, undefined);
    const spans = join(home, "spans.jsonl");
    const span = `const fs=require("node:fs");const start=Date.now();setTimeout(()=>{fs.appendFileSync(${JSON.stringify(spans)},JSON.stringify([start,Date.now()])+"\\n")},300)`;
    const request = { executable: process.execPath, args: ["-e", span], cwd: home, timeoutMs: 30_000, maxOutputBytes: 65_536 };
    await Promise.all([executor.run(request), executor.run(request)]);
    const [first, second] = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]);
    assert.ok(second![0] >= first![1], `the second command started only after the first ended: ${JSON.stringify([first, second])}`);
    // A command's own group is stopped after it, even when the command itself exits.
    const pidFile = join(home, "member.pid");
    const leaves = `const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`;
    await executor.run({ ...request, args: ["-e", leaves] });
    const member = Number(await readFile(pidFile, "utf8"));
    await until(() => alive(member) ? undefined : true, 5_000);
    // A runner killed outright leaves its command's group; the next process with the same home stops it.
    const pids = join(home, "pids.json");
    await writeFile(join(home, "hang"), `${pids}\n`);
    const driver = `
      import { localExecutor } from ${JSON.stringify(new URL("../../src/lib/runner/local-executor.ts", import.meta.url).href)};
      localExecutor({ env: {}, home: ${JSON.stringify(home)} }).run({ executable: process.execPath, args: ["-e", ${JSON.stringify(gate)}], cwd: ${JSON.stringify(home)}, timeoutMs: 60_000, maxOutputBytes: 65_536 });
      setInterval(() => {}, 1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: "ignore" });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    const [gatePid, childPid, toolPid] = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    child.kill("SIGKILL"); await exited;
    assert.deepEqual([alive(gatePid!), alive(childPid!)], [true, true], "the killed runner's command outlives it");
    await testExecutor({ env: {}, home }).recover!();
    await until(() => alive(gatePid!) || alive(childPid!) ? undefined : true, 5_000);
    assert.deepEqual(await readdir(join(home, "commands")), [], "recovery clears what it stopped");
    // The tool that left the group is out of the fallback's reach, as documented.
    process.kill(toolPid!, "SIGKILL");
  } finally {
    child?.kill("SIGKILL"); await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

test("a run whose processes cannot be shown stopped fails, and every later run waits until they stop", async () => {
  const { settled, contained } = runContainment();
  const failures = ["still running", "still running", null];
  const stop = async () => failures.shift() ?? null;
  await assert.rejects(contained("run-a", async () => "done", stop), /could not stop the processes of run-a/);
  await assert.rejects(settled(), /earlier run \(run-a\) could not be stopped: still running/);
  await settled();
  assert.equal(await contained("run-b", async () => "done", async () => null), "done");
  await assert.rejects(contained("run-c", async () => { throw new Error("gate failed"); }, async () => "stuck"), /gate failed/);
  await assert.rejects(settled(), /run-c/);
});

systemdTest("each run's processes, nested scopes included, stay within the runner's slice and stop with the run", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-slice-"));
  const controller = new AbortController();
  try {
    const executor = testExecutor({ home });
    const pids = join(home, "pids.json");
    await writeFile(join(home, "hang"), `${pids}\n`);
    const running = executor.run({ executable: "node", args: ["-e", gate], cwd: home, timeoutMs: 60_000, maxOutputBytes: 65_536, abortSignal: controller.signal });
    const recorded = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    assert.equal(recorded.length, 4, "the gate started a nested scope");
    const ownSlice = await cgroupOf(recorded[0]!);
    for (const pid of recorded) {
      const cgroup = await cgroupOf(pid);
      // The budget is the disposable test slice, or the enclosing runner command's slice when nested in one.
      assert.ok(cgroup.includes(`/${process.env.SLIPJAY_SYSTEMD_SLICE ?? TEST_SLICE}/`), `${pid} is within the combined budget: ${cgroup}`);
      assert.ok(cgroup.startsWith(ownSlice.slice(0, ownSlice.lastIndexOf("/"))), `${pid} is within its run's slice: ${cgroup}`);
    }
    controller.abort();
    await running;
    await until(() => recorded.some(alive) ? undefined : true, 10_000);
  } finally { controller.abort(); await rm(home, { recursive: true, force: true }); }
}, 120_000);

systemdTest("the owner's slice is stopped once its last run ends, and a run starting during that stop is unaffected", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-owner-"));
  try {
    const executor = testExecutor({ home });
    const cgroups = join(home, "cgroups");
    const record = `require("node:fs").appendFileSync(${JSON.stringify(cgroups)},require("node:fs").readFileSync("/proc/self/cgroup","utf8").trim().split(":").at(-1)+"\\n");setTimeout(()=>console.log("finished"),200)`;
    const request = { executable: "node", args: ["-e", record], cwd: home, timeoutMs: 30_000, maxOutputBytes: 65_536 };
    // Each run after the first starts while the previous one's owner-slice stop is in flight.
    for (let run = 0; run < 3; run += 1) {
      const result = await executor.run(request);
      assert.deepEqual([result.exitCode, result.stdout.trim()], [0, "finished"], "the run completed, untouched by the stop");
    }
    const runSlice = (await readFile(cgroups, "utf8")).trim().split("\n")[0]!.split("/").at(-2)!;
    const ownerSlice = `${runSlice.slice(0, runSlice.lastIndexOf("-"))}.slice`;
    const state = () => new Promise<string>((resolve) => execFile("systemctl", ["--user", "show", "--property=ActiveState", "--value", ownerSlice],
      (_error, stdout) => resolve(stdout.trim())));
    await until(async () => await state() === "inactive" ? true : undefined, 10_000);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 60_000);

systemdTest("a failed stop of the owner's slice is retried while no run is in progress", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-owner-retry-"));
  const path = process.env.PATH;
  try {
    // A systemctl that refuses the first two stops of an owner's slice (its name ends in the 12-hex home hash).
    const bin = join(home, "bin");
    await mkdir(bin);
    const real = execFileSync("sh", ["-c", "command -v systemctl"], { encoding: "utf8" }).trim();
    const refusals = join(home, "refusals");
    await writeFile(join(bin, "systemctl"), `#!/bin/sh
if [ "$2" = stop ] && printf %s "$3" | grep -Eq -- '-[0-9a-f]{12}[.]slice$' && [ "$(wc -l < ${JSON.stringify(refusals)} 2>/dev/null || echo 0)" -lt 2 ]; then
  echo refused >> ${JSON.stringify(refusals)}; exit 1
fi
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    const executor = testExecutor({ home });
    const cgroups = join(home, "cgroups");
    const record = `require("node:fs").appendFileSync(${JSON.stringify(cgroups)},require("node:fs").readFileSync("/proc/self/cgroup","utf8").trim().split(":").at(-1)+"\\n")`;
    const result = await executor.run({ executable: "node", args: ["-e", record], cwd: home, timeoutMs: 30_000, maxOutputBytes: 65_536 });
    assert.equal(result.exitCode, 0);
    const runSlice = (await readFile(cgroups, "utf8")).trim().split("/").at(-2)!;
    const ownerSlice = `${runSlice.slice(0, runSlice.lastIndexOf("-"))}.slice`;
    const state = () => new Promise<string>((resolve) => execFile(real, ["--user", "show", "--property=ActiveState", "--value", ownerSlice],
      (_error, stdout) => resolve(stdout.trim())));
    await until(async () => await state() === "inactive" ? true : undefined, 15_000);
    assert.equal((await readFile(refusals, "utf8")).trim().split("\n").length, 2, "the stop was refused twice, then retried until it succeeded");
  } finally { process.env.PATH = path; await rm(home, { recursive: true, force: true }); }
}, 60_000);

systemdTest("after the runner is killed outright, the next process stops only the commands it left before reusing their checkout", async () => {
  const f = await fixture(false, false, undefined, false, { durable: true, scopes: true });
  const bystanderHome = await mkdtemp(join(tmpdir(), "runner-bystander-"));
  const bystanderStop = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = "";
  try {
    // Another runner's command on the same host, which recovery must leave alone.
    const bystanderPids = join(bystanderHome, "pids.json");
    await writeFile(join(bystanderHome, "hang"), `${bystanderPids}\n`);
    const bystander = testExecutor({ home: bystanderHome })
      .run({ executable: "node", args: ["-e", gate], cwd: bystanderHome, timeoutMs: 120_000, maxOutputBytes: 65_536, abortSignal: bystanderStop.signal });
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const driver = `
      import { createRunnerQueue } from ${JSON.stringify(new URL("../../src/lib/runner/runner-queue.ts", import.meta.url).href)};
      import { localExecutor } from ${JSON.stringify(new URL("../../src/lib/runner/local-executor.ts", import.meta.url).href)};
      import { openOperationLog } from ${JSON.stringify(new URL("../../src/lib/runner/runner-log.ts", import.meta.url).href)};
      const log = openOperationLog(${JSON.stringify(f.logPath)});
      const queue = createRunnerQueue({ log, executor: localExecutor({ home: ${JSON.stringify(f.home)}, slice: ${JSON.stringify(TEST_SLICE)} }), home: ${JSON.stringify(f.home)},
        config: { repos: { 'Fixture/Repo': { url: ${JSON.stringify(f.origin)} } }, jj: { 'user.name': 'Runner Identity', 'user.email': 'runner@example.com' } } });
      queue.wake(); setInterval(() => {}, 1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    const left = await until(async () => {
      assert.equal(child!.exitCode, null, stderr);
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    const others = await until(async () => {
      const text = await readFile(bystanderPids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    assert.equal(left.length, 4, "the gate started a nested scope");
    child.kill("SIGKILL"); await exited;
    // Nothing stopped the gate: the killed runner had no chance to.
    assert.deepEqual(left.map(alive), [true, true, true, true], "the killed runner's commands outlive it");
    await f.queue.recover();
    assert.deepEqual(left.map(alive), [false, false, false, false], "recovery stopped every command the killed runner left");
    assert.deepEqual(others.map(alive), [true, true, true, true], "another runner's commands are untouched");
    assert.equal(f.result(stuck)?.type, "failed", JSON.stringify(f.result(stuck)));
    assert.match(JSON.stringify(f.result(stuck)), /runner restarted/);
    assert.equal((await f.land(f.submit(await f.candidate("after.txt"))))?.type, "landed", "the checkout is reused only after recovery");
    bystanderStop.abort();
    await bystander;
    await until(() => others.some(alive) ? undefined : true, 10_000);
  } finally {
    child?.kill("SIGKILL"); await exited; bystanderStop.abort();
    await rm(bystanderHome, { recursive: true, force: true }); await f.dispose();
  }
}, 180_000);

test("a kill past verification is refused and the landing completes", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    const id = f.submit(await f.candidate("schema/a.ts"));
    f.queue.wake();
    await until(() => f.log.operation(id)!.stage === "finalizing" ? true : undefined);
    const outcome = f.queue.kill();
    assert.ok(outcome.status === "refused" && outcome.operation.stage === "finalizing", JSON.stringify(outcome));
    await rm(join(f.root, "hold-finalize"));
    await f.queue.idle();
    assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
  } finally { await f.dispose(); }
}, 120_000);

test("the owner's kill stops a release's verification and publishes nothing", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "hang-release"), "");
    const release = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    assert.deepEqual(f.result(release), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.releaseRef(), base);
  } finally { await f.dispose(); }
}, 120_000);

/** Commit a `hang` gate in `author` that records its pids in `pids`, and push it: the gate then never ends. */
test("another repository's landing runs beside a hanging one; a kill must name which of the two it stops", async () => {
  const f = await fixture(false, false, undefined, false, { other: true });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const queued = f.submit(await f.candidate("queued.txt"));
    const otherPids = join(f.root, "other-pids.json");
    const other = f.submit(await hanging(f, otherPids, f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    await started(otherPids);
    assert.deepEqual([f.log.operation(stuck)!.status, f.log.operation(other)!.status], ["running", "running"]);
    // The same repository's next landing still waits for its predecessor.
    assert.match(f.log.operation(queued)!.waitingFor ?? "", /^landing [0-9a-z]{12}$/);
    const ambiguous = f.queue.kill();
    assert.ok(ambiguous.status === "ambiguous" && ambiguous.operations.map((operation) => operation.id).sort().join() === [stuck, other].sort().join(), JSON.stringify(ambiguous));
    assert.equal(f.log.operation(stuck)!.status, "running", "an ambiguous kill stops nothing");
    assert.deepEqual(f.queue.kill("op_0000000000_000000000000000000000000"), { status: "not_running", operation: null });
    assert.equal(f.queue.kill(other).status, "killed");
    await until(() => f.log.operation(other)!.result ? true : undefined);
    assert.deepEqual(f.result(other), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.log.operation(stuck)!.status, "running", "killing one operation leaves the other running");
    const finished = f.queue.kill(other);
    assert.ok(finished.status === "not_running" && finished.operation?.status === "cancelled", JSON.stringify(finished));
    // With one left running, the unnamed kill stops it, and the queued landing follows.
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    assert.equal(f.result(queued)?.type, "landed", JSON.stringify(f.result(queued)));
    for (const file of [pids, otherPids]) for (const pid of JSON.parse(await readFile(file, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("repositories that share a lane take turns even with a worker free", async () => {
  const f = await fixture(false, false, undefined, false, { other: true, lane: "shared-database" });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    assert.deepEqual([f.log.operation(other)!.status, f.log.operation(other)!.position], ["queued", 2]);
    assert.match(f.log.operation(other)!.waitingFor ?? "", /^landing [0-9a-z]{12}$/);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("with one worker, another repository's landing waits for it and names what holds the worker", async () => {
  const f = await fixture(false, false, undefined, false, { other: true, workers: 1 });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    const waiting = f.log.operation(other)!;
    assert.equal(waiting.status, "queued");
    assert.match(waiting.waitingFor ?? "", /^a worker \(landing [0-9a-z]{12}\)$/);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("while paused, queued changes wait and show paused; resumed, they land in order", async () => {
  const f = await fixture();
  try {
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual([f.log.operation(a)!.stage, f.log.operation(b)!.stage], ["paused", "paused"]);
    assert.deepEqual([f.log.operation(a)!.status, f.log.operation(b)!.position], ["queued", 2]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    const first = f.result(a);
    const second = f.result(b);
    assert.ok(first?.type === "landed" && second?.type === "landed", JSON.stringify([first, second]));
    assert.equal(second.base, first.commitId);
  } finally { await f.dispose(); }
}, 120_000);
