import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vite-plus/test";
import { diskLines } from "../../src/launcher/disk-command.ts";
import { readDiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import type { DiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import { hostDisk } from "../../src/lib/host-disk/host-disk.ts";
import type { HostDiskOptions } from "../../src/lib/host-disk/host-disk.ts";
import { parseDockerSize, readDockerVolumes } from "../../src/lib/host-disk/disk-readers.ts";
import { evidenceHome } from "../../src/lib/workspace/workspace-paths.ts";

const HOUR = 60 * 60_000;
const MIB = 1024 * 1024;
const NOW = Date.parse("2026-11-10T12:00:00Z");

let base: string;
const configWith = (budgets: Record<string, number> | undefined): DiskConfig => readDiskConfig({ disk: {
  ballast: { path: join(base, "ballast"), bytes: 0 }, runRoot: join(base, "runs"),
  scratchRoots: [], regenerable: [], ...budgets === undefined ? {} : { budgets },
} });
beforeEach(async () => {
  await rm(evidenceHome(), { recursive: true, force: true });
  base = await mkdtemp(join(tmpdir(), "slipjay-host-disk-budget-"));
  await mkdir(join(base, "runs"));
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const usage = (percent: number, extra: Record<string, number> = {}) => async () => ({ percent, totalBytes: 1000 * MIB, freeBytes: 0, ...extra });
const pass = (config: DiskConfig, percent: number, options: HostDiskOptions = {}, extra: Record<string, number> = {}) => hostDisk({
  config, now: NOW, readUsage: usage(percent, extra), integrationRoots: async () => [], ...options,
  host: { holders: async () => [], recentlyModified: async () => false, issueClosed: async () => true, dockerVolumes: async () => [], loopImages: async () => [], ...options.host },
  ops: { held: async () => false, ...options.ops },
});

/** Evidence sizes are declared per directory name, so no test depends on `du`. */
async function evidence(issue: string, manifest: Record<string, unknown> | null): Promise<string> {
  const dir = join(base, "runs", issue);
  await mkdir(dir, { recursive: true });
  if (manifest) await writeFile(join(dir, "manifest.json"), JSON.stringify({ issue, owner: "henry", created: "2026-10-01T00:00:00Z", forgeNumber: Number(issue), ...manifest }));
  await writeFile(join(dir, "report.md"), "r");
  return dir;
}
const sizes = (table: Record<string, number>) => async (path: string) => table[path.split("/").at(-1)!] ?? 0;

test("budgets are optional positive integers, validated", () => {
  assert.deepEqual(readDiskConfig({}).budgets, {});
  assert.deepEqual(readDiskConfig({ disk: { budgets: { workspacesBytes: 5, evidenceBytes: 7 } } }).budgets, { workspacesBytes: 5, evidenceBytes: 7 });
  for (const budgets of [[], { other: 1 }, { workspacesBytes: 0 }, { evidenceBytes: -1 }, { evidenceBytes: 1.5 }, { workspacesBytes: "big" }]) {
    assert.throws(() => readDiskConfig({ disk: { budgets } }), /disk in .*config\.json/, JSON.stringify(budgets));
  }
});

test("workspaces over budget are evicted at ok and say what claimed checkouts hold; under budget they are left to maintain", async () => {
  const row = { path: "/w/a", class: "workspace" as const, sizeBytes: 10 * MIB, owner: "a", action: "remove" as const, reason: "idle 3h" };
  const idle: number[] = [];
  const host = { workspaceRows: async (idleMs: number) => { idle.push(idleMs); return [row]; } };
  const evictWorkspaces = async () => ({ evicted: new Set(["/w/a"]), failed: [], freedBytes: 2 * MIB });
  const over = await pass(configWith({ workspacesBytes: 4 * MIB }), 50, { host, ops: { evictWorkspaces } });
  assert.ok(over.state === "applied");
  assert.deepEqual(idle, [24 * HOUR, HOUR], "re-planned at the shed window");
  assert.equal(over.results.find((entry) => entry.path === "/w/a")!.outcome, "removed");
  // 10 MiB less the 2 MiB freed is still over the 4 MiB budget.
  assert.deepEqual(over.budgets.workspaces, { budgetBytes: 4 * MIB, usedBytes: 8 * MIB, over: true });
  assert.match(diskLines(over, false).join("\n"), /^over budget\tworkspaces\t8\.0 MB of 4\.0 MB\tclaimed workspaces hold 8\.0 MB$/m);

  const planned = await pass(configWith({ workspacesBytes: 4 * MIB }), 50, { plan: true, host });
  assert.ok(planned.state === "planned" && planned.workspaceIdleMs === HOUR && planned.budgets.workspaces?.over === true);

  let called = false;
  const under = await pass(configWith({ workspacesBytes: 20 * MIB }), 50, { host, ops: { evictWorkspaces: async () => { called = true; return evictWorkspaces(); } } });
  assert.ok(under.state === "applied");
  assert.equal(called, false);
  assert.equal(under.budgets.workspaces?.over, false);
  assert.doesNotMatch(diskLines(under, false).join("\n"), /over budget/);
  const none = await pass(configWith(undefined), 50, { host });
  assert.ok(none.state === "applied" && none.budgets.workspaces === undefined);
});

test("evidence over budget prunes closed, unpinned, unheld directories oldest first until under, and nothing else", async () => {
  const oldest = await evidence("1", { created: "2026-01-01T00:00:00Z", expires: "2027-01-01" });
  const second = await evidence("2", { created: "2026-02-01T00:00:00Z" });
  const third = await evidence("3", { created: "2026-03-01T00:00:00Z", expires: "2027-01-01" });
  const pinned = await evidence("4", { created: "2025-01-01T00:00:00Z", pin: true });
  const open = await evidence("5", { created: "2025-01-01T00:00:00Z" });
  const held = await evidence("6", { created: "2025-01-01T00:00:00Z" });
  const noNumber = await evidence("7", { created: "2025-01-01T00:00:00Z", forgeNumber: undefined });
  const renamed = await evidence("8", { created: "2025-01-01T00:00:00Z", issue: "other" });
  const table = { 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10, 7: 10, 8: 10 };
  const host = {
    sizeOf: sizes(Object.fromEntries(Object.entries(table).map(([key, mib]) => [key, mib * MIB]))),
    issueClosed: async (number: number) => number !== 5 && number !== 3,
    holders: async (path: string) => path === held ? [{ pid: 9, command: "node", cwd: held }] : [],
  };
  // 80 MiB used, a 55 MiB budget: two directories must go.
  const planned = await pass(configWith({ evidenceBytes: 55 * MIB }), 50, { plan: true, host });
  assert.ok(planned.state === "planned");
  const action = (path: string) => planned.rows.find((row) => row.path === path)!;
  assert.deepEqual([oldest, second, third].map((path) => action(path).action), ["archive-and-prune", "archive-and-prune", "report"]);
  assert.ok(action(oldest).budgetPrune && action(second).budgetPrune);
  assert.match(action(oldest).reason, /over its .* budget/);
  for (const path of [pinned, open, held, noNumber, renamed]) assert.equal(action(path).action, "report", path);
  assert.deepEqual(planned.budgets.evidence, { budgetBytes: 55 * MIB, usedBytes: 80 * MIB, over: true });
  assert.ok(action(pinned).keepsOverBudget, "rows that keep the class over budget are identifiable");
  assert.equal(existsSync(oldest) && existsSync(second), true, "--plan removes nothing");

  const applied = await pass(configWith({ evidenceBytes: 55 * MIB }), 50, { host });
  assert.ok(applied.state === "applied");
  assert.deepEqual([oldest, second].map((path) => applied.results.find((row) => row.path === path)!.outcome), ["archived", "archived"]);
  for (const path of [third, pinned, open, held, noNumber, renamed]) assert.equal(existsSync(path), true, path);
  assert.deepEqual(applied.budgets.evidence, { budgetBytes: 55 * MIB, usedBytes: 60 * MIB, over: true });
  assert.match(diskLines(applied, false).join("\n"), /^over budget\tevidence\t60\.0 MB of 55\.0 MB$/m);
});

test("a budget-pruned row skips only the expiry re-check at removal", async () => {
  const dir = await evidence("1", { expires: "2027-01-01" });
  const config = configWith({ evidenceBytes: MIB });
  const host = { sizeOf: sizes({ 1: 2 * MIB }) };
  const kept = await pass(config, 50, { host, ops: { readManifest: async () => ({ manifest: { issue: "1", owner: "henry", created: "2026-10-01T00:00:00Z", forgeNumber: 1, pin: true } }) } });
  assert.ok(kept.state === "applied");
  assert.match(kept.results.find((row) => row.path === dir)!.detail, /pinned since/);
  assert.equal(existsSync(dir), true);
  const renamed = await pass(config, 50, { host, ops: { readManifest: async () => ({ manifest: { issue: "x", owner: "henry", created: "2026-10-01T00:00:00Z", forgeNumber: 1 } }) } });
  assert.ok(renamed.state === "applied");
  assert.match(renamed.results.find((row) => row.path === dir)!.detail, /no longer matches/);
  const heldNow = await pass(config, 50, { host, ops: { held: async () => true } });
  assert.ok(heldNow.state === "applied" && existsSync(dir));
  const pruned = await pass(config, 50, { host });
  assert.ok(pruned.state === "applied");
  assert.equal(pruned.results.find((row) => row.path === dir)!.outcome, "archived");
  assert.equal(pruned.budgets.evidence?.over, false);
});

test("under its evidence budget, or with none, an unexpired directory is kept as before", async () => {
  const dir = await evidence("1", { expires: "2027-01-01" });
  for (const budgets of [{ evidenceBytes: 50 * MIB }, undefined]) {
    const outcome = await pass(configWith(budgets), 50, { host: { sizeOf: sizes({ 1: 2 * MIB }) } });
    assert.ok(outcome.state === "applied");
    assert.equal(outcome.results.find((row) => row.path === dir)!.outcome, "kept");
    assert.equal(outcome.budgets.evidence?.over ?? false, false);
    assert.equal(existsSync(dir), true);
  }
});

test("docker volumes, loop images and unexplained space are report-only rows", async () => {
  const host = {
    dockerVolumes: async () => [{ name: "pgdata", sizeBytes: 3 * MIB, containers: ["db"] }, { name: "orphan", sizeBytes: MIB, containers: [] }],
    loopImages: async () => [{ backingFile: "/data/img", mount: "/mnt/img", hostBytes: 5 * MIB, filesystemBytes: 2 * MIB }],
  };
  const outcome = await pass(configWith(undefined), 97, {
    host: { ...host, ballast: async () => ({ present: false, sizeBytes: 0 }) },
  }, { usedBytes: 20 * MIB });
  assert.ok(outcome.state === "applied");
  const byClass = (name: string) => outcome.results.filter((row) => row.class === name);
  assert.deepEqual(byClass("docker-volume").map((row) => [row.path, row.sizeBytes, row.owner, row.outcome]), [["docker volume pgdata", 3 * MIB, "db", "kept"], ["docker volume orphan", MIB, null, "kept"]]);
  assert.match(byClass("docker-volume")[1]!.reason, /no container/);
  assert.equal(byClass("loop-image")[0]!.sizeBytes, 5 * MIB);
  assert.match(byClass("loop-image")[0]!.reason, /filesystem uses 2097152 bytes/);
  // 20 MiB used, less 3 + 1 + 5 MiB the rows explain.
  assert.equal(byClass("unexplained")[0]!.sizeBytes, 11 * MIB);
  assert.equal(outcome.notes.length, 0);
  const without = await pass(configWith(undefined), 50, { plan: true, host });
  assert.ok(without.state === "planned" && !without.rows.some((row) => row.class === "unexplained"), "no totals, no figure");
});

test("a host that cannot read Docker says so once, and macOS-style hosts report no loop images", async () => {
  const outcome = await pass(configWith(undefined), 97, { plan: true, host: { dockerVolumes: async () => null, loopImages: async () => null } });
  assert.ok(outcome.state === "planned");
  assert.deepEqual(outcome.notes, ["Docker was not read"]);
  assert.equal(diskLines(outcome, true).filter((line) => line === "disk\tDocker was not read").length, 1);
  assert.equal(outcome.rows.length, 0);
});

test("the real Docker reader parses a stand-in docker CLI, and answers null when docker fails", async () => {
  assert.equal(parseDockerSize("1.5GB"), 1.5e9);
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("N/A"), null);
  const bin = await mkdtemp(join(tmpdir(), "fake-docker-"));
  const saved = process.env.PATH;
  try {
    await writeFile(join(bin, "docker"), `#!/bin/sh
if [ "$1" = system ]; then echo '{"Volumes":[{"Name":"pgdata","Size":"2MB"},{"Name":"orphan","Size":"1kB"}]}'; elif echo "$*" | grep -q -- --no-trunc; then echo '{"Names":"db","Mounts":"pgdata,other"}'; else echo '{"Names":"db","Mounts":"pgd…"}'; fi
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${saved}`;
    assert.deepEqual(await readDockerVolumes(), [{ name: "pgdata", sizeBytes: 2e6, containers: ["db"] }, { name: "orphan", sizeBytes: 1e3, containers: [] }]);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(await readDockerVolumes(), null);
  } finally { process.env.PATH = saved; await rm(bin, { recursive: true, force: true }); }
});

test("a healthy applying pass never calls the report-only readers; a plan or a pass past ok does", async () => {
  const calls: string[] = [];
  const host = { dockerVolumes: async () => { calls.push("docker"); return []; }, loopImages: async () => { calls.push("loop"); return []; } };
  const healthy = await pass(configWith(undefined), 50, { host }, { usedBytes: 20 * MIB });
  assert.ok(healthy.state === "applied");
  assert.deepEqual(calls, []);
  assert.deepEqual([healthy.notes, healthy.rows.filter((row) => row.class === "unexplained")], [[], []]);
  await pass(configWith(undefined), 50, { plan: true, host });
  assert.deepEqual(calls, ["docker", "loop"]);
  await pass(configWith(undefined), 85, { host });
  assert.deepEqual(calls, ["docker", "loop", "docker", "loop"]);
});

test("over budget with nothing evictable evicts nothing and reports the class over; the integration checkout is not counted", async () => {
  const kept = { path: "/w/a", class: "workspace" as const, sizeBytes: 10 * MIB, owner: "a", action: "keep" as const, reason: "in use by a live process: pid 1" };
  const primary = { path: "/w/main", class: "workspace" as const, sizeBytes: 500 * MIB, owner: "main", action: "keep" as const, reason: "integration checkout", integration: true as const };
  let called = 0;
  const evictWorkspaces = async () => { called += 1; return { evicted: new Set<string>(), failed: [] }; };
  const stuck = await pass(configWith({ workspacesBytes: 4 * MIB }), 50, { host: { workspaceRows: async () => [kept, primary] }, ops: { evictWorkspaces } });
  assert.ok(stuck.state === "applied");
  assert.equal(called, 0);
  assert.deepEqual(stuck.budgets.workspaces, { budgetBytes: 4 * MIB, usedBytes: 10 * MIB, over: true }, "the 500 MiB primary checkout is not counted");
  assert.match(diskLines(stuck, false).join("\n"), /^over budget\tworkspaces\t10\.0 MB of 4\.0 MB\tclaimed workspaces hold 10\.0 MB$/m);
  const roomy = await pass(configWith({ workspacesBytes: 10 * MIB }), 50, { host: { workspaceRows: async () => [kept, primary] } });
  assert.ok(roomy.state === "applied" && roomy.budgets.workspaces?.over === false);
  // Shedding still evicts as before, with or without a budget.
  const evictable = { ...kept, action: "remove" as const };
  await pass(configWith(undefined), 90, { host: { workspaceRows: async () => [evictable] }, ops: { evictWorkspaces } });
  assert.equal(called, 1);
});

test("rows that keep the class over budget are printed by an applying pass, including a planned prune that apply kept", async () => {
  const pinned = await evidence("1", { created: "2026-01-01T00:00:00Z", pin: true });
  const heldNow = await evidence("2", { created: "2026-02-01T00:00:00Z" });
  const host = { sizeOf: sizes({ 1: 10 * MIB, 2: 10 * MIB }) };
  const outcome = await pass(configWith({ evidenceBytes: 5 * MIB }), 50, { host, ops: { held: async () => true } });
  assert.ok(outcome.state === "applied");
  assert.equal(outcome.results.find((row) => row.path === heldNow)!.keepsOverBudget, true);
  assert.equal(outcome.results.find((row) => row.path === pinned)!.keepsOverBudget, true);
  const text = diskLines(outcome, false).join("\n");
  assert.match(text, new RegExp(`${heldNow}\\t.*holds evidence over budget \\(10\\.0 MB\\)`));
  assert.match(text, new RegExp(`${pinned}\\t.*holds evidence over budget`));
});

test("a manifest with no expires is prunable over budget; an unparseable expires is kept and reported", async () => {
  const unparseable = await evidence("1", { created: "2026-01-01T00:00:00Z", expires: "someday" });
  const none = await evidence("2", { created: "2026-02-01T00:00:00Z" });
  const outcome = await pass(configWith({ evidenceBytes: 5 * MIB }), 50, { plan: true, host: { sizeOf: sizes({ 1: 10 * MIB, 2: 10 * MIB }) } });
  assert.ok(outcome.state === "planned");
  const row = (path: string) => outcome.rows.find((entry) => entry.path === path)!;
  assert.equal(row(none).action, "archive-and-prune");
  assert.equal(row(unparseable).action, "report");
  assert.match(row(unparseable).reason, /expires is not a date/);
});

test("a closed directory too small to matter is left when a large one holds evidence over budget", async () => {
  const tiny = await evidence("1", { created: "2025-01-01T00:00:00Z" });
  const live = await evidence("2", { created: "2026-01-01T00:00:00Z" });
  const host = { sizeOf: sizes({ 1: 2 * MIB, 2: 600 * MIB }), issueClosed: async (number: number) => number === 1 };
  const outcome = await pass(configWith({ evidenceBytes: 500 * MIB }), 50, { host });
  assert.ok(outcome.state === "applied");
  const row = (path: string) => outcome.results.find((entry) => entry.path === path)!;
  assert.equal(existsSync(tiny), true);
  assert.equal(row(tiny).outcome, "kept");
  assert.ok(!row(tiny).keepsOverBudget && row(live).keepsOverBudget, "only the large directory is named as holding the class over");
});
