import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, readySpares, refreshSpares } from "../../src/lib/workspace/workspace-pool.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { bunProject, spareName } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("an install with no spare to claim clones node_modules from the primary checkout, then verifies it", async () => {
  const f = await bunProject();
  try {
    const created = await createWorkspace("seeded", f.repo);
    assert.equal(created.pooled, false);
    assert.equal((created.readiness as { seeded?: boolean }).seeded, true, "the primary's install inputs matched, so its node_modules seeded this one");
    assert.equal(await f.count(), 1, "the verifying install ran");
    const modules = join(created.workspacePath, "node_modules");
    assert.ok(existsSync(join(modules, ".bun")), "the cloned tree is in place");
    for (const entry of await readdir(modules)) {
      const path = join(modules, entry);
      if (!lstatSync(path).isSymbolicLink()) continue;
      assert.ok(!readlinkSync(path).startsWith("/"), `${entry} is a relative link, so it resolves inside the new checkout`);
      assert.ok(existsSync(path), `${entry} resolves`);
    }
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a spare on the integration head whose recorded install inputs are stale is refreshed, then claimed without installing", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const name = await spareName(f.repo);
    // As after a fingerprint format change or a package-manager upgrade: the spare is current, its record is not.
    const metadata = (await workspaceMetadata(name))!;
    await writeFile(metadataPath(name), JSON.stringify({ ...metadata, preparedDependencies: { ...metadata.preparedDependencies as object, installInputs: "sha256:stale" } }));

    assert.deepEqual((await refreshSpares(f.repo)).map((spare) => spare.name), [name], "the stale record is refreshed although the spare is on the head");
    const [spare] = await readySpares(f.repo);
    assert.equal((spare!.metadata?.preparedDependencies as { installInputs?: string }).installInputs, await installInputFingerprint(spare!.root));
    assert.deepEqual(await refreshSpares(f.repo), [], "a current record is left alone");

    const before = await f.count();
    const created = await createWorkspace("task", f.repo);
    assert.equal((created.readiness as { reused?: boolean }).reused, true, "the claim reuses the refreshed dependencies");
    assert.equal(await f.count(), before, "no install ran on claim");
  } finally {
    await f.dispose();
  }
}, 120_000);
