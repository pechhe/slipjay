import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { createWorkspace, runHousekeeping, startHousekeeping } from "../src/lib/slipjay.ts";
import { poolRefillLogPath } from "../src/lib/workspace-paths.ts";
import { EMPTY_IDLE_MS } from "../src/lib/workspace-sweep.ts";
import { withWorkspaceTransaction } from "../src/lib/workspace-transaction.ts";

// The suite disables the allocation-time trigger; these tests exercise it.
delete process.env.SLIPJAY_AUTO_HOUSEKEEPING;

const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);
const held = (promise: Promise<unknown>) => promise.then(() => true, () => true);

test("housekeeping retires an unused empty workspace without any landing", async () => {
  const f = await project();
  try {
    const idle = await createWorkspace("idle", f.repo);
    const recent = await runHousekeeping(f.repo, { issueClosed: () => null });
    assert.equal(recent.ran, true);
    assert.ok(existsSync(idle.workspacePath), "a recently assigned workspace is kept");

    const swept = await runHousekeeping(f.repo, { now: later(), issueClosed: () => null, intervalMs: 0 });
    assert.deepEqual(swept.ran && swept.result.removed, [idle.current.name]);
    assert.ok(!names(f.repo).includes(idle.current.name));
  } finally { await f.dispose(); }
}, 120_000);

test("concurrent housekeeping triggers for one repository run one sweep", async () => {
  const f = await project();
  try {
    const idle = await createWorkspace("idle", f.repo);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => runHousekeeping(f.repo, { now: later(), issueClosed: () => null })));
    const ran = outcomes.filter((outcome) => outcome.ran);
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0]?.ran && ran[0].result.removed, [idle.current.name]);
    for (const outcome of outcomes) if (!outcome.ran) assert.match(outcome.reason, /running|recent/);
  } finally { await f.dispose(); }
}, 120_000);

test("a repository whose sweep is running does not block another repository's housekeeping", async () => {
  const busy = await project();
  const other = await project();
  try {
    const idle = await createWorkspace("idle", other.repo);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const holding = held(withWorkspaceTransaction(`housekeeping:${busy.repo}`, async () => { entered(); await blocker; }));
    await inside;
    try {
      assert.deepEqual(await runHousekeeping(busy.repo, { now: later(), issueClosed: () => null }), { ran: false, reason: "running" });
      const swept = await runHousekeeping(other.repo, { now: later(), issueClosed: () => null });
      assert.deepEqual(swept.ran && swept.result.removed, [idle.current.name]);
    } finally { release(); await holding; }
  } finally { await busy.dispose(); await other.dispose(); }
}, 120_000);

test("the detached housekeeping child runs the sweep and logs its outcome", async () => {
  const f = await project();
  try {
    const result = await startHousekeeping(f.repo);
    assert.equal(result.started, true);
    const deadline = Date.now() + 30_000;
    let log = "";
    while (!/housekeeping:/.test(log)) {
      assert.ok(Date.now() < deadline, `the child logged its outcome: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      log = await readFile(poolRefillLogPath(), "utf8").catch(() => "");
    }
    assert.doesNotMatch(log, /housekeeping failed/);
  } finally { await f.dispose(); }
}, 120_000);

test("allocating a workspace through the library schedules the repository sweep, then skips while it is recent", async () => {
  const f = await project();
  try {
    await rm(poolRefillLogPath(), { force: true });
    await createWorkspace("first", f.repo);
    const deadline = Date.now() + 30_000;
    let log = "";
    while (!/housekeeping: \{"ran":true/.test(log)) {
      assert.ok(Date.now() < deadline, `allocation triggered a sweep: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      log = await readFile(poolRefillLogPath(), "utf8").catch(() => "");
    }
    assert.deepEqual(await startHousekeeping(f.repo), { started: false, reason: "recent" });
  } finally { await f.dispose(); }
}, 120_000);
