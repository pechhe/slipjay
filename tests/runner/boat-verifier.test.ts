import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boatVerification, loopbackPort, poolName, remoteCommand, worktreeTree } from "../../src/lib/runner/boat-verifier.ts";

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

test("pool names are stable per repository and slot", () => {
  assert.equal(poolName("pechhe/YardSmith", 1), "slipjay-pechhe-yardsmith-1");
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
    if (command === "info") return result(JSON.stringify({ sandbox: { id, name: "", state: "idle", type: "default", sshEndpoint: "198.51.100.1:19000" } }));
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
});

test("boat API calls are each bounded, so an unreachable API fails the attempt within a minute", async () => {
  const timeouts: number[] = [];
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    timeouts.push(request.timeoutMs);
    return { ...result(""), exitCode: null, timedOut: true };
  };
  const started = Date.now();
  await assert.rejects(open(boatVerification({ image: "bx_image", cli: "boat", run })), /Remote executor unavailable \(boat\): boat list: no answer from boat within 30s/);
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
