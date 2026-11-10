import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { machineConnections, machineSshArgs, machineVerification } from "../../src/lib/runner/machine-verifier.ts";
import { shellWord } from "../../src/lib/runner/remote-attempt.ts";

const tree = "e".repeat(40);
const result = (stdout = "", exitCode = 0, stderr = ""): BoundedProcessResult => ({ stdout, stderr, stdoutTruncated: false, stderrTruncated: false, finishedAt: new Date().toISOString(), exitCode, signal: null, timedOut: false, cancelled: false, outputSha256: "" });
function stand() {
  const scripts: string[] = [];
  const bundles: string[][] = [];
  let heads: string[] = [];
  let fetchFailures = 0;
  let reinitialiseFailure = false;
  let cleanAllowed = true;
  let reachable = true;
  let setup = true;
  let drift = false;
  let lost = false;
  let clientKilled = false;
  let basePolicy = "";
  let cancelled = false;
  let archive = "";
  let held = false;
  let tunnelFailure = false;
  let memoryBefore = "memory - -";
  let memoryAfter = "memory - -";
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    if (request.executable === "tar") return runBoundedProcess(request);
    if (request.executable === "git") {
      if (request.args[0] === "bundle") { bundles.push([...request.args]); return result("", 128, "Refusing to create empty bundle."); }
      if (request.args[0] === "show") return basePolicy ? result(basePolicy) : result("", 128, "fatal: path does not exist");
      return result(request.args[0] === "rev-parse" ? tree : "");
    }
    if (request.args.includes("forward")) return tunnelFailure ? result("", 1, "forward refused") : result("48123");
    if (request.executable === "bash" || request.args.includes("exit")) return result();
    const command = request.args.at(-1)!;
    const script = command.startsWith("bash -lc ") ? command.slice("bash -lc ".length + 1, -1).replaceAll("'\\''", "'") : command;
    execFileSync("bash", ["-n"], { input: script });
    scripts.push(script);
    if (!reachable) return result("", 255, "ssh: Connection refused");
    // Taking the place recovers a stale holder in the same script (SJ-223); a clean the machine refuses fails it.
    if (script.includes("slipjay-prepare-")) return cleanAllowed ? result(heads.join("\n")) : result("", 1, "cgroup still populated");
    if (script.includes("docker ps -aq")) return cleanAllowed ? result() : result("", 1, "cgroup still populated");
    if (script.includes('echo "$HOME"')) return result("/home/ubuntu");
    if (script.includes("slipjay-reinitialise-")) {
      if (reinitialiseFailure) return result("", 1, "checkout reinitialisation failed");
      heads = []; return result();
    }
    if (script.includes("slipjay-receive-")) {
      if (fetchFailures-- > 0) return result("", 1, "corrupt object store: fetch failed");
      heads = ["c".repeat(40), "b".repeat(40)]; return result();
    }
    if (script.includes("--frozen-lockfile")) return setup ? result(`runtime /home/ubuntu/.bun/bin/bun 1.4.4 ${"a".repeat(64)}\ntree ${tree}\n${memoryBefore}`) : result("", 1, "install failed");
    if (script.includes("slipjay-command-")) {
      if (lost) return result("", 255, "ssh: Connection reset");
      if (clientKilled) return { ...result("", 143), signal: "SIGTERM" };
      if (held && request.abortSignal) {
        await new Promise<void>((resolve) => { if (request.abortSignal!.aborted) resolve(); else request.abortSignal!.addEventListener("abort", () => resolve(), { once: true }); });
        cancelled = true; return { ...result(), cancelled: true };
      }
      return result("gate passed");
    }
    if (script.includes("tar -C")) return result(archive);
    if (script.includes("git write-tree")) return result(`${drift ? "changed" : tree}\n${memoryAfter}`);
    return result();
  };
  const make = (place?: number, check = false) => machineVerification("peach-box", { ssh: "peach-box", root: "/gate-root", account: "ubuntu" }, { run, ...place === undefined ? {} : { place }, ...check ? { check } : {} });
  return { scripts, bundles, make, corrupt: (failReset = false) => { fetchFailures = 1; reinitialiseFailure = failReset; }, refuseTunnel: () => { tunnelFailure = true; }, hold: () => { held = true; }, clean: (value: boolean) => { cleanAllowed = value; }, reachable: (value: boolean) => { reachable = value; }, setup: (value: boolean) => { setup = value; }, drift: () => { drift = true; }, lose: () => { lost = true; }, killClient: () => { clientKilled = true; }, policy: (value: string) => { basePolicy = value; }, cancelled: () => cancelled, report: (value: string) => { archive = value; }, memory: (before: string, after: string) => { memoryBefore = `memory ${before}`; memoryAfter = `memory ${after}`; } };
}
const open = (m: ReturnType<typeof machineVerification>, environment?: NodeJS.ProcessEnv) => m.open({ environment, repo: "pechhe/yardsmith", slot: 0, screening: true, checkout: "/runner/checkout", base: "b".repeat(40), candidate: "c".repeat(40), integrationBranch: "develop", signal: new AbortController().signal });
const command = { executable: "bun", args: ["run", "test"], cwd: "/runner/checkout", timeoutMs: 1000, maxOutputBytes: 1024 };

test("a gate works in the candidate itself, while a release check or audit works in an empty child of the commit it verifies", async () => {
  // git status in a colocated checkout compares against @'s parent: a check needs that parent to be the verified commit.
  const s = stand();
  const receive = () => s.scripts.findLast((script) => script.includes("slipjay-receive-"))!;
  const gate = s.make(1);
  await gate.recover!([]);
  await (await open(gate)).close();
  assert.match(receive(), new RegExp(`jj edit '[\\\\']*${"c".repeat(40)}`));
  assert.doesNotMatch(receive(), /jj new /);
  const check = s.make(undefined, true);
  await check.recover!([]);
  await (await open(check)).close();
  assert.match(receive(), new RegExp(`jj new '[\\\\']*${"c".repeat(40)}`));
  assert.doesNotMatch(receive(), /jj edit /);
});

test("fixed SSH attempt transfers the candidate, isolates command paths and labels, detects drift and cleans only its owner", async () => {
  const s = stand(), m = s.make();
  assert.equal(m.available(), false, "startup is quarantined");
  await m.recover!([]); assert.equal(m.available(), true);
  const a = await open(m);
  assert.equal(m.available(), false);
  await assert.rejects(open(m), /busy/);
  assert.equal(a.executor.host, "machine:peach-box");
  assert.equal((await a.executor.run(command)).stdout, "gate passed");
  s.drift(); assert.equal((await a.finish()).tree, null);
  await a.close(); assert.equal(m.available(), true);
  const gate = s.scripts.find((script) => script.includes("slipjay-command-"))!;
  const label = gate.match(/SLIPJAY_DOCKER_LABEL=slipjay.attempt=([a-f0-9]{32})/)![1]!;
  assert.ok(gate.includes(`SLIPJAY_ATTEMPT_ID=${label}`));
  assert.ok(gate.includes(`SLIPJAY_RESOURCE_PREFIX=sj_${label}`));
  assert.ok(gate.includes("/gate-root/checkout"));
  assert.ok(gate.includes(`--slice='slipjay-attempt-${label}.slice'`));
  assert.ok(s.scripts.some((script) => script.includes("--frozen-lockfile")));
  const cleanup = s.scripts.findLast((script) => script.includes("docker rm"))!;
  assert.ok(cleanup.includes(shellWord(`label=slipjay.attempt=${label}`)));
  assert.doesNotMatch(cleanup, /prune|slipjay-run-\*|chown|keep-/);
});

test("SSH loss with work alive quarantines across restart until recovery proves cleanup, with no gate replay", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const a = await open(m); s.lose(); s.clean(false);
  await assert.rejects(a.executor.run(command), /executor lost/);
  await assert.rejects(a.close(), /cleanup unconfirmed/);
  assert.equal(m.available(), false);
  const restarted = s.make(); await restarted.recover!([]);
  assert.equal(restarted.available(), false);
  await assert.rejects(open(restarted), /cgroup still populated/);
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-command-")).length, 1);
  s.clean(true); await restarted.recover!([]); assert.equal(restarted.available(), true);
});

test("cancellation stops the exact command scope; setup and unreachable failures stay before gate execution", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const a = await open(m), controller = new AbortController();
  s.hold();
  const pending = a.executor.run({ ...command, abortSignal: controller.signal }); controller.abort();
  assert.equal((await pending).cancelled, true); assert.equal(s.cancelled(), true);
  assert.ok(s.scripts.some((script) => /systemctl --user stop 'slipjay-command-[a-f0-9]+-/.test(script)));
  await a.close();
  s.setup(false); await assert.rejects(open(m), /install failed/);
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-command-") && script.includes("systemd-run")).length, 1);
  s.reachable(false); await assert.rejects(open(m), /Connection refused/); assert.equal(m.available(), false);
});

test("the Build reverse-forward uses a dynamically allocated port and rewrites the command URL", async () => {
  const s = stand(), m = s.make(); await m.recover!([]); const a = await open(m);
  await a.executor.run({ ...command, env: { SLIPJAY_BUILD_READ_URL: "http://127.0.0.1:41234/v1" } });
  assert.ok(s.scripts.some((script) => script.includes("SLIPJAY_BUILD_READ_URL=http://127.0.0.1:48123/v1")));
  await a.close();
});

test("restart cleanup removes owned containers, anonymous volumes, networks and debris while retaining warm place data", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "machine-clean-"));
  try {
    const s = stand(), m = s.make(); await m.recover!([]); const a = await open(m);
    await a.executor.run(command); await a.close();
    await s.make().recover!([]);
    const id = s.scripts.find((script) => script.includes("SLIPJAY_ATTEMPT_ID="))!.match(/SLIPJAY_ATTEMPT_ID=([a-f0-9]{32})/)![1]!;
    await mkdir(join(root, "holder")); await writeFile(join(root, "holder", "id"), id);
    await mkdir(join(root, id)); await writeFile(join(root, id, "owned"), "attempt");
    await writeFile(join(root, "development"), "must survive");
    await mkdir(join(root, "bun-cache")); await writeFile(join(root, "bun-cache", "warm"), "cached package");
    const checkout = join(root, "checkout");
    execFileSync("git", ["init", "--quiet", checkout]);
    await writeFile(join(checkout, "tracked"), "candidate"); execFileSync("git", ["-C", checkout, "add", "tracked"]);
    await mkdir(join(checkout, "node_modules")); await writeFile(join(checkout, "node_modules", "warm"), "vitest cache");
    await writeFile(join(checkout, "untracked"), "gate debris");
    await writeFile(join(root, "anonymous-volume"), "pgvector anonymous volume");
    const cleanup = s.scripts.findLast((script) => script.includes("docker rm"))!.replaceAll("/gate-root", root);
    const wrapper = `flock() { :; }
systemctl() { case "$*" in *LoadState*) echo loaded;; esac; }
docker() {
  case "$*" in
    'ps -aq --filter label=slipjay.attempt=${id}') [ -f ${shellWord(join(root, "container-removed"))} ] || echo owned-container ;;
    'volume ls -q --filter label=slipjay.attempt=${id}') [ -f ${shellWord(join(root, "volume-removed"))} ] || echo owned-volume ;;
    'rm -f -v owned-container') touch ${shellWord(join(root, "container-removed"))}; rm -f ${shellWord(join(root, "anonymous-volume"))} ;;
    'volume rm owned-volume') touch ${shellWord(join(root, "volume-removed"))} ;;
    'network ls -q --filter label=slipjay.attempt=${id}') [ -f ${shellWord(join(root, "network-removed"))} ] || echo owned-network ;;
    'network rm owned-network') touch ${shellWord(join(root, "network-removed"))} ;;
    *) echo 'unexpected Docker selection' >&2; return 1 ;;
  esac
  return 0
}
${cleanup}`;
    const stuckNetwork = wrapper.replace(`touch ${shellWord(join(root, "network-removed"))}`, ":");
    assert.throws(() => execFileSync("bash", ["-c", stuckNetwork]), "a network remaining after removal must fail cleanup");
    assert.equal(await readFile(join(root, "holder", "id"), "utf8"), id, "unconfirmed cleanup retains the holder");
    execFileSync("bash", ["-c", wrapper]);
    assert.equal(await readFile(join(root, "bun-cache", "warm"), "utf8"), "cached package");
    assert.equal(await readFile(join(checkout, "tracked"), "utf8"), "candidate");
    assert.equal(await readFile(join(checkout, "node_modules", "warm"), "utf8"), "vitest cache");
    await assert.rejects(readFile(join(checkout, "untracked")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "anonymous-volume")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "network-removed"), "utf8"), "");
    assert.equal(await readFile(join(root, "development"), "utf8"), "must survive");
    await assert.rejects(readFile(join(root, id, "owned")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "holder", "id")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "container-removed"), "utf8"), "");
    assert.equal(await readFile(join(root, "volume-removed"), "utf8"), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports collected from a different remote root retain repository-relative file paths", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readTestReports, TEST_REPORT_MANIFEST } = await import("../../src/lib/runner/test-reports.ts");
  const root = await mkdtemp(join(tmpdir(), "machine-reports-"));
  const output = await mkdtemp(join(tmpdir(), "machine-evidence-"));
  const s = stand(), m = s.make(); await m.recover!([]); const a = await open(m);
  try {
    await writeFile(join(root, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [{ format: "vitest-json", path: "vitest.json", suite: "gate" }] }));
    await writeFile(join(root, "vitest.json"), JSON.stringify({ testResults: [{ name: `${a.executor.reportRoot}/tests/example.test.ts`, startTime: 1, endTime: 17, status: "passed" }] }));
    s.report(execFileSync("tar", ["-C", root, "-cf", "-", "."]).toString("base64"));
    await a.executor.run({ ...command, cwd: "/runner/checkout/packages/api", env: { SLIPJAY_TEST_REPORT_DIR: output } });
    const reading = await readTestReports(output, a.executor.reportRoot!);
    assert.equal(reading.status, "recorded", JSON.stringify(reading));
    if (reading.status === "recorded") assert.deepEqual(reading.files, [{ file: "tests/example.test.ts", suite: "gate", ms: 16, status: "passed" }]);
    assert.ok(s.scripts.some((script) => script.includes(`${a.executor.reportRoot}/packages/api`)));
  } finally { await a.close(); await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test("opening waits for the last attempt's cleanup still running, so a batch check's next commit never finds the place busy", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const first = await open(m);
  const closed = first.close();
  assert.equal(m.available(), false, "the place is held until its cleanup is confirmed");
  const next = await open(m);
  await closed;
  assert.equal(m.available(), false, "the next attempt holds the place");
  await next.close(); assert.equal(m.available(), true);
  // A place held by a running attempt, not a closing one, is still refused at once.
  const held = await open(m);
  await assert.rejects(open(m), /busy/);
  await held.close();
});

test("closing an attempt cancels in-flight commands and refuses late scopes before releasing its place", async () => {
  const s = stand(), m = s.make(); await m.recover!([]); const a = await open(m);
  s.hold();
  const pending = a.executor.run(command);
  await a.close();
  assert.equal((await pending).cancelled, true);
  assert.equal(m.available(), true);
  const before = s.scripts.length;
  await assert.rejects(a.executor.run(command), /abort/i);
  assert.equal(s.scripts.length, before, "a closed attempt cannot create a late scope");
});


test("a Build tunnel failure is reported during setup before any gate command starts", async () => {
  const s = stand(), m = s.make(); await m.recover!([]); s.refuseTunnel();
  await assert.rejects(open(m, { SLIPJAY_BUILD_READ_URL: "http://127.0.0.1:41234/v1" }), /forward refused/);
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-command-")).length, 0);
  assert.equal(m.available(), true, "confirmed setup cleanup releases the place");
});


test("successive attempts transfer only missing commits and retain the place checkout and install cache", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const first = await open(m); await first.executor.run(command); await first.close();
  const second = await open(m); await second.executor.run(command); await second.close();
  assert.equal(first.executor.reportRoot, "/gate-root/checkout");
  assert.equal(second.executor.reportRoot, first.executor.reportRoot);
  assert.equal(s.bundles.length, 2);
  assert.deepEqual(s.bundles[0]!.filter((arg) => arg.startsWith("^")), []);
  assert.deepEqual(s.bundles[1]!.filter((arg) => arg.startsWith("^")), ["^" + "c".repeat(40), "^" + "b".repeat(40)]);
  const commands = s.scripts.filter((script) => script.includes("slipjay-command-"));
  assert.equal(commands.length, 2);
  for (const script of commands) assert.ok(script.includes("BUN_INSTALL_CACHE_DIR=/gate-root/bun-cache"));
  const ids = commands.map((script) => script.match(/SLIPJAY_ATTEMPT_ID=([a-f0-9]{32})/)![1]);
  assert.notEqual(ids[0], ids[1], "scratch, labels and scopes retain separate attempt identities");
});

test("opening a place takes one round trip before the candidate's transfer: recovery, hold, quota and checkout preparation together (SJ-223)", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const before = s.scripts.length;
  const first = await open(m); await first.close();
  const opened = s.scripts.length;
  const second = await open(m); await second.close();
  const untilReceive = (scripts: string[]) => scripts.slice(0, scripts.findIndex((script) => script.includes("slipjay-receive-")));
  // The first open asks the machine for the account's home once; every open then takes the place in one script.
  assert.deepEqual(untilReceive(s.scripts.slice(before, opened)).map((script) => script.includes('echo "$HOME"') ? "home" : "acquire"), ["home", "acquire"]);
  const [acquire] = untilReceive(s.scripts.slice(opened));
  assert.equal(untilReceive(s.scripts.slice(opened)).length, 1);
  for (const part of ["flock -n 9", "mkdir '/gate-root/holder'", "quota-ready", "slipjay-prepare-", "for-each-ref"]) assert.ok(acquire!.includes(part), part);
  // A holder a crashed gate left is cleaned under the same lock, before this attempt takes the place.
  assert.ok(acquire!.indexOf("docker ps -aq") < acquire!.indexOf("mkdir '/gate-root/holder'"));
  // The lock is released before the checkout's preparation runs in the attempt's slice.
  assert.ok(acquire!.indexOf("exec 9>&-") < acquire!.indexOf("slipjay-prepare-"));
  assert.deepEqual(Object.keys(second.steps ?? {}).sort(), ["acquire", "setup", "transfer"]);
});

test("a machine's further places keep their own checkout and holder, and share its install cache and quota marker", async () => {
  const s = stand(), m = s.make(2); await m.recover!([]);
  const attempt = await open(m); await attempt.executor.run(command); await attempt.close();
  assert.equal(attempt.executor.reportRoot, "/gate-root/place-2/checkout");
  assert.equal(attempt.machine.id, "peach-box/2");
  assert.ok(s.scripts.filter((script) => script.includes("slipjay-command-")).every((script) => script.includes("SLIPJAY_GATE_PLACE=2") && script.includes("SLIPJAY_GATE_PLACES=")), "each gate knows its place");
  const commands = s.scripts.filter((script) => script.includes("slipjay-command-"));
  assert.ok(commands.every((script) => script.includes("BUN_INSTALL_CACHE_DIR=/gate-root/bun-cache")));
  assert.ok(s.scripts.some((script) => script.includes("/gate-root/quota-ready")));
  assert.ok(s.scripts.some((script) => script.includes("/gate-root/place-2/control.lock")));
  assert.ok(!s.scripts.some((script) => script.includes("/gate-root/control.lock")), "place 2 never takes place 0's lock");
});

test("a corrupt warm checkout is reinitialised during setup and retried with a full bundle once", async () => {
  const s = stand(), m = s.make(); await m.recover!([]);
  const first = await open(m); await first.close();
  s.corrupt();
  const next = await open(m); await next.executor.run(command); await next.close();
  assert.equal(s.bundles.length, 3);
  assert.equal(s.bundles[1]!.filter((arg) => arg.startsWith("^")).length, 2);
  assert.equal(s.bundles[2]!.filter((arg) => arg.startsWith("^")).length, 0);
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-reinitialise-")).length, 1);
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-command-")).length, 1);

  s.corrupt(true);
  await assert.rejects(open(m), (error: unknown) => /checkout reinitialisation failed/.test(String(error)) && Boolean((error as { remote?: unknown }).remote));
  assert.equal(s.scripts.filter((script) => script.includes("slipjay-command-")).length, 1, "failed repair never starts a gate");
});

test("a gate's memory peak and the kills its machine limit made during it reach its evidence, and unreadable counters are left out", async () => {
  const s = stand(), m = s.make();
  await m.recover!([]);
  s.memory("1024 5", `${41 * 1024 ** 3} 7`);
  const a = await open(m);
  assert.deepEqual((await a.finish()).memory, { peakBytes: 41 * 1024 ** 3, oomKills: 2 }, "kills before the attempt are not its own");
  await a.close();
  // The attempt's own slice counts its whole CPU time, setup included (SJ-202).
  s.memory("1024 5 1000000", `${2 * 1024 ** 3} 5 91000000`);
  const c = await open(m);
  assert.deepEqual((await c.finish()).memory, { peakBytes: 2 * 1024 ** 3, oomKills: 0, cpuMs: 91_000 });
  await c.close();
  s.memory("- -", "- -");
  const b = await open(m);
  assert.equal((await b.finish()).memory, undefined);
  await b.close();
});

test("an ssh client killed by a signal mid-command is a lost machine, not the candidate's failing check", async () => {
  const s = stand(), m = s.make();
  await m.recover!([]);
  const a = await open(m);
  s.killClient();
  await assert.rejects(a.executor.run(command), /executor lost: ssh to machine peach-box \(ssh ended by SIGTERM\)/);
  assert.equal(m.available(), false, "the place is quarantined until recovery");
  await a.close().catch(() => undefined);
});

test("the place keeps only the untracked paths the base's policy declares, and refuses malformed ones", async () => {
  const s = stand(), m = s.make();
  await m.recover!([]);
  // Too broad to be a declared generated or cache path: `*`, `apps`, `**/x`, `*/*`.
  s.policy(JSON.stringify({ placeRetainedPaths: ["apps/web/.svelte-kit", "apps/web/src/paraglide", "../escape", "/abs", "-x", "a;rm -rf", "*", "apps", "**/.svelte-kit", "*/*"] }));
  const before = s.scripts.length;
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
  const a = await open(m).finally(() => { console.error = consoleError; });
  // Refused patterns are named on the runner's log, never dropped silently.
  assert.ok(logged.some((line) => line.includes("ignores placeRetainedPaths") && line.includes('"*"') && line.includes('"**/.svelte-kit"') && !line.includes("apps/web/.svelte-kit")));
  const cleans = s.scripts.slice(before).filter((script) => script.includes("clean -ffdxq") && /slipjay-(prepare|receive)-/.test(script));
  assert.equal(cleans.length, 2, "the setup and receive cleans, after the policy is read");
  for (const clean of cleans) {
    const exclusions = clean.slice(clean.indexOf("clean -ffdxq")).split("\n")[0]!;
    assert.ok(exclusions.includes("apps/web/.svelte-kit") && exclusions.includes("apps/web/src/paraglide"));
    assert.doesNotMatch(exclusions, /escape|\/abs|-x\b|rm -rf|-e '\*'|-e 'apps'|\*\*|'\*\/\*'/);
    assert.ok(exclusions.includes("node_modules") && exclusions.includes(".jj"));
  }
  await a.close();
  s.policy("");
  const b = await open(m);
  const latest = s.scripts.findLast((script) => script.includes("jj edit"))!;
  assert.doesNotMatch(latest, /svelte-kit/, "no policy at the base keeps nothing extra");
  await b.close();
});

test("the runner shares one SSH connection per machine and account; without its directory each command connects alone (SJ-200)", () => {
  const home = mkdtempSync(join(tmpdir(), "machine-ssh-"));
  try {
    const connections = join(home, "ssh");
    const shared = machineSshArgs({ account: "ubuntu", ssh: "peach-box" }, connections);
    assert.ok(shared.includes("ControlMaster=auto") && shared.includes("ControlPersist=600"));
    assert.ok(shared.includes("ControlPath=" + join(connections, "master")));
    assert.equal(statSync(connections).mode & 0o777, 0o700);
    assert.deepEqual(shared.slice(-3), ["-l", "ubuntu", "peach-box"]);
    assert.ok(!machineSshArgs({ account: "ubuntu", ssh: "peach-box" }).some((argument) => argument.startsWith("Control")));
    // Each place, the check place, the build lease and the host reader get their own connection, so a gate's parallel
    // commands stay within sshd's MaxSessions; the socket path stays inside the 108-byte limit with ssh's suffix.
    const users = [0, 1, 2, "check", "build", "host"] as const;
    const directories = users.map((user) => machineConnections("/home/ubuntu/.slipjay/runner", "peach-box", user));
    assert.equal(new Set(directories).size, users.length);
    for (const directory of directories) assert.ok(Buffer.byteLength(join(directory, "master")) + ".XXXXXXXXXXXXXXXX".length < 108);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
