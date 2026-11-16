import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, refillPool } from "../../src/lib/workspace/workspace-pool.ts";
import { poolSpares, spareRecords } from "../../src/lib/workspace/workspace-spares.ts";
import { acquireWorkspaceClaim } from "../../src/lib/workspace/workspace-claims.ts";
import { claimController } from "../../src/lib/workspace/workspace-claim-identity.ts";
import { machineConfigPath } from "../../src/lib/workspace/workspace-paths.ts";

async function withConfig(config: Record<string, unknown>, action: () => Promise<void>) {
  const path = machineConfigPath();
  const original = await readFile(path, "utf8").catch(() => null);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...original ? JSON.parse(original) as object : {}, ...config }));
  try { await action(); }
  finally { if (original === null) await rm(path, { force: true }); else await writeFile(path, original); }
}

test("a fresh start refuses below the hard minimum and refill refuses below the soft floor",  async () => {
  const f = await project();
  try {
    await withConfig({ disk: { floor: { bytes: 2 ** 50, percent: 0 }, hardMinimum: { bytes: 2 ** 50, percent: 0 } } }, async () => {
      const before = jj(f.repo, ["workspace", "list"]);
      await assert.rejects(createWorkspace("no-headroom", f.repo), /Disk hard minimum: .* free, .* required/);
      assert.equal(jj(f.repo, ["workspace", "list"]), before);
      const outcomes: object[] = [];
      await refillPool(f.repo, (outcome) => outcomes.push(outcome));
      assert.ok(outcomes.some((outcome) => "reason" in outcome && String(outcome.reason).includes("Disk free-space floor")));
      assert.equal((await spareRecords(f.repo)).length, 0);
    });
  } finally { await f.dispose(); }
});

test("below the soft floor a fresh start warns and proceeds while refill stops", async () => {
  const f = await project();
  const warn = console.warn;
  const warnings: string[] = [];
  try {
    await withConfig({ disk: { floor: { bytes: 2 ** 50, percent: 0 }, hardMinimum: { bytes: 0, percent: 0 } } }, async () => {
      console.warn = (text) => warnings.push(String(text));
      const workspace = await createWorkspace("soft-pressure", f.repo);
      assert.ok(workspace.workspacePath);
      assert.match(warnings.join("\n"), /WARNING: Disk free-space floor/);
      const outcomes: object[] = [];
      await refillPool(f.repo, (outcome) => outcomes.push(outcome));
      assert.ok(outcomes.some((outcome) => "reason" in outcome && String(outcome.reason).includes("Disk free-space floor")));
    });
  } finally { console.warn = warn; await f.dispose(); }
});

test("the hard minimum also refuses a fresh claim of a ready spare without consuming it", async () => {
  const f = await project();
  try {
    assert.equal((await provisionSpare(f.repo)).provisioned, true);
    await withConfig({ disk: { floor: { bytes: 2 ** 50, percent: 0 }, hardMinimum: { bytes: 2 ** 50, percent: 0 } } }, async () => {
      await assert.rejects(createWorkspace("hard-pooled", f.repo), /Disk hard minimum/);
      assert.equal((await spareRecords(f.repo)).length, 1);
    });
  } finally { await f.dispose(); }
});

test("custody on a spare consumes the allowance without making a replacement or admitting a claim to it", async () => {
  const f = await project();
  try {
    await withConfig({ spares: { [f.repo]: 1 } }, async () => {
      const provisioned = await provisionSpare(f.repo);
      assert.equal(provisioned.provisioned, true);
      assert.ok(provisioned.workspacePath && provisioned.name);
      await acquireWorkspaceClaim(provisioned.workspacePath, f.repo, provisioned.name, { requestId: "held:spare", ownerId: "owner", credential: "x".repeat(32), controller: await claimController(), obligationRef: "owner:obligations" });
      const pool = await poolSpares(f.repo);
      assert.equal(pool.spares.length, 0);
      assert.equal(pool.held[0]!.custody, true);
      assert.equal((await provisionSpare(f.repo)).reason, "spare-exists");
      assert.equal((await spareRecords(f.repo)).length, 1);
    });
  } finally { await f.dispose(); }
});
