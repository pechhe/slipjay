import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, readySpares } from "../../src/lib/workspace/workspace-pool.ts";
import { listWorkspaces } from "../../src/lib/workspace/workspace-state.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { bunProject, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("the pool keeps as many spares as declared, counting those still being prepared", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    const [first, second] = await Promise.all([provisionSpare(f.repo), provisionSpare(f.repo)]);
    assert.deepEqual([first.provisioned, second.provisioned], [true, true]);
    assert.notEqual(first.name, second.name, "concurrent refills prepare different spares");
    assert.equal((await readySpares(f.repo)).length, 2);
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "spare-exists" });
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a pool of none provisions nothing", async () => {
  const f = await bunProject({ spares: 0 });
  try {
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "pool-disabled" });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a claim during an in-flight refill takes a ready spare and leaves the one being prepared", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    const [ready] = [await provisionSpare(f.repo)];
    assert.equal(ready.provisioned, true);
    process.env.FIXTURE_INSTALL_DELAY_MS = "6000";
    const refill = provisionSpare(f.repo);
    const deadline = Date.now() + 60_000;
    let inFlight: string | undefined;
    while (!inFlight) {
      assert.ok(Date.now() < deadline, "the second spare registered");
      inFlight = (await listWorkspaces(f.repo)).find((workspace) => workspace.metadata?.spare === true && workspace.metadata?.prepared === false)?.name;
      if (!inFlight) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true, "the claim did not install synchronously");
    assert.equal(created.workspacePath, ready.workspacePath, "it took the ready spare");
    assert.ok((await listWorkspaces(f.repo)).some((workspace) => workspace.name === inFlight), "the spare being prepared was left alone");
    const finished = await refill;
    assert.equal(finished.provisioned, true);
    assert.deepEqual((await readySpares(f.repo)).map((spare) => spare.name), [inFlight]);
  } finally {
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 180_000);

test("a refill adopts a spare whose preparer died and finishes it", async () => {
  const f = await bunProject();
  try {
    const first = await provisionSpare(f.repo);
    const [spare] = await readySpares(f.repo);
    await writeFile(metadataPath(spare!.name), JSON.stringify({ ...await workspaceMetadata(spare!.name), prepared: false, preparingPid: 2 ** 22 + 1 }));
    assert.equal((await readySpares(f.repo)).length, 0);
    const adopted = await provisionSpare(f.repo);
    assert.deepEqual([adopted.provisioned, adopted.name], [true, first.name]);
    assert.equal((await readySpares(f.repo)).length, 1);
  } finally {
    await f.dispose();
  }
}, 180_000);
