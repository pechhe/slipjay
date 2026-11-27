import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { readLandingState } from "../../src/lib/workspace/workspace-state.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { primary, land } from "./fixtures/landing-primary-checkout-fixture.ts";

test("an empty primary checkout moves onto the new integration, and uncommitted primary edits are carried unchanged", async () => {
  const f = await project();
  try {
    await withTestRunner(f, async (runner) => {
      const { workspace, result: emptyResult } = await land(f, "empty.txt", runner);
      assert.deepEqual(emptyResult.primaryCheckout, { action: "moved" });
      assert.equal(primary(f).parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
      const state = (await readLandingState(workspace.current.name, { readOnly: true }))!;
      assert.deepEqual({ phase: state.phase, artifactCommitId: state.artifactCommitId, primaryCheckout: state.primaryCheckout }, {
        phase: "landed", artifactCommitId: emptyResult.artifactCommitId, primaryCheckout: { action: "moved" } });

      await writeFile(join(f.repo, "local.txt"), "unlanded\n");
      const before = primary(f);
      await land(f, "first.txt", runner);
      const { result } = await land(f, "second.txt", runner);
      assert.deepEqual(result.primaryCheckout, { action: "moved", reason: "carried-edits" });
      const after = primary(f);
      assert.equal(after.change, before.change);
      assert.equal(after.parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
      assert.equal(after.conflict, false);
      assert.equal(await readFile(join(f.repo, "local.txt"), "utf8"), "unlanded\n");
      assert.equal(await readFile(join(f.repo, "second.txt"), "utf8"), "second.txt\n");
      assert.match(jj(f.repo, ["diff", "-r", "@", "--name-only"]), /^local\.txt$/m);
    });
  } finally {
    await f.dispose();
  }
}, 180_000);
