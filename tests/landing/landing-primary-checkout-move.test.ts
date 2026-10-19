import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { primary, land, status } from "./fixtures/landing-primary-checkout-fixture.ts";

test("an empty primary checkout moves onto the new integration", async () => {
  const f = await project();
  try {
    const { workspace, result } = await land(f, "empty.txt");
    assert.deepEqual(result.primaryCheckout, { action: "moved" });
    assert.equal(primary(f).parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
    assert.deepEqual((await status(workspace.workspacePath)).landing, {
      phase: "landed", artifactCommitId: result.artifactCommitId, primaryCheckout: { action: "moved" } });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("uncommitted primary edits are carried onto the new integration unchanged", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "local.txt"), "unlanded\n");
    const before = primary(f);
    await land(f, "first.txt");
    const { result } = await land(f, "second.txt");
    assert.deepEqual(result.primaryCheckout, { action: "moved", reason: "carried-edits" });
    const after = primary(f);
    assert.equal(after.change, before.change);
    assert.equal(after.parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
    assert.equal(after.conflict, false);
    assert.equal(await readFile(join(f.repo, "local.txt"), "utf8"), "unlanded\n");
    assert.equal(await readFile(join(f.repo, "second.txt"), "utf8"), "second.txt\n");
    assert.match(jj(f.repo, ["diff", "-r", "@", "--name-only"]), /^local\.txt$/m);
  } finally {
    await f.dispose();
  }
}, 180_000);
