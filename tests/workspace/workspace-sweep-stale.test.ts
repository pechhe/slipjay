import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { later } from "./fixtures/workspace-sweep-fixture.ts";
import { landedState } from "./fixtures/landed-state.ts";

/** Advance `main` in the primary checkout and move `workspace`'s change onto it from there, so its checkout goes stale. */
async function rewriteUnder(repo: string, workspace: string) {
  await writeFile(join(repo, "advanced.txt"), "advanced\n");
  jj(repo, ["commit", "-m", "Advance main"]);
  jj(repo, ["bookmark", "set", "main", "-r", "@-"]);
  jj(repo, ["rebase", "-r", `${workspace}@`, "-d", "main"]);
}

test("a stale idle workspace is updated and swept, but one holding edits is kept with them", async () => {
  const f = await project();
  try {
    const clean = await createWorkspace("clean", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    await writeFile(join(edited.workspacePath, "draft.txt"), "mine\n");
    await rewriteUnder(f.repo, clean.current.name);
    jj(f.repo, ["rebase", "-r", `${edited.current.name}@`, "-d", "main"]);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(swept.removed, [clean.current.name], JSON.stringify(swept.skipped));
    assert.match(swept.skipped.find(({ name }) => name === edited.current.name)?.reason ?? "", /held edits/);
    assert.equal(await readFile(join(edited.workspacePath, "draft.txt"), "utf8"), "mine\n", "the edits are back on disk");
    assert.match(jj(edited.workspacePath, ["diff", "--summary"]), /draft\.txt/, "and in the checkout's own change");
    assert.equal(jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", '"x"']), "", "the empty rebased twin is gone");
    const again = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(again.removed, [], "a later sweep still keeps the edits");
    assert.ok(existsSync(join(edited.workspacePath, "draft.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup updates a landed workspace whose working copy went stale, then releases it", async () => {
  const f = await project();
  try {
    // Only the later stale-checkout transition is under test; see landedState's coverage contract.
    const landed = await landedState(f, "landed");
    assert.ok(existsSync(landed.workspacePath), "the seeded delivered checkout is available for cleanup");
    await rewriteUnder(f.repo, landed.current.name);
    assert.deepEqual(await cleanupLandedWorkspace(landed.workspacePath), { cleaned: true });
    assert.equal(existsSync(landed.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);
