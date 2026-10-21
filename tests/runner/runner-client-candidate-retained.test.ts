import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture } from "./fixtures/runner-client-fixture.ts";

// Build #3009: a landing that fails removes its remote candidate bookmark (the runner's cleanup). Another
// workspace that imported the bookmark before then must not lose the candidate or have its stacked child rebased.
const show = (cwd: string, revision: string, template: string) => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", template]);

async function failedLandingWithStackedChild() {
  const f = await fixture();
  f.failNextSubmission("lost");
  await assert.rejects(landThroughRunner(f.cwd, f.options), /outcome is unknown/);
  const [op] = f.log.openOperations();
  assert.ok(op);
  const candidate = show(f.cwd, f.change, "commit_id");
  const sourceTree = jj(f.cwd, ["file", "show", "-r", candidate, "change.txt"]);

  // A second workspace stacks a child on the candidate, as an author continuing the work would.
  const other = await createWorkspace("stacked child", f.repo);
  jj(other.workspacePath, ["new", candidate, "-m", "Stacked child"]);
  await writeFile(join(other.workspacePath, "child.txt"), "child\n");
  const child = show(other.workspacePath, "@", "commit_id");
  const childParents = show(other.workspacePath, "@", 'parents.map(|c| c.commit_id()).join(",")');
  assert.equal(childParents, candidate);

  // The other workspace imports every bookmark while the runner holds the candidate...
  jj(other.workspacePath, ["git", "fetch"]);
  assert.equal(show(other.workspacePath, candidate, "immutable"), "true");
  // ...the landing fails, and the runner's cleanup deletes the remote bookmark...
  f.append(op.id, { type: "failed", stage: "verifying", reason: "fixture gate failed" });
  execFileSync("git", ["--git-dir", f.remote, "branch", "-D", `slipjay/changes/${f.change}`], { stdio: "pipe" });
  // ...and the next import in that workspace sees it gone.
  jj(other.workspacePath, ["git", "fetch"]);
  return { f, op, candidate, sourceTree, child, other };
}

test("importing a failed landing's deleted candidate bookmark keeps the candidate, the source workspace and the stacked child", async () => {
  const { f, candidate, sourceTree, child, other } = await failedLandingWithStackedChild();
  try {
    for (const cwd of [f.cwd, other.workspacePath]) {
      assert.equal(show(cwd, candidate, "commit_id"), candidate, "the candidate is still visible");
      assert.equal(jj(cwd, ["file", "show", "-r", candidate, "change.txt"]), sourceTree, "with its exact tree");
    }
    assert.equal(show(f.cwd, f.change, "commit_id"), candidate, "the source workspace's change is still the candidate");
    assert.equal(show(other.workspacePath, child, "commit_id"), child, "the stacked child was not rewritten");
    assert.equal(show(other.workspacePath, child, 'parents.map(|c| c.commit_id()).join(",")'), candidate, "and still sits on the candidate");
  } finally { await f.dispose(); }
});

test("rerunning after the failed landing reaches the original submission's outcome without a replacement change or manual repair", async () => {
  const { f, op, candidate } = await failedLandingWithStackedChild();
  try {
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.operation.id, op.id);
    assert.equal(result.ok, false);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1, "no replacement submission");
    assert.equal(show(f.cwd, f.change, "commit_id"), candidate, "the source change is still the candidate");
    assert.equal(jj(f.cwd, ["bookmark", "list", `slipjay/changes/${f.change}`, "--all-remotes"]), "", "the temporary references are retired once the outcome is reconciled");
    // The rerun pushed the candidate again; with the operation closed long ago, nothing but the client deletes that copy.
    assert.equal(execFileSync("git", ["--git-dir", f.remote, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" }), "", "and the remote holds no copy to make the candidate immutable");
  } finally { await f.dispose(); }
});
