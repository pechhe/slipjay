import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { forgetWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { listWorkspaces, renameWorkspace } from "../../src/lib/workspace/workspace-state.ts";
import { project } from "../support/workspace-project.ts";

test("a workspace renamed to a forgotten name resolves to its own checkout", async () => {
  const f = await project();
  try {
    const first = await createWorkspace("first", f.repo);
    await forgetWorkspace(f.repo, first.current.name, first.workspacePath);
    await rm(first.workspacePath, { recursive: true, force: true });

    const second = await createWorkspace("second", f.repo);
    const { name } = await renameWorkspace(second.workspacePath, first.current.name);

    assert.equal(name, first.current.name, "the forgotten name is free to reuse");
    const listed = (await listWorkspaces(f.repo)).find((workspace) => workspace.name === name);
    assert.equal(listed?.root, second.workspacePath);
  } finally {
    await f.dispose();
  }
}, 60_000);
