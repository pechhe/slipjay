import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test, vi } from "vite-plus/test";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";
import { runHousekeeping } from "../../src/lib/workspace/workspace-housekeeping.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { trashHome } from "../../src/lib/workspace/workspace-paths.ts";
import { discardCheckout, emptyTrash } from "../../src/lib/workspace/workspace-trash.ts";

const trash = () => readdir(trashHome()).catch(() => []);

test("removing a workspace moves its checkout into the trash, and the trash empties in the background", async () => {
  const f = await project();
  try {
    const created = await createWorkspace("to discard", f.repo);
    await writeFile(join(created.workspacePath, "scratch.log"), "output\n");
    // While another deletion holds the trash, removal still returns, leaving the checkout in the trash.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding!: () => void;
    const acquired = new Promise<void>((resolve) => { holding = resolve; });
    const holder = withWorkspaceTransaction("trash", async () => { holding(); await held; });
    await acquired;
    await removeWorkspace(f.repo, created.current.name, { allowWork: true });
    assert.equal(existsSync(created.workspacePath), false);
    assert.ok(!jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").includes(created.current.name));
    const [entry] = await trash();
    assert.ok(entry?.startsWith(`${basename(created.workspacePath)}-`), String(entry));
    assert.equal(await readFile(join(trashHome(), entry!, "scratch.log"), "utf8"), "output\n");
    release();
    await holder;
    // The deletion the removal started found the trash held and stopped; the next sweep restarts it.
    await runHousekeeping(f.repo);
    await vi.waitFor(async () => assert.deepEqual(await trash(), []), { timeout: 15_000, interval: 100 });
  } finally {
    await f.dispose();
  }
});

test("a trash entry a crash left behind is deleted by the next emptying, and a missing checkout is nothing to discard", async () => {
  const left = join(trashHome(), "t3-spare-abc123-1-deadbeef");
  await mkdir(join(left, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(left, "node_modules", "pkg", "index.js"), "");
  await vi.waitFor(async () => { await emptyTrash(); assert.deepEqual(await trash(), []); }, { timeout: 15_000, interval: 100 });
  await discardCheckout(join(trashHome(), "..", "workspaces", "never-existed"));
  assert.deepEqual(await trash(), []);
});
