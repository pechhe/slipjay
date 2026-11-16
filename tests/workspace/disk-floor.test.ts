import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { defaultDiskConfig, readDiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import { assertInstallHeadroom, belowFloor, floorRefusal, freeSpaceFloor, hardMinimumRefusal } from "../../src/lib/host-disk/disk-floor.ts";
import { applyHostDisk } from "../../src/lib/host-disk/disk-apply.ts";
import type { DiskOps } from "../../src/lib/host-disk/disk-apply.ts";
import type { DiskRow, HostDiskPlan } from "../../src/lib/host-disk/disk-plan.ts";
import { holdersOfOpenFiles, parseLsofPaths } from "../../src/lib/host-disk/disk-holders.ts";
import { heartbeatWarning } from "../../src/lib/host-disk/disk-heartbeat.ts";
import { recoveryCustodyIdle } from "../../src/lib/workspace/workspace-claims.ts";
import type { ClaimView } from "../../src/lib/workspace/workspace-claims.ts";

const GiB = 1024 ** 3;
test("physical available blocks govern admission at the larger absolute or proportional floor", () => {
  const config = defaultDiskConfig();
  assert.equal(freeSpaceFloor(config, { percent: 1, totalBytes: 100 * GiB }), 40 * GiB);
  assert.equal(freeSpaceFloor(config, { percent: 1, totalBytes: 1000 * GiB }), 100 * GiB);
  assert.equal(belowFloor(config, { percent: 1, freeBytes: 39 * GiB }), true);
  assert.match(floorRefusal(config, { percent: 1, freeBytes: 39 * GiB })!, /39.0 GiB free, 40.0 GiB required/);
  assert.equal(floorRefusal(config, { percent: 99, freeBytes: 40 * GiB }), null);
  assert.throws(() => readDiskConfig({ disk: { floor: { percent: 100 } } }), /floor.percent/);
});

test("claims warn below the soft floor, proceed above the hard minimum, and refuse below it", async () => {
  const config = defaultDiskConfig();
  const warnings: string[] = [];
  await assertInstallHeadroom({ config, readUsage: async () => ({ percent: 1, totalBytes: 100 * GiB, freeBytes: 30 * GiB }), warn: (text) => warnings.push(text) });
  assert.match(warnings[0]!, /30.0 GiB free, 40.0 GiB required/);
  assert.match(warnings[0]!, /excess spares.*idle scratch.*idle workspaces.*dependencies/);
  assert.equal(hardMinimumRefusal(config, { percent: 1, totalBytes: 100 * GiB, freeBytes: 10 * GiB }), null);
  await assert.rejects(assertInstallHeadroom({ config, readUsage: async () => ({ percent: 1, freeBytes: 9 * GiB }) }), /hard minimum: 9.0 GiB free, 10.0 GiB required/);
  assert.match(hardMinimumRefusal(config, { percent: 1, totalBytes: 1000 * GiB, freeBytes: 19 * GiB })!, /20.0 GiB required/);
  assert.throws(() => readDiskConfig({ disk: { hardMinimum: { percent: 100 } } }), /hardMinimum.percent/);
});

const row = (path: string, extra: Partial<DiskRow> = {}): DiskRow => ({ path, class: "workspace", sizeBytes: 999999, action: "remove", reason: "idle", owner: "test", ...extra });
const pressurePlan = (rows: DiskRow[]): HostDiskPlan => ({ usagePercent: 80, freeBytes: 10, floorBytes: 40, floorPressure: true, level: "shed", rows, flags: [], ballast: null, workspaceIdleMs: 1, budgets: {}, notes: [] });
const ops = (extra: Partial<DiskOps>): DiskOps => ({ remove: async () => {}, allocate: async () => {}, archive: async () => { throw new Error("unexpected archive"); }, evictWorkspaces: async () => ({ evicted: new Set(), failed: [] }), readManifest: async () => ({ problem: "missing" }), ...extra });

test("pressure uses the fixed order and stops at the measured floor, even when du promises huge savings", async () => {
  let free = 10;
  const calls: string[] = [];
  const plan = pressurePlan([
    row("dependency", { retirable: false }), row("newer", { retirable: true, idleSince: 2 }),
    row("scratch", { class: "scratch" }), row("keep-spare", { spare: true, repository: "repo" }),
    row("excess-spare", { spare: true, repository: "repo" }), row("older", { retirable: true, idleSince: 1 }),
  ]);
  const result = await applyHostDisk(plan, ops({
    readUsage: async () => ({ freeBytes: free }), held: async () => false,
    retireSpare: async (_repo, path) => { if (path === "keep-spare") return "within allowance"; calls.push(path); return null; },
    retireWorkspace: async (path) => { calls.push(path); free += 20; return null; },
    remove: async (path) => { calls.push(path); free += 10; },
  }), 0);
  assert.deepEqual(calls, ["excess-spare", "scratch", "older"]);
  assert.match(result.rows.find((row) => row.path === "excess-spare")!.detail, /df delta 0/);
  assert.equal(result.rows.find((row) => row.path === "newer")!.outcome, "kept");
});

test("failed or held retirement keeps source and dependency eviction is the last workspace fallback", async () => {
  const calls: string[] = [];
  const result = await applyHostDisk(pressurePlan([row("unlanded", { retirable: true }), row("held", { retirable: true })]), ops({
    readUsage: async () => ({ freeBytes: 10 }), held: async (path) => path === "held",
    retireWorkspace: async (path) => { calls.push(`archive:${path}`); return "archive refused"; },
    evictWorkspaces: async (_idle, paths) => { calls.push(`deps:${paths![0]}`); return { evicted: new Set(paths), failed: [] }; },
  }), 0);
  assert.deepEqual(calls, ["archive:unlanded", "deps:unlanded"]);
  // The dependency operation has its own fresh custody/holder fence; it is never a raw rm.
  assert.equal(result.failures, 0);
});

test("pressure stops reclaiming if available blocks become unreadable", async () => {
  const calls: string[] = [];
  let reads = 0;
  const result = await applyHostDisk(pressurePlan([row("first", { retirable: true }), row("second", { retirable: true })]), ops({
    readUsage: async () => ++reads === 1 ? { freeBytes: 10 } : null,
    retireWorkspace: async (path) => { calls.push(path); return null; },
  }), 0);
  assert.deepEqual(calls, ["first"]);
  assert.equal(result.failures, 1);
});

test("lsof holder parsing covers cwd, mappings, spaces, and does not confuse sibling paths", () => {
  const open = parseLsofPaths("p12\ncworker\nn/tmp/a scratch/file\nn/tmp/a scratch\np13\ncother\nn/tmp/a scratch-other/x\n");
  assert.deepEqual(holdersOfOpenFiles("/tmp/a scratch", open).map((holder) => holder.pid), [12]);
});

test("recovery custody needs every independent proof, never just a dead controller or old clock", () => {
  const claim: ClaimView = { claimId: "c", generation: "g", ownerId: "o", state: "recovery-required", reason: "recovery", obligationRef: "o", settlementRef: null, controller: { pid: 42, platform: "linux", boot: "b", start: "s" } };
  const input = { claims: [claim], controllersGone: true, holdersClear: true, lastActivityAt: 0, now: 24 * 60 * 60_000 };
  assert.equal(recoveryCustodyIdle(input), true);
  for (const override of [{ controllersGone: false }, { holdersClear: false }, { lastActivityAt: null }, { now: input.now - 1 }, { claims: [{ ...claim, controller: null }] }, { claims: [{ ...claim, state: "active" as const }] }]) assert.equal(recoveryCustodyIdle({ ...input, ...override }), false);
});

test("a missing, future, or over-two-hour heartbeat alarms", () => {
  assert.equal(heartbeatWarning(0, 2 * 60 * 60_000), null);
  assert.match(heartbeatWarning(0, 2 * 60 * 60_000 + 1)!, /stale/);
  assert.match(heartbeatWarning(undefined, 0)!, /missing/);
  assert.match(heartbeatWarning(1, 0)!, /stale/);
});

