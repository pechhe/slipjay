import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vite-plus/test";
import { evidenceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { readDiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import type { DiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import { hostDisk } from "../../src/lib/host-disk/host-disk.ts";
import type { HostDiskOptions } from "../../src/lib/host-disk/host-disk.ts";

const HOUR = 60 * 60_000;
const MIB = 1024 * 1024;
const NOW = Date.parse("2026-11-10T12:00:00Z");

let base: string;
let config: DiskConfig;
beforeEach(async () => {
  await rm(evidenceHome(), { recursive: true, force: true });
  base = await mkdtemp(join(tmpdir(), "slipjay-host-disk-"));
  await mkdir(join(base, "scratch"));
  await mkdir(join(base, "runs"));
  config = readDiskConfig({ disk: {
    ballast: { path: join(base, "ballast"), bytes: 4 * MIB },
    runRoot: join(base, "runs"),
    scratchRoots: [{ path: join(base, "scratch"), match: ["*-scratch"], ttlHours: 72 }],
    regenerable: [join(base, "cache")],
    issueCapBytes: 3 * MIB,
  } });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const usage = (percent: number) => async () => ({ percent, totalBytes: 1000 * 1024 ** 3, freeBytes: 0 });
const age = (path: string, hours: number) => utimes(path, new Date(NOW - hours * HOUR), new Date(NOW - hours * HOUR));
const pass = (percent: number, options: HostDiskOptions = {}) => hostDisk({
  config, now: NOW, readUsage: usage(percent), integrationRoots: async () => [], ...options,
  host: { holders: async () => [], recentlyModified: async () => false, issueClosed: async () => true, ...options.host },
  ops: { held: async () => false, ...options.ops },
});
const rowFor = (outcome: Awaited<ReturnType<typeof hostDisk>>, path: string) => {
  assert.ok(outcome.state !== "busy");
  return outcome.results.find((row) => row.path === path)!;
};

async function scratch(name: string, hours: number): Promise<string> {
  const path = join(base, "scratch", name);
  await mkdir(path);
  await writeFile(join(path, "file"), "x");
  await age(path, hours);
  return path;
}

async function evidence(issue: string, manifest: Record<string, unknown> | null, files: Record<string, string | Buffer> = { "report.md": "report" }): Promise<string> {
  const dir = join(base, "runs", issue);
  await mkdir(dir, { recursive: true });
  if (manifest) await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}
const manifest = (issue: string, extra: Record<string, unknown> = {}) => ({ issue, owner: "henry", created: "2026-10-01T00:00:00Z", forgeNumber: Number(issue), ...extra });

test("shed removes regenerable caches and old scratch, and keeps young scratch and all evidence", async () => {
  const cache = join(base, "cache");
  await mkdir(cache);
  await writeFile(join(cache, "x"), "x");
  const old = await scratch("old-scratch", 100);
  const young = await scratch("young-scratch", 1);
  const unmatched = await scratch("other", 100);
  const open = await evidence("1", manifest("1"));
  const outcome = await pass(90);
  assert.equal(outcome.state === "applied" && outcome.level, "shed");
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(unmatched), true, "a name outside the declared match is never a row");
  assert.equal(existsSync(open), true);
  assert.equal(rowFor(outcome, open).action, "report");
});

test("below shed a regenerable cache stays, with the reason", async () => {
  const cache = join(base, "cache");
  await mkdir(cache);
  const outcome = await pass(85);
  assert.equal(existsSync(cache), true);
  assert.match(rowFor(outcome, cache).reason, /only at shed/);
});

test("scratch guards keep a held, unreadable-holder, foreign-owned or escaping directory", async () => {
  const held = await scratch("held-scratch", 100);
  const blind = await scratch("blind-scratch", 100);
  const foreign = await scratch("foreign-scratch", 100);
  const outside = await mkdtemp(join(tmpdir(), "slipjay-host-disk-outside-"));
  await age(outside, 100);
  const link = join(base, "scratch", "link-scratch");
  await (await import("node:fs/promises")).symlink(outside, link);
  const outcome = await pass(50, { host: {
    holders: async (path) => path === held ? [{ pid: 7, command: "node", cwd: held }] : path === blind ? null : [],
    stat: async (path) => {
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) return null;
      const real = await (await import("node:fs/promises")).realpath(path);
      return { mtimeMs: info.mtimeMs, uid: path === foreign ? info.uid + 1 : info.uid, isDirectory: info.isDirectory(), isSymlink: path === link, realPath: real };
    },
  } });
  try {
    assert.match(rowFor(outcome, held).reason, /held by a live process: pid 7/);
    assert.match(rowFor(outcome, blind).reason, /cannot read the processes/);
    assert.match(rowFor(outcome, foreign).reason, /not owned by the host user/);
    assert.match(rowFor(outcome, link).reason, /outside the declared scratch root/);
    for (const path of [held, blind, foreign, outside]) assert.equal(existsSync(path), true, path);
    for (const path of [held, blind, foreign, link]) assert.equal(rowFor(outcome, path).action, "keep");
  } finally { await rm(outside, { recursive: true, force: true }); }
});

test("evidence without a usable manifest, pinned, unexpired, not closed or unreadable is reported and kept", async () => {
  const cases: Record<string, [Record<string, unknown> | null, boolean | null, RegExp]> = {
    "10": [null, true, /manifest/],
    "11": [manifest("11", { pin: true, expires: "2026-01-01" }), true, /pinned/],
    "12": [manifest("12", { expires: "2027-01-01" }), true, /not expired/],
    "13": [manifest("13", { expires: "2026-01-01" }), false, /not closed/],
    "14": [manifest("14", { expires: "2026-01-01" }), null, /cannot be read/],
    "15": [manifest("15"), true, /no expiry/],
    "16": [{ issue: "16", owner: "henry", created: "2026-10-01T00:00:00Z", expires: "2026-01-01" }, true, /no Forge number/],
  };
  const dirs: Record<string, string> = {};
  for (const [issue, [m]] of Object.entries(cases)) dirs[issue] = await evidence(issue, m);
  const outcome = await pass(97, { host: { issueClosed: async (number) => cases[String(number)]![1] } });
  for (const [issue, [, , reason]] of Object.entries(cases)) {
    assert.equal(existsSync(dirs[issue]!), true, issue);
    assert.equal(rowFor(outcome, dirs[issue]!).action, "report");
    assert.match(rowFor(outcome, dirs[issue]!).reason, reason, issue);
  }
});

test("an expiry extended or an issue renamed after the plan keeps the evidence at removal", async () => {
  const extended = await evidence("30", manifest("30", { expires: "2026-01-01" }));
  const renamed = await evidence("31", manifest("31", { expires: "2026-01-01" }));
  let changed = false;
  const outcome = await pass(50, { ops: { held: async () => {
    // The plan is made first; the manifests change before the pass applies it.
    if (!changed) {
      changed = true;
      await writeFile(join(extended, "manifest.json"), JSON.stringify(manifest("30", { expires: "2027-01-01" })));
      await writeFile(join(renamed, "manifest.json"), JSON.stringify(manifest("99", { forgeNumber: 31, expires: "2026-01-01" })));
    }
    return false;
  } } });
  assert.equal(existsSync(extended) && existsSync(renamed), true);
  assert.match(rowFor(outcome, extended).detail, /no longer expired/);
  assert.match(rowFor(outcome, renamed).detail, /no longer matches/);
});

test("closed and expired evidence is archived, small files first, then removed", async () => {
  const big = Buffer.alloc(2 * MIB, 1);
  const dir = await evidence("20", manifest("20", { expires: "2026-01-01" }), { "report.md": "report", "log.txt": "log line", "dump.bin": big });
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "config.json"), "{}");
  const outcome = await pass(50);
  const row = rowFor(outcome, dir);
  assert.equal(row.outcome, "archived");
  assert.equal(existsSync(dir), false);
  assert.deepEqual([row.archive!.keptFiles, row.archive!.droppedFiles, row.archive!.droppedBytes], [4, 1, 2 * MIB]);
  assert.match(row.detail, /kept 4 files/);
  const [archived] = await readdir(evidenceHome());
  assert.match(archived!, /^20-\d{4}-\d{2}-\d{2}T/);
  const root = join(evidenceHome(), archived!);
  const provenance = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
  assert.deepEqual(provenance.files.map((file: { path: string }) => file.path).sort(), ["log.txt", "manifest.json", "report.md", "sub/config.json"]);
  for (const file of provenance.files) {
    const copy = await readFile(join(root, "files", file.path));
    assert.equal(copy.length, file.bytes);
    assert.equal(createHash("sha256").update(copy).digest("hex"), file.sha256);
  }
  assert.deepEqual(provenance.dropped, [{ path: "dump.bin", bytes: 2 * MIB }]);
  assert.equal(existsSync(join(root, "files", "dump.bin")), false);
});

test("an archive that cannot be made keeps the whole directory", async () => {
  const dir = await evidence("21", manifest("21", { expires: "2026-01-01" }));
  const outcome = await pass(50, { ops: { archive: async () => { throw new Error("disk full"); } } });
  assert.equal(existsSync(dir), true);
  assert.equal(rowFor(outcome, dir).outcome, "kept");
  assert.match(rowFor(outcome, dir).detail, /kept everything: disk full/);
});

test("small files beyond 64 MiB keep the directory and report", async () => {
  const files: Record<string, Buffer> = {};
  for (let index = 0; index < 65; index += 1) files[`f${index}`] = Buffer.alloc(MIB, 2);
  const dir = await evidence("22", manifest("22", { expires: "2026-01-01" }), files);
  const outcome = await pass(50);
  assert.equal(existsSync(dir), true);
  assert.match(rowFor(outcome, dir).detail, /64 MiB/);
  assert.deepEqual(await readdir(evidenceHome()).catch(() => []), []);
});

test("an Issue directory over the cap is flagged and not deleted for that alone", async () => {
  const dir = await evidence("30", manifest("30", { pin: true }), { "big.bin": Buffer.alloc(4 * MIB, 3) });
  const outcome = await pass(97);
  assert.ok(outcome.state !== "busy");
  assert.deepEqual(outcome.flags.map((flag) => [flag.issue, flag.owner]), [["30", "henry"]]);
  assert.ok(outcome.flags[0]!.sizeBytes > 3 * MIB);
  assert.equal(existsSync(dir), true);
});

test("the ballast is released at critical and recreated, with real blocks, below the recreate threshold", async () => {
  const ballast = config.ballast.path;
  assert.equal((await pass(50)).state === "applied", true);
  assert.equal(statSync(ballast).size, 4 * MIB);
  assert.ok(statSync(ballast).blocks * 512 >= 4 * MIB, "allocated, not sparse");
  const critical = await pass(97);
  assert.equal(existsSync(ballast), false);
  assert.ok(critical.state === "applied" && critical.ballastResult?.outcome === "released");
  assert.match(critical.ballastResult!.detail, /CRITICAL/);
  await pass(90);
  assert.equal(existsSync(ballast), false, "not recreated at 90%");
  await pass(84);
  assert.equal(existsSync(ballast), true);
  assert.equal(existsSync(`${ballast}.partial`), false);
});

test("a plan changes nothing and lists every managed directory", async () => {
  const cache = join(base, "cache");
  await mkdir(cache);
  const old = await scratch("old-scratch", 100);
  const closed = await evidence("40", manifest("40", { expires: "2026-01-01" }));
  const outcome = await pass(97, { plan: true });
  assert.ok(outcome.state === "planned" && !outcome.applied);
  assert.deepEqual(outcome.rows.map((row) => [row.class, row.path, row.action]).sort(), [
    ["evidence", closed, "archive-and-prune"], ["regenerable", cache, "remove"], ["scratch", old, "remove"],
  ].sort());
  for (const row of outcome.rows) assert.ok(row.reason && typeof row.sizeBytes === "number" && "owner" in row);
  assert.equal(outcome.ballast?.action, "keep");
  assert.equal(existsSync(cache) && existsSync(old) && existsSync(closed), true);
  assert.equal(existsSync(config.ballast.path), false, "no ballast written");
  assert.equal(await readdir(evidenceHome()).then((names) => names.length, () => 0), 0, "nothing archived");
});

test("workspace rows are the existing eviction plan: its own idle time below shed, one hour at shed", async () => {
  const row = { path: "/w/a", class: "workspace" as const, sizeBytes: 5, owner: "a", action: "remove" as const, reason: "idle 3h" };
  const idle: number[] = [];
  const host = { workspaceRows: async (idleMs: number) => { idle.push(idleMs); return [row]; } };
  const below = await pass(85, { plan: true, host });
  assert.ok(below.state !== "busy" && below.rows.some((entry) => entry.path === "/w/a") && below.workspaceIdleMs === 24 * HOUR);
  const shed = await pass(90, { plan: true, host });
  assert.deepEqual(idle, [24 * HOUR, HOUR]);
  assert.ok(shed.state !== "busy" && shed.rows.some((entry) => entry.path === "/w/a" && entry.action === "remove"));
  const evicted = await pass(90, { host, integrationRoots: async () => [], ops: { evictWorkspaces: async () => ({ evicted: new Set(["/w/a"]), failed: [] }) } });
  assert.equal(rowFor(evicted, "/w/a").outcome, "removed");
  // On a healthy disk the pass leaves the evicting to `maintain`, and never calls it.
  let called = false;
  const healthy = await pass(50, { host, ops: { evictWorkspaces: async () => { called = true; return { evicted: new Set(["/w/a"]), failed: [] }; } } });
  assert.equal(called, false);
  assert.equal(rowFor(healthy, "/w/a").outcome, "kept");
  assert.match(rowFor(healthy, "/w/a").detail, /left to maintain/);
});

test("a failed removal is counted", async () => {
  await scratch("old-scratch", 100);
  const outcome = await pass(50, { ops: { remove: async () => { throw new Error("busy"); } } });
  assert.ok(outcome.state === "applied" && outcome.failures === 1);
});

test("a second pass that cannot get the host lock reports it and changes nothing", async () => {
  const { withWorkspaceTransaction } = await import("../../src/lib/infra/workspace-transaction.ts");
  const old = await scratch("old-scratch", 100);
  const outcome = await withWorkspaceTransaction("host-disk", () => pass(50, { lockWaitMs: 100 }));
  assert.equal(outcome.state, "busy");
  assert.equal(existsSync(old), true);
});

test("scratch with a recent write deep inside, or that cannot be checked for one, is kept", async () => {
  const busy = await scratch("busy-scratch", 100);
  const unknown = await scratch("unknown-scratch", 100);
  const outcome = await pass(50, { host: { recentlyModified: async (path: string) => path === busy ? true : path === unknown ? null : false } });
  assert.equal(rowFor(outcome, busy).action, "keep");
  assert.match(rowFor(outcome, busy).reason, /changed within 72h/);
  assert.match(rowFor(outcome, unknown).reason, /cannot tell/);
  assert.equal(existsSync(busy) && existsSync(unknown), true);
});

test("a holder that appears between the plan and the removal keeps the scratch", async () => {
  const old = await scratch("late-scratch", 100);
  const outcome = await pass(50, { ops: { held: async () => true } });
  assert.equal(rowFor(outcome, old).outcome, "kept");
  assert.equal(existsSync(old), true);
});

test("a link or file under the run root is listed, not managed", async () => {
  await writeFile(join(base, "runs", "stray-file"), "x");
  const outcome = await pass(50, { plan: true });
  assert.ok(outcome.state !== "busy");
  const row = outcome.rows.find((entry) => entry.path === join(base, "runs", "stray-file"))!;
  assert.equal(row.action, "report");
  assert.match(row.reason, /not managed/);
});

test("an applying pass writes the rescue's settings from the policy; a plan does not", async () => {
  const { writeRescueEnv } = await import("../../src/lib/host-disk/host-disk.ts");
  const { machineConfigPath } = await import("../../src/lib/workspace/workspace-paths.ts");
  const file = join(machineConfigPath(), "..", "disk-rescue.env");
  await rm(file, { force: true });
  await pass(50, { plan: true });
  assert.equal(existsSync(file), false);
  await writeRescueEnv(config);
  const text = await readFile(file, "utf8");
  assert.match(text, /^SLIPJAY_RESCUE_SHED_PERCENT=88$/m);
  assert.match(text, /^SLIPJAY_RESCUE_CRITICAL_PERCENT=96$/m);
  assert.match(text, new RegExp(`^SLIPJAY_RESCUE_BALLAST='${config.ballast.path}'$`, "m"));
  assert.match(text, new RegExp(`^SLIPJAY_RESCUE_REGENERABLE='${join(base, "cache")}'$`, "m"));
});
