import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";

const trunk = (cwd: string) => jj(cwd, ["log", "-r", "trunk()", "--no-graph", "-T", "commit_id"]);
const integration = (cwd: string) => jj(cwd, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);

test("start points trunk() at the integration branch, even where jj chose another remote's default", async () => {
  const f = await project();
  try {
    // A fork cloned beside its upstream: jj names the upstream's default branch trunk().
    jj(f.repo, ["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"]);
    const workspace = await createWorkspace("Add widgets", f.repo);
    assert.equal(trunk(workspace.workspacePath), integration(workspace.workspacePath));
    assert.equal(trunk(f.repo), integration(f.repo), "the setting is the repository's, shared by every workspace");
  } finally {
    await f.dispose();
  }
}, 120_000);
