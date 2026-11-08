import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { awaitHostBudget, overHostBudget, parseHostLoad, type HostShell } from "../../src/lib/runner/host-budget.ts";

/** A host whose readings come from a list, and a clock each sleep moves on; a claim answers from `claims`, then succeeds. */
function host(readings: readonly string[], claims: string[] = []) {
  let clock = 0, read = 0, marks = 0;
  const shell: HostShell = async (script) => {
    if (script.includes("flock")) { marks += 1; return claims.shift() ?? "claimed\n"; }
    return readings[Math.min(read++, readings.length - 1)]!;
  };
  return { shell, now: () => clock, sleep: async (ms: number) => { clock += ms; }, marks: () => marks };
}
const reading = (load1: number, load5: number) => `${load1} ${load5} 1.00 1/100 200\n32\n`;

test("the load figures read from a host are parsed, and anything else has no budget to keep", () => {
  assert.deepEqual(parseHostLoad(reading(3, 4)), { load1: 3, load5: 4, cpus: 32 });
  assert.equal(parseHostLoad("cat: /proc/loadavg: No such file or directory\n"), null);
  assert.equal(parseHostLoad(""), null);
});

test("a gate may run up to the host's CPUs; background work leaves a quarter free", () => {
  const load = (load1: number, load5: number) => ({ load1, load5, cpus: 32 });
  assert.equal(overHostBudget(load(30, 20), "gate"), null);
  assert.match(overHostBudget(load(33, 20), "gate")!, /load 33\.0 is over 32\.0 of its 32 CPUs/);
  assert.match(overHostBudget(load(5, 33), "gate")!, /load 33\.0/, "the larger figure decides");
  assert.match(overHostBudget(load(25, 20), "background")!, /over 24\.0 of its 32 CPUs/);
  assert.equal(overHostBudget(load(24, 20), "background"), null);
});

test("the second of two jobs reading the same quiet host waits for the first to show", async () => {
  const h = host([reading(1, 1)], ["taken\n"]);
  const lines: string[] = [];
  const result = await awaitHostBudget({ ...h, job: "The audit", host: "h", jobClass: "background", onWait: (line) => lines.push(line), pollMs: 15_000 });
  assert.deepEqual(result, { outcome: "admitted", waited: true, waitedMs: 15_000 });
  assert.match(lines[0]!, /waiting for h's CPU budget: a job has just started and its load has yet to show/);
});


test("a job over budget waits, names what it waits for, and starts once the host has room", async () => {
  const h = host([reading(50, 40), reading(50, 40), reading(10, 10)]);
  const lines: string[] = [];
  const result = await awaitHostBudget({ ...h, job: "The audit", host: "peach-box", jobClass: "background", onWait: (line) => lines.push(line), pollMs: 15_000 });
  assert.deepEqual(result, { outcome: "admitted", waited: true, waitedMs: 30_000 });
  assert.match(lines[0]!, /The audit is waiting for peach-box's CPU budget: load 50\.0 is over 24\.0 of its 32 CPUs/);
  assert.match(lines.at(-1)!, /The audit starts on peach-box after waiting 30 s/);
  assert.equal(h.marks(), 1, "its start is stamped, so the next job waits for it to show");
});

test("a job on a host with room starts at once and says nothing", async () => {
  const h = host([reading(1, 1)]);
  const lines: string[] = [];
  assert.deepEqual(await awaitHostBudget({ ...h, job: "gate", host: "h", jobClass: "gate", onWait: (line) => lines.push(line) }), { outcome: "admitted", waited: false, waitedMs: 0 });
  assert.deepEqual(lines, []);
});

test("a job that has waited its limit runs anyway and says so: the budget never fails it", async () => {
  const h = host([reading(99, 99)]);
  const lines: string[] = [];
  const result = await awaitHostBudget({ ...h, job: "gate", host: "peach-live", jobClass: "gate", onWait: (line) => lines.push(line) });
  assert.equal(result.outcome, "over-limit");
  assert.equal(result.waitedMs, 120_000);
  assert.match(lines.at(-1)!, /starts on peach-live over its CPU budget after waiting 120 s, its limit: load 99\.0/);
});

test("a host that cannot be read admits the job, and a cancelled wait ends", async () => {
  const unread = await awaitHostBudget({ shell: async () => null, job: "gate", host: "h", jobClass: "gate", onWait: () => assert.fail("nothing to say") });
  assert.equal(unread.outcome, "unread");
  const controller = new AbortController();
  const h = host([reading(99, 99)]);
  const waiting = awaitHostBudget({ ...h, sleep: async () => { controller.abort(); }, job: "gate", host: "h", jobClass: "gate", onWait: () => undefined, signal: controller.signal });
  assert.equal((await waiting).outcome, "unread");
});

test("slipjay host-budget wait returns success at its limit, stamps its start, and refuses bad usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-budget-"));
  try {
    const launcher = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
    const cli = (...args: string[]) => spawnSync("bun", [launcher, "host-budget", ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(cli("wait", "--job", "fixture", "--max-wait-seconds", "0").status, 0);
    assert.ok((await stat(join(home, ".slipjay", "host-budget-admitted"))).isFile());
    assert.equal(cli("wait").status, 2);
    assert.equal(cli("wait", "--job", "fixture", "--max-wait-seconds", "soon").status, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("on a real shell, one of several background jobs started together wins the claim and a gate always gets one", async () => {
  const home = await mkdtemp(join(tmpdir(), "host-budget-claim-"));
  const env = { ...process.env, HOME: home };
  try {
    const claims: string[] = [];
    const job = (jobClass: "gate" | "background") => awaitHostBudget({ job: "j", host: "h", jobClass, onWait: () => undefined, sleep: async () => undefined, limitMs: 0,
      shell: async (script) => {
        if (!script.includes("flock")) return "0 0 0 1/1 1\n32\n";
        const answer = await new Promise<string>((resolve) => {
          const child = spawn("sh", ["-c", script], { env });
          let stdout = "";
          child.stdout.on("data", (chunk) => { stdout += String(chunk); });
          child.on("close", () => resolve(stdout.trim()));
        });
        claims.push(answer);
        return answer;
      } });
    await Promise.all([job("background"), job("background"), job("background")]);
    assert.equal(claims.slice(0, 3).filter((answer) => answer === "claimed").length, 1, claims.join());
    claims.length = 0;
    await job("gate");
    assert.deepEqual(claims, ["claimed"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
