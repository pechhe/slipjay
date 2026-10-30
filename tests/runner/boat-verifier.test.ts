import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { boatVerification, FENCE_SCRIPT, isSlotVm, loopbackPort, poolName, remoteCommand, REMOVE_CONTAINERS, worktreeTree } from "../../src/lib/runner/boat-verifier.ts";

const result = (stdout: string, exitCode = 0, stderr = ""): BoundedProcessResult => ({ stdout, stderr, stdoutTruncated: false, stderrTruncated: false,
  finishedAt: new Date().toISOString(), exitCode, signal: null, timedOut: false, cancelled: false, outputSha256: "" });

test("a remote command keeps the command's environment but never the runner host's paths", () => {
  const script = remoteCommand({ executable: "bun", args: ["run", "check:it's"], cwd: "/home/ubuntu/.slipjay/runner/verifiers/a/b/0",
    env: { PATH: "/runner/toolchains/bun/bin", HOME: "/home/ubuntu", SLIPJAY_SYSTEMD_SLICE: "x.slice", TMPDIR: "/tmp/s", SLIPJAY_TEST_REPORT_DIR: "/tmp/s/r", TOKEN: "a b" } }, "slipjay-run-1");
  assert.match(script, / mkdir -p '\/tmp\/s' '\/tmp\/s\/r' && cd '\/home\/ubuntu\/.slipjay\/runner\/verifiers\/a\/b\/0' && exec systemd-run --user --scope/);
  assert.match(script, /--unit='slipjay-run-1'/);
  assert.match(script, /'PATH=\/home\/user\/.bun\/bin:/);
  assert.doesNotMatch(script, /runner\/toolchains|x\.slice|HOME=\/home\/ubuntu/);
  assert.match(script, /'TOKEN=a b'/);
  assert.match(script, /'check:it'\\''s'/);
  assert.match(script, /^printf '%s\\n' '\/tmp\/s' '\/tmp\/s\/r' >> ~\/.slipjay-scratch && /, "the attempt's remote scratch is listed for cleaning");
});

test("a loopback Build URL is reached through a tunnel on the same port; any other URL is not", () => {
  assert.equal(loopbackPort("http://127.0.0.1:41234/v1"), 41234);
  assert.equal(loopbackPort("https://weave.example.com"), undefined);
  assert.equal(loopbackPort(undefined), undefined);
});

test("pool names are stable per repository and slot, and a named machine is never taken for a gate slot", () => {
  assert.equal(poolName("pechhe/YardSmith", 1), "slipjay-pechhe-yardsmith-1");
  assert.equal(poolName("pechhe/yardsmith", "images"), "slipjay-pechhe-yardsmith-images");
  assert.ok(isSlotVm("pechhe/yardsmith", "slipjay-pechhe-yardsmith-12"));
  assert.equal(poolName("pechhe/yardsmith", "2-screen"), "slipjay-pechhe-yardsmith-2-screen");
  assert.ok(isSlotVm("pechhe/yardsmith", "slipjay-pechhe-yardsmith-2-screen"));
  assert.ok(!isSlotVm("pechhe/yardsmith", "slipjay-pechhe-yardsmith-screen-images"));
  assert.ok(!isSlotVm("pechhe/yardsmith", "slipjay-pechhe-yardsmith-screen-0"), "a build machine named screen-0 is never a gate slot");
  assert.ok(!isSlotVm("pechhe/yardsmith", "slipjay-pechhe-yardsmith-images"));
  assert.ok(!isSlotVm("pechhe/yard", "slipjay-pechhe-yardsmith-1"));
});

/** A boat CLI and ssh stand-in: `sandboxes` is what `boat list` reports; every call is recorded. */
function stand(sandboxes: Record<string, unknown>[], ssh: (args: readonly string[]) => BoundedProcessResult = () => result("")) {
  const calls: string[][] = [];
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push([request.executable, ...request.args]);
    if (request.executable === "ssh") return ssh(request.args);
    const [command, id] = request.args;
    // Like boat, a plain `list` shows only running sandboxes; `--all` shows every state.
    if (command === "list") return result(JSON.stringify({ sandboxes: request.args.includes("--all") ? sandboxes : sandboxes.filter((vm) => vm.state !== "stopped") }));
    if (command === "fork") return result(JSON.stringify({ id: "bx_new", sandbox: { id: "bx_new", state: "provisioned", type: "default" } }));
    if (command === "info") return result(JSON.stringify({ sandbox: { id, name: "", state: "idle", type: "default", sshEndpoint: "198.51.100.1:19000", hydrated: true } }));
    return result(JSON.stringify({ ok: true }));
  };
  return { run, calls, boat: () => calls.filter(([executable]) => executable === "boat").map(([, command, ...rest]) => [command, ...rest.filter((arg) => !arg.startsWith("--json") && arg !== "--no-update")].join(" ")) };
}
const open = (verification: ReturnType<typeof boatVerification>, slot = 0) => verification.open({ repo: "pechhe/yardsmith", slot, checkout: "/nonexistent",
  base: "b".repeat(40), candidate: "c".repeat(40), integrationBranch: "develop", signal: new AbortController().signal });

test("a missing pool VM is forked from the image, named for its slot and renewed; a stopped one is resumed", async () => {
  const missing = stand([], (args) => args.at(-1) === "true" ? result("") : result("", 1, "stop here"));
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run: missing.run }), 1), /Remote executor unavailable \(setup\): clean/);
  assert.deepEqual(missing.boat().slice(0, 4), ["list --all", "fork bx_image --no-env --no-monitoring --ttl 10800 --type default", "rename bx_new slipjay-pechhe-yardsmith-1", "extend bx_new --ttl 10800"]);

  const stopped = stand([{ id: "bx_old", name: "slipjay-pechhe-yardsmith-0", state: "stopped" }], (args) => args.at(-1) === "true" ? result("") : result("", 1, "stop here"));
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run: stopped.run })));
  assert.deepEqual(stopped.boat().slice(0, 3), ["list --all", "resume bx_old", "extend bx_old --ttl 10800"]);
});

test("a resumed VM is not set up until boat has restored its disk", async () => {
  const stopped = stand([{ id: "bx_old", name: "slipjay-pechhe-yardsmith-0", state: "stopped" }], (args) => args.at(-1) === "true" ? result("") : result("", 1, "stop here"));
  let infos = 0;
  const events: string[] = [];
  const run = async (request: BoundedProcessRequest) => {
    if (request.executable === "boat" && request.args[0] === "info") {
      const hydrated = ++infos > 1;
      events.push(hydrated ? "restored" : "restoring");
      return result(JSON.stringify({ sandbox: { id: "bx_old", state: "idle", type: "default", sshEndpoint: "198.51.100.1:19000", hydrated } }));
    }
    if (request.executable === "ssh") events.push("ssh");
    return stopped.run(request);
  };
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run })));
  assert.deepEqual(events.slice(0, 3), ["restoring", "restored", "ssh"]);
});

test("a slot boat never restores is deleted and forked afresh from the image", async () => {
  const calls: string[][] = [];
  let slot = "bx_stuck";
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push([request.executable, ...request.args]);
    if (request.executable === "ssh") return request.args.at(-1) === "true" ? result("") : result("", 1, "stop here");
    const [command, id] = request.args;
    if (command === "list") return result(JSON.stringify({ sandboxes: slot ? [{ id: slot, name: "slipjay-pechhe-yardsmith-0", state: "idle" }] : [] }));
    if (command === "fork") return result(JSON.stringify({ id: "bx_new", sandbox: { id: "bx_new", state: "provisioned", type: "default" } }));
    if (command === "info") return result(JSON.stringify({ sandbox: { id, state: "idle", type: "default", sshEndpoint: "198.51.100.1:19000", hydrated: id !== "bx_stuck" } }));
    if (command === "delete") slot = "";
    return result(JSON.stringify({ ok: true }));
  };
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run, readyTimeoutMs: 0 })), /Remote executor unavailable \(setup\): clean on slipjay-pechhe-yardsmith-0/);
  const boat = () => calls.filter(([executable]) => executable === "boat").map(([, command, ...rest]) => [command, ...rest.filter((arg) => !arg.startsWith("--json") && arg !== "--no-update")].join(" "));
  assert.ok(boat().includes("delete bx_stuck --yes"), `a slot whose disk never restores is deleted: ${boat().join(", ")}`);
  assert.ok(boat().indexOf("delete bx_stuck --yes") < boat().indexOf("fork bx_image --no-env --no-monitoring --ttl 10800 --type default"), "the image is forked again after it");
  assert.ok(boat().includes("rename bx_new slipjay-pechhe-yardsmith-0"), "the fresh VM takes the slot's name");
  assert.ok(!boat().some((call) => call.startsWith("resume bx_stuck")), "the dead slot is never resumed again");
});

test("a replacement slot that also never restores fails as infrastructure, forking only once", async () => {
  const calls: string[][] = [];
  let slot = "bx_stuck";
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push([request.executable, ...request.args]);
    if (request.executable === "ssh") return result("", 1, "no answer");
    const [command, id] = request.args;
    if (command === "list") return result(JSON.stringify({ sandboxes: [{ id: slot, name: "slipjay-pechhe-yardsmith-0", state: "idle" }] }));
    if (command === "fork") { slot = "bx_new"; return result(JSON.stringify({ id: "bx_new", sandbox: { id: "bx_new", state: "provisioned", type: "default" } })); }
    if (command === "info") return result(JSON.stringify({ sandbox: { id, state: "idle", type: "default", sshEndpoint: "198.51.100.1:19000", hydrated: false } }));
    return result(JSON.stringify({ ok: true }));
  };
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run, readyTimeoutMs: 0 })), /slipjay-pechhe-yardsmith-0 not reachable: state idle, disk still restoring/);
  const boat = calls.filter(([executable]) => executable === "boat").map(([, command, ...rest]) => [command, ...rest.filter((arg) => !arg.startsWith("--json") && arg !== "--no-update")].join(" "));
  assert.equal(boat.filter((call) => call.startsWith("fork")).length, 1, "one replacement fork, never a loop");
  assert.equal(boat.filter((call) => call.startsWith("delete")).length, 1, "only the first broken slot is deleted");
});

test("a build machine whose disk does not restore fails without being replaced, so its warm build cache survives", async () => {
  const calls: string[][] = [];
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push([request.executable, ...request.args]);
    if (request.executable === "ssh") return result("", 1, "no answer");
    const [command, id] = request.args;
    if (command === "list") return result(JSON.stringify({ sandboxes: [{ id: "bx_images", name: "slipjay-pechhe-yardsmith-images", state: "stopped" }] }));
    if (command === "info") return result(JSON.stringify({ sandbox: { id, state: "idle", type: "large", sshEndpoint: "198.51.100.1:19000", hydrated: false } }));
    return result(JSON.stringify({ ok: true }));
  };
  const lease = boatVerification({ image: "bx_image", cli: "boat", run, readyTimeoutMs: 0 }).lease!({ repo: "pechhe/yardsmith", pool: "images", gitDirectory: "/nonexistent", commitId: "0".repeat(40), lifetimeS: 60 });
  await assert.rejects(lease, /slipjay-pechhe-yardsmith-images not reachable: state idle, disk still restoring/);
  const boat = calls.filter(([executable]) => executable === "boat").map(([, command]) => command);
  assert.ok(!boat.includes("delete") && !boat.includes("fork"), "the build machine is neither deleted nor forked again");
});

/** A boat CLI whose one pool VM is `live`, reporting the given `info` sandbox fields for each id. */
function degradedBuildMachine(info: (id: string) => Record<string, unknown>) {
  const calls: string[][] = [];
  let live = "bx_images";
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    calls.push([request.executable, ...request.args]);
    if (request.executable === "ssh") return request.args.at(-1) === "true" ? result("") : result("", 1, "stop here");
    const [command, id] = request.args;
    if (command === "list") return result(JSON.stringify({ sandboxes: live ? [{ id: live, name: "slipjay-pechhe-yardsmith-images", state: "idle", health: "degraded", hydrated: false }] : [] }));
    if (command === "fork") return result(JSON.stringify({ id: "bx_new", sandbox: { id: "bx_new", state: "provisioned", type: "large" } }));
    if (command === "info") return result(JSON.stringify({ sandbox: { id, name: "slipjay-pechhe-yardsmith-images", state: "idle", type: "large", sshEndpoint: "198.51.100.1:19000", ...info(id ?? "") } }));
    if (command === "delete") live = "";
    return result(JSON.stringify({ ok: true }));
  };
  const boat = () => calls.filter(([executable]) => executable === "boat").map(([, command, ...rest]) => [command, ...rest.filter((arg) => !arg.startsWith("--json") && arg !== "--no-update")].join(" "));
  return { run, boat };
}
const leaseImages = (run: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>, readyTimeoutMs: number) =>
  boatVerification({ image: "bx_image", cli: "boat", run, readyTimeoutMs }).lease!({ repo: "pechhe/yardsmith", pool: "images", gitDirectory: "/nonexistent", commitId: "0".repeat(40), lifetimeS: 60 });

test("a build machine boat reports degraded with its disk unrestored is replaced from the image", async () => {
  const stuck = { hydrated: false, health: "degraded", healthReason: "hydration stuck: dvol-hydrated: 4 path(s) under '__dockervol__/' still owed" };
  // The replacement is healthy, so only the setup after the lease (which has no repository) fails, as in the tests above.
  const machine = degradedBuildMachine((id) => id === "bx_images" ? stuck : { hydrated: true });
  await assert.rejects(leaseImages(machine.run, 60_000), /Remote executor unavailable \(setup\)/);
  assert.ok(machine.boat().includes("delete bx_images --yes"), `a degraded build machine is deleted: ${machine.boat().join(", ")}`);
  assert.ok(machine.boat().includes("fork bx_image --no-env --no-monitoring --ttl 1860 --type default"), "a fresh image is forked with the command's time and idle lifetime");
  assert.ok(machine.boat().includes("rename bx_new slipjay-pechhe-yardsmith-images"), "the fresh VM takes the machine's name");
});

test("a replacement build machine that is also degraded fails naming its health and reason, forking only once", async () => {
  const stuck = { hydrated: false, health: "degraded", healthReason: "hydration stuck: dvol-hydrated: 4 path(s) under '__dockervol__/' still owed" };
  const machine = degradedBuildMachine(() => stuck);
  await assert.rejects(leaseImages(machine.run, 60_000), /slipjay-pechhe-yardsmith-images not reachable: state idle, health degraded \(hydration stuck: dvol-hydrated: 4 path\(s\) under '__dockervol__\/' still owed\), disk still restoring/);
  assert.equal(machine.boat().filter((call) => call.startsWith("fork")).length, 1, "one replacement fork, never a loop");
  assert.equal(machine.boat().filter((call) => call.startsWith("delete")).length, 1, "only the first degraded machine is deleted");
});

test("a slot with two VMs under its name keeps the running one and deletes the other", async () => {
  const twice = stand([{ id: "bx_stale", name: "slipjay-pechhe-yardsmith-0", state: "stopped" }, { id: "bx_live", name: "slipjay-pechhe-yardsmith-0", state: "idle" }],
    (args) => args.at(-1) === "true" ? result("") : result("", 1, "stop here"));
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run: twice.run })));
  assert.deepEqual(twice.boat().slice(0, 3), ["list --all", "delete bx_stale --yes", "extend bx_live --ttl 10800"]);
});

test("boat refusing a VM names boat and its error, so it is never mistaken for a gate failure", async () => {
  const refused = stand([]);
  const run = async (request: BoundedProcessRequest) => request.args[0] === "fork"
    ? result(JSON.stringify({ code: "billing_required", error: "Start the $20/month Boat plan to create sandboxes" }), 1) : refused.run(request);
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run })), /^Error: Remote executor unavailable \(boat\): boat fork: Start the \$20\/month Boat plan/);
});

test("an ssh connection failure during setup names boat, not our setup", async () => {
  const lost = stand([{ id: "bx_old", name: "slipjay-pechhe-yardsmith-0", state: "idle" }],
    (args) => args.at(-1) === "true" ? result("") : result("", 255, "ssh: connect to host 198.51.100.1 port 19000: Connection refused"));
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run: lost.run })), /Remote executor unavailable \(boat\): clean on slipjay-pechhe-yardsmith-0/);
  assert.ok(lost.boat().includes("extend bx_old --ttl 900"), "a failed setup leaves its VM fifteen minutes, not the attempt's three hours");
});

test("boat API retries are bounded by the opening budget and report an availability failure", async () => {
  const timeouts: number[] = [];
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    timeouts.push(request.timeoutMs);
    return { ...result(""), exitCode: null, timedOut: true };
  };
  const started = Date.now();
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run, openRetryMs: 30, openRetryDelayMs: 1 })),
    (error: unknown) => Boolean((error as { boatUnavailable?: boolean }).boatUnavailable));
  assert.ok(timeouts.length > 1, "retried before giving up");
  assert.ok(Date.now() - started < 60_000);
  assert.ok(timeouts.every((ms) => ms <= 30_000), String(timeouts));
});

test("a VM forked but never named into its pool is deleted at recovery, retried until boat confirms, and recovery fails if it cannot", async () => {
  const pending = join(await mkdtemp(join(tmpdir(), "boat-pending-")), "forks");
  const interrupted = stand([], () => result(""));
  const run = async (request: BoundedProcessRequest) => request.args[0] === "rename" ? result(JSON.stringify({ error: "lost" }), 1) : interrupted.run(request);
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run, pending })), /boat rename/);
  await writeFile(join(pending, "bx_other"), "slipjay-pechhe-yardsmith-1");
  assert.deepEqual((await readdir(pending)).sort(), ["bx_new", "bx_other"], "each slot's fork has its own record");

  // Boat refuses bx_other's delete once, then takes it; bx_new is no longer listed at all.
  const refusing = stand([{ id: "bx_other", name: "", state: "idle" }]);
  let refusals = 0;
  const refuse = async (request: BoundedProcessRequest) => request.args[0] === "delete" && request.args[1] === "bx_other" && refusals++ === 0
    ? result("", 1, "busy") : refusing.run(request);
  await boatVerification({ image: "bx_image", cli: "boat", run: refuse, pending, recoveryMs: 2000 }).recover!(["pechhe/yardsmith"]);
  assert.ok(!refusing.boat().includes("delete bx_new --yes"), "a VM boat no longer lists only loses its record");
  assert.equal(refusals, 2, "a refused delete is retried within the same recovery");
  assert.deepEqual(await readdir(pending), []);

  await writeFile(join(pending, "bx_stuck"), "slipjay-pechhe-yardsmith-2");
  const stuck = stand([{ id: "bx_stuck", name: "", state: "idle" }]);
  const never = async (request: BoundedProcessRequest) => request.args[0] === "delete" ? result("", 1, "busy") : stuck.run(request);
  await assert.rejects(boatVerification({ image: "bx_image", cli: "boat", run: never, pending, recoveryMs: 500 }).recover!(["pechhe/yardsmith"]), /could not delete or clean bx_stuck/);
  assert.deepEqual(await readdir(pending), ["bx_stuck"], "an orphan boat would not delete keeps its record");
});

test("the lease's fence ends an earlier lease's sessions, kills one that ignores its terminate, and refuses the machine while one stays open", async () => {
  // A stand-in loginctl: this session (7), the desktop (c3), and an earlier lease's session (9), which ends on
  // terminate, only on SIGKILL, or never.
  const bin = await mkdtemp(join(tmpdir(), "slipjay-fence-"));
  const fence = (mode: "terminate" | "kill" | "never") => {
    const state = join(bin, mode);
    const ends = (when: boolean) => when ? `touch ${state}` : "exit 1";
    execFileSync("sh", ["-c", `cat > ${bin}/loginctl <<'EOF'\n#!/bin/sh\ncase "$1" in\n  list-sessions) echo "7 1000 user - - active no -"; echo "c3 1000 user seat0 tty7 active no -"; [ -e ${state} ] || echo "9 1000 user - - active no -";;\n  terminate-session) ${ends(mode === "terminate")};;\n  kill-session) ${ends(mode === "kill")};;\nesac\nEOF\nchmod +x ${bin}/loginctl`]);
    const script = FENCE_SCRIPT.replace("seq 1 10", "seq 1 1").replace("seq 1 50", "seq 1 1");
    try { execFileSync("bash", ["-c", `set -euo pipefail\n${script}`], { env: { PATH: `${bin}:/usr/bin:/bin`, XDG_SESSION_ID: "7" }, stdio: "pipe" }); return 0; }
    catch (error) { return (error as { status: number }).status; }
  };
  assert.equal(fence("terminate"), 0, "the earlier session ended");
  assert.equal(fence("kill"), 0, "a session that ignores its terminate is killed");
  assert.equal(fence("never"), 1, "a session that will not end refuses the lease");
});

test("the checkout's tree keeps a tracked file that matches an ignore rule", () => {
  const repo = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  execFileSync("bash", ["-c", `cd ${repo} && printf '*.log\\n' > .gitignore && echo kept > tracked.log && echo a > a.txt`]);
  git("add", ".gitignore", "a.txt"); git("add", "-f", "tracked.log"); git("commit", "-qm", "c");
  const tree = git("rev-parse", "HEAD^{tree}");
  execFileSync("bash", ["-c", `cd ${repo} && echo noise > other.log`]);
  const read = () => execFileSync("bash", ["-c", `set -euo pipefail\ncd ${repo}\n${worktreeTree(tree)}`], { encoding: "utf8" }).trim();
  assert.equal(read(), tree, "an unchanged checkout reads as the candidate");
  execFileSync("bash", ["-c", `cd ${repo} && echo changed > tracked.log && echo new > b.txt`]);
  assert.notEqual(read(), tree, "a change to it, or a new file, does not");
});

test("concurrent gate commands reaching Build share one tunnel per attempt", async () => {
  const ready = stand([{ id: "bx_old", name: "slipjay-pechhe-yardsmith-0", state: "idle" }],
    (args) => args.at(-1) === "true" ? result("") : result(`runtime /home/user/.bun/bin/bun 1.4.4 ${"a".repeat(64)}\ntree ${"e".repeat(40)}`));
  const run = async (request: BoundedProcessRequest) => request.executable === "git" ? result(request.args[0] === "rev-parse" ? "e".repeat(40) : "", request.args[0] === "bundle" ? 128 : 0, request.args[0] === "bundle" ? "Refusing to create empty bundle." : "")
    : request.executable === "bash" ? (ready.calls.push(["bash", ...request.args]), result("")) : ready.run(request);
  const scratch = await mkdtemp(join(tmpdir(), "boat-scratch-"));
  const attempt = await open(boatVerification({ image: "bx_image", cli: "boat", run, scratch }));
  const command = { executable: "bun", args: ["run", "check"], cwd: "/repo", timeoutMs: 1000, maxOutputBytes: 1024, env: { SLIPJAY_BUILD_READ_URL: "http://127.0.0.1:41234/v1" } };
  await Promise.all([attempt.executor.run(command), attempt.executor.run(command)]);
  assert.equal(ready.calls.filter(([executable]) => executable === "bash").length, 1, "one SSH master");
  assert.equal(ready.calls.filter((call) => call.includes("forward")).length, 1, "one forward of the port");
  assert.ok(!ready.calls.some((call) => call.includes("ExitOnForwardFailure=yes")), "no command opens its own listener");
  await attempt.close();
  assert.ok(ready.calls.some((call) => call.includes("-O") && call.includes("exit")), "the master closes with the attempt");
  assert.equal(ready.boat().at(-1), "extend bx_old --ttl 900", "a closed attempt leaves its VM fifteen minutes before boat stops it");
  assert.ok(ready.calls.some((call) => call.join(" ").includes("'\\''+refs/slipjay/boat/0/*:refs/slipjay/boat/0/*'\\''")),
    "the slot's refs are forced, since the next candidate need not descend from one that never landed");
});

/** A one-commit repository's Git directory and its commit. */
function repository() {
  const repo = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  execFileSync("bash", ["-c", `cd ${repo} && echo a > a.txt`]);
  git("add", "a.txt"); git("commit", "-qm", "c");
  return { gitDirectory: join(repo, ".git"), commitId: git("rev-parse", "HEAD") };
}

test("a build machine is leased under its pool's name with the command's lifetime, holds the commit, and idles once closed", async () => {
  const { gitDirectory, commitId } = repository();
  let billed = 100;
  const inputs: string[] = [];
  const scripts: string[] = [];
  const machine = stand([{ id: "bx_images", name: "slipjay-pechhe-yardsmith-images", state: "stopped" }], (args) => { scripts.push(args.at(-1) ?? ""); return result(""); });
  const run = async (request: BoundedProcessRequest) => {
    if (request.executable === "ssh" && request.input) inputs.push(request.input.toString("latin1"));
    if (request.executable === "git") return (await import("../../src/lib/infra/bounded-process.ts")).runBoundedProcess(request);
    return request.args[0] === "usage" ? result(JSON.stringify({ seconds: billed, dollars: billed / 100_000 })) : machine.run(request);
  };
  const scratch = await mkdtemp(join(tmpdir(), "boat-scratch-"));
  const lease = await boatVerification({ image: "bx_image", cli: "boat", run, scratch }).lease!({ repo: "pechhe/yardsmith", pool: "images", gitDirectory, commitId, lifetimeS: 1500 });
  assert.deepEqual(machine.boat().slice(0, 3), ["list --all", "resume bx_images", "extend bx_images --ttl 3300"], "the command's time plus the idle lifetime");
  assert.equal(lease.machine.name, "slipjay-pechhe-yardsmith-images");
  const fence = scripts.findIndex((script) => script.includes("loginctl terminate-session"));
  assert.ok(fence >= 0 && fence < scripts.findIndex((script) => script.includes("cat > /tmp/slipjay-machine.bundle")), "an earlier lease's sessions end before the commit arrives");
  assert.equal(lease.env.SLIPJAY_MACHINE_GIT_DIR, "/home/user/slipjay-machine.git");
  assert.ok(inputs.some((input) => input.startsWith("# v2 git bundle") || input.startsWith("# v3 git bundle")), "the commit is sent as a bundle");
  const ssh = await readFile(lease.env.SLIPJAY_MACHINE_SSH!, "utf8");
  assert.match(ssh, /^#!\/bin\/sh\nexec ssh .*'-p' '19000' 'user@198\.51\.100\.1' "\$@"\n$/);
  billed = 400;
  assert.deepEqual(await lease.close(), { seconds: 300, dollars: 0.003 });
  assert.equal(machine.boat().at(-1), "extend bx_images --ttl 1800", "a build machine idles thirty minutes");
  assert.deepEqual(await readdir(scratch), [], "the wrapper goes with the lease");
});

test("a build machine boat cannot supply fails naming boat", async () => {
  const refused = stand([]);
  const run = async (request: BoundedProcessRequest) => request.args[0] === "fork" ? result(JSON.stringify({ error: "out of starts" }), 1) : refused.run(request);
  await assert.rejects(boatVerification({ image: "bx_image", cli: "boat", run }).lease!({ repo: "pechhe/yardsmith", pool: "images", gitDirectory: "/nonexistent", commitId: "c".repeat(40), lifetimeS: 60 }),
    /^Error: Remote executor unavailable \(boat\): boat fork: out of starts/);
});

test("restart recovery cleans the gate's slot VMs and never a build machine", async () => {
  const pool = stand([{ id: "bx_0", name: "slipjay-pechhe-yardsmith-0", state: "idle", sshEndpoint: "198.51.100.1:19000" },
    { id: "bx_images", name: "slipjay-pechhe-yardsmith-images", state: "idle", sshEndpoint: "198.51.100.2:19000" }]);
  const run = async (request: BoundedProcessRequest) => request.args[0] === "list" ? result(JSON.stringify({ sandboxes: [
    { id: "bx_0", name: "slipjay-pechhe-yardsmith-0", state: "idle", sshEndpoint: "198.51.100.1:19000" },
    { id: "bx_images", name: "slipjay-pechhe-yardsmith-images", state: "idle", sshEndpoint: "198.51.100.2:19000" }] })) : pool.run(request);
  await boatVerification({ image: "bx_image", cli: "boat", run, recoveryMs: 1000 }).recover!(["pechhe/yardsmith"]);
  const cleaned = pool.calls.filter(([executable]) => executable === "ssh").map((args) => args.find((arg) => arg.startsWith("user@")));
  assert.deepEqual(cleaned, ["user@198.51.100.1"]);
});

test("screen slots are separate from authoritative slots and recovery cleans every screen slot", async () => {
  const missing = stand([], (args) => args.at(-1) === "true" ? result("") : result("", 1, "stop here"));
  await assert.rejects(boatVerification({ image: "bx_image", cli: "boat", run: missing.run }).open({
    repo: "pechhe/yardsmith", slot: 2, screening: true, checkout: "/nonexistent", base: "b".repeat(40),
    candidate: "c".repeat(40), integrationBranch: "develop", signal: new AbortController().signal,
  }));
  assert.ok(missing.boat().includes("rename bx_new slipjay-pechhe-yardsmith-2-screen"));
  const pool = stand(Array.from({ length: 3 }, (_, i) => ({ id: `bx_${i}`, name: `slipjay-pechhe-yardsmith-${i}-screen`,
    state: "idle", sshEndpoint: `198.51.100.${i + 1}:19000` })));
  await boatVerification({ image: "bx_image", cli: "boat", run: pool.run, recoveryMs: 1000 }).recover!(["pechhe/yardsmith"]);
  assert.equal(pool.calls.filter(([executable]) => executable === "ssh").length, 3);
});

test("cleaning removes every container but the image's keep- and slipjay.keep ones", async () => {
  const bin = await mkdtemp(join(tmpdir(), "fake-docker-"));
  try {
    const removed = join(bin, "removed");
    await writeFile(join(bin, "docker"), `#!/bin/sh
if [ "$1" = ps ]; then printf 'keep-postgres \\n4c8aqwxmo7iwveog98zdr1jy true\\nleftover-test \\nother false\\n'; else shift 2; echo "$@" >> ${removed}; fi
`, { mode: 0o755 });
    const result = spawnSync("sh", ["-c", REMOVE_CONTAINERS], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(await readFile(removed, "utf8"), "leftover-test other\n");
  } finally { await rm(bin, { recursive: true, force: true }); }
});


test("a short boat API outage retries opening and succeeds without repeating a gate", async () => {
  const ready = stand([{ id: "bx_old", name: "slipjay-pechhe-yardsmith-0", state: "idle" }],
    (args) => args.at(-1) === "true" ? result("") : result(`runtime /home/user/.bun/bin/bun 1.4.4 ${"a".repeat(64)}\ntree ${"e".repeat(40)}`));
  let lists = 0;
  const run = async (request: BoundedProcessRequest) => {
    if (request.executable === "boat" && request.args[0] === "list" && ++lists < 3)
      return result("", 1, "could not reach the Boat API: connection refused");
    if (request.executable === "git") return result(request.args[0] === "rev-parse" ? "e".repeat(40) : "", request.args[0] === "bundle" ? 128 : 0, request.args[0] === "bundle" ? "Refusing to create empty bundle." : "");
    return ready.run(request);
  };
  const scratch = await mkdtemp(join(tmpdir(), "boat-retry-"));
  try {
    const attempt = await open(boatVerification({ image: "bx_image", cli: "boat", run, scratch, openRetryMs: 1000, openRetryDelayMs: 1 }));
    assert.equal(lists, 3);
    await attempt.close();
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("a kill interrupts the opening backoff promptly", async () => {
  const controller = new AbortController();
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  const verification = boatVerification({ image: "bx_image", cli: "boat", openRetryDelayMs: 30_000,
    run: async () => { failed(); return result("", 1, "could not reach the Boat API"); } });
  const opening = verification.open({ repo: "pechhe/yardsmith", slot: 0, checkout: "/nonexistent", base: "b".repeat(40), candidate: "c".repeat(40), integrationBranch: "main", signal: controller.signal });
  await failure;
  const started = Date.now();
  controller.abort();
  await assert.rejects(opening, /abort/i);
  assert.ok(Date.now() - started < 1000);
});

test("a timed-out fork is not repeated because boat may already have created it", async () => {
  const fake = stand([]);
  let forks = 0;
  const run = async (request: BoundedProcessRequest) => {
    if (request.args[0] === "fork") { forks++; return { ...result(""), timedOut: true, exitCode: null }; }
    return fake.run(request);
  };
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run })), /no answer from boat/);
  assert.equal(forks, 1);
});


test("an availability probe accepts an API refusal but keeps holding when the API is unreachable", async () => {
  const signal = new AbortController().signal;
  await boatVerification({ image: "bx_image", cli: "boat", run: async () => result(JSON.stringify({ error: "unauthorized" }), 1) }).probe!(signal);
  await assert.rejects(boatVerification({ image: "bx_image", cli: "boat", run: async () => result("", 1, "could not reach the Boat API") }).probe!(signal), /could not reach/);
});

test("boat's rate limit is an availability failure, retried and held like an outage", async () => {
  let calls = 0;
  const run = async (): Promise<BoundedProcessResult> => { calls += 1; return result(JSON.stringify({ error: "Rate limit exceeded: 10000 requests per minute" }), 1); };
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run, openRetryMs: 30, openRetryDelayMs: 1 })),
    (error: unknown) => Boolean((error as { boatUnavailable?: boolean }).boatUnavailable));
  assert.ok(calls > 1, "retried before giving up");
});
