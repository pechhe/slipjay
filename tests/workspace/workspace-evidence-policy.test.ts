import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { landedWorkspace, previewOutput } from "./fixtures/workspace-evidence-fixture.ts";

test("undeclared local runtime output keeps a landed workspace: nothing under .t3 is disposable by default", async () => {
  const f = await project({ ignore: ".t3/\n" });
  try {
    const workspace = await landedWorkspace(f, "undeclared");
    await previewOutput(workspace.workspacePath);
    const result = await cleanupLandedWorkspace(workspace.workspacePath);
    assert.equal(result.cleaned, false);
    assert.equal(result.reason, "unique-files");
    assert.ok(result.paths?.some((path) => path.startsWith(".t3/")), JSON.stringify(result));
    assert.ok(existsSync(join(workspace.workspacePath, ".t3", "review", "issue-7-review.md")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("evidencePaths is validated with the other slipjay.json keys", () => {
  const policy = (evidencePaths: unknown) => JSON.stringify({ version: 1, integrationBranch: "main", evidencePaths });
  assert.deepEqual(parseExecutionPolicy(policy([".t3/review"])).evidencePaths, [".t3/review"]);
  assert.throws(() => parseExecutionPolicy(policy("review")), /evidencePaths must be an array/);
  assert.throws(() => parseExecutionPolicy(policy(["../outside"])), /evidencePaths entry "\.\.\/outside"/);
  assert.throws(() => parseExecutionPolicy(policy(["**"])), /evidencePaths entry/);
});

test("declared paths come from the policy committed on the integration branch, never the primary checkout's working files", async () => {
  const f = await project({ ignore: ".t3/\n" });
  try {
    const workspace = await landedWorkspace(f, "uncommitted policy");
    await previewOutput(workspace.workspacePath);
    // A stale or unlanded local edit on one host must not change what retirement may delete there.
    const policyPath = join(f.repo, "slipjay.json");
    await writeFile(policyPath, JSON.stringify({ ...JSON.parse(await readFile(policyPath, "utf8")), generatedPaths: [".t3"] }));
    const result = await cleanupLandedWorkspace(workspace.workspacePath);
    assert.equal(result.reason, "unique-files", JSON.stringify(result));
    assert.ok(existsSync(join(workspace.workspacePath, ".t3", "review", "issue-7-review.md")));
  } finally {
    await f.dispose();
  }
}, 120_000);
