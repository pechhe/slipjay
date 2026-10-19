import { jj } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, readySpares, spareAllowance } from "../../src/lib/workspace/workspace-pool.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { machineConfigPath } from "../../src/lib/workspace/workspace-paths.ts";
import { setMachineSpareLimit } from "../../src/lib/policy/machine-config.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { advance, bunProject, withMachineSpares, counts, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("this machine's limit lowers a repository's declared spares, never raises them, and 0 disables the pool here", async () => {
  const f = await bunProject({ spares: 8 });
  try {
    const context = (await workspaceContext(f.repo))!;
    await withMachineSpares({ [f.repo]: 3 }, async () => {
      await refill(f.repo);
      assert.equal((await readySpares(f.repo)).length, 3, "the pool stops at the machine's limit");
    });
    await withMachineSpares({ [f.repo]: 2 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 2, declared: 8, machineLimit: 2 });
      const outcomes = await refill(f.repo);
      assert.equal(outcomes.filter((outcome) => "retired" in outcome).length, 1, "lowering the limit retires the excess spare");
      assert.equal((await readySpares(f.repo)).length, 2);
      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, true, "a claim still takes a ready spare");
    });
    await withMachineSpares({ [f.repo]: 0 }, async () => {
      assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "pool-disabled" });
    });
    await withMachineSpares({ "/elsewhere/other": 0 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 8, declared: 8, machineLimit: null }, "another checkout's limit does not apply");
    });
  } finally {
    await f.dispose();
  }
  const g = await bunProject({ spares: 1 });
  try {
    const context = (await workspaceContext(g.repo))!;
    await withMachineSpares({ [g.repo]: 3 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 1, declared: 1, machineLimit: 3 });
    });
    await withMachineSpares({ [g.repo]: 9 }, async () => {
      await assert.rejects(spareAllowance(context), /spares must be an integer from 0 to 8/);
    });
    await withMachineSpares([] as unknown as Record<string, unknown>, async () => {
      await assert.rejects(spareAllowance(context), /must map integration checkout paths to spare counts/);
    });
  } finally {
    await g.dispose();
  }
}, 240_000);

test("the allowance comes from the integration bookmark's committed policy, never the checkout's working files", async () => {
  const f = await bunProject({ spares: 3 });
  const main = () => jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]).trim();
  const setSpares = async (spares: number) => {
    const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
    await writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ ...policy, spares }));
  };
  try {
    await setSpares(1);
    const allowance = await spareAllowance((await workspaceContext(f.repo))!);
    assert.deepEqual(allowance, { spares: 3, declared: 3, machineLimit: null, source: { integrationBranch: "main", commitId: main() } },
      "an uncommitted edit in the primary checkout does not change the allowance");
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 3);
    await setSpares(2);
    advance(f.repo, "Lower spares");
    const lowered = await spareAllowance((await workspaceContext(f.repo))!);
    assert.deepEqual(lowered.source, { integrationBranch: "main", commitId: main() }, "the source names the commit read");
    assert.equal(lowered.declared, 2);
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 2, "the pool never exceeds the allowance");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("retiring assigned workspaces leaves the pool at its allowance, and old checkout paths still count", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    await refill(f.repo);
    const claimed = await createWorkspace("task", f.repo);
    assert.equal(claimed.pooled, true);
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 2);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000, issueClosed: () => null });
    assert.deepEqual(swept.removed, [claimed.current.name], "the idle assigned workspace retires");
    assert.equal((await readySpares(f.repo)).length, 2, "retiring it takes no spare");

    // A limit keyed by another spelling of the checkout's path, such as a symlink, still applies.
    const alias = join(f.root, "alias");
    await symlink(f.repo, alias);
    await withMachineSpares({ [alias]: 1 }, async () => {
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).machineLimit, 1);
      // Setting or clearing the limit replaces every spelling of the checkout's path.
      await setMachineSpareLimit(f.repo, 0);
      assert.deepEqual(JSON.parse(await readFile(machineConfigPath(), "utf8")).spares, { [await realpath(f.repo)]: 0 });
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).spares, 0);
      await setMachineSpareLimit(alias, null);
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).machineLimit, null);
    });
    // A spare recorded under the checkout's old path is still one of this repository's.
    const [spare] = await readySpares(f.repo);
    await writeFile(metadataPath(spare!.name), JSON.stringify({ ...await workspaceMetadata(spare!.name), integrationRoot: join(f.root, "old-checkout") }));
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "spare-exists" }, "the moved spare counts against the allowance");
  } finally {
    await f.dispose();
  }
}, 240_000);
