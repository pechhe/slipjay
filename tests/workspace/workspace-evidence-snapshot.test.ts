import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { later, names, declared, landedWorkspace } from "./fixtures/workspace-evidence-fixture.ts";

test("a file no history holds, written during retirement, keeps the workspace", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "late notes");
    const result = await cleanupLandedWorkspace(workspace.workspacePath, {
      afterChecks: async () => {
        await mkdir(join(workspace.workspacePath, "notes"), { recursive: true });
        await writeFile(join(workspace.workspacePath, "notes", "late.md"), "mine\n");
      },
    });
    assert.deepEqual(result, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.equal(await readFile(join(workspace.workspacePath, "notes", "late.md"), "utf8"), "mine\n");
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: false, reason: "unique-files", paths: ["notes/late.md"] });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the plan does not mistake a file rewritten with its snapshot's bytes for an edit, and still reports a real one", async () => {
  const f = await project();
  try {
    const rewritten = await createWorkspace("rewritten", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    const future = new Date(Date.now() + 60_000);
    for (const workspace of [rewritten, edited]) await utimes(join(workspace.workspacePath, "README.md"), future, future);
    await writeFile(join(edited.workspacePath, "README.md"), "changed\n");
    await utimes(join(edited.workspacePath, "README.md"), future, future);

    const options = { now: later() };
    const plan = Object.fromEntries((await planDisposableWorkspaces(f.repo, options)).map((entry) => [entry.name, entry]));
    assert.equal(plan[rewritten.current.name]?.action, "remove", plan[rewritten.current.name]?.reason ?? "");
    assert.equal(plan[edited.current.name]?.action, "keep");
    assert.match(plan[edited.current.name]?.reason ?? "", /edited since its last snapshot: README\.md/);

    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(swept.removed.includes(rewritten.current.name), "the sweep agrees with the plan");
    assert.ok(names(f.repo).includes(edited.current.name), "the edit snapshots into unlanded work and is kept");
  } finally {
    await f.dispose();
  }
}, 120_000);
