import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { MAX_EVIDENCE_BYTES } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { evidenceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { names, declared, landedWorkspace, previewOutput } from "./fixtures/workspace-evidence-fixture.ts";

async function preserved() {
  return (await readdir(evidenceHome()).catch(() => [])).filter((name) => !name.endsWith(".partial"));
}

test("a landed workspace retires with its runtime output discarded and its evidence preserved with provenance", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "evidence");
    await previewOutput(workspace.workspacePath);
    const before = await preserved();

    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.ok(!existsSync(workspace.workspacePath));
    assert.ok(!names(f.repo).includes(workspace.current.name));

    const added = (await preserved()).filter((name) => !before.includes(name));
    assert.equal(added.length, 1);
    assert.ok(added[0]!.startsWith(`${workspace.current.name}-`));
    const directory = join(evidenceHome(), added[0]!);
    const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
    assert.equal(provenance.workspaceName, workspace.current.name);
    assert.equal(provenance.repository, f.repo);
    assert.equal(provenance.task, "evidence");
    assert.match(provenance.landing?.artifactCommitId ?? "", /^[0-9a-f]{40}$/);
    assert.equal(jj(f.repo, ["log", "-r", `${provenance.landing.artifactCommitId} & ::main`, "--no-graph", "-T", "'x'"]), "x", "the provenance names the integrated artifact");
    assert.deepEqual(provenance.files, [{
      path: ".t3/review/issue-7-review.md", bytes: 10, sha256: createHash("sha256").update("Approved.\n").digest("hex"),
    }]);
    assert.equal(await readFile(join(directory, "files", ".t3", "review", "issue-7-review.md"), "utf8"), "Approved.\n");
    assert.ok(!existsSync(join(directory, "files", ".t3", "userdata")), "runtime output is not evidence");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("evidence too large to preserve keeps the workspace with what to do", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "oversized");
    await mkdir(join(workspace.workspacePath, ".t3", "review"), { recursive: true });
    const large = join(workspace.workspacePath, ".t3", "review", "capture.bin");
    await writeFile(large, "");
    await truncate(large, MAX_EVIDENCE_BYTES + 1);
    const before = await preserved();

    await assert.rejects(cleanupLandedWorkspace(workspace.workspacePath), /MiB of evidence under evidencePaths.*move what is needed elsewhere/);
    assert.ok(existsSync(large));
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.deepEqual(await preserved(), before);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("evidence that changes while it is copied keeps the workspace, removes the copy, and the next retirement preserves it afresh", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "changing evidence");
    await previewOutput(workspace.workspacePath);
    const review = join(workspace.workspacePath, ".t3", "review", "issue-7-review.md");
    const interrupted = join(evidenceHome(), `${workspace.current.name}-2026-01-01T00-00-00-000Z.partial`);
    await mkdir(interrupted, { recursive: true });
    // A copy in flight for a sibling workspace whose name extends this one's.
    const sibling = join(evidenceHome(), `${workspace.current.name}-2-2026-01-01T00-00-00-000Z.partial`);
    await mkdir(sibling, { recursive: true });
    const before = await preserved();

    const raced = await cleanupLandedWorkspace(workspace.workspacePath, { afterEvidence: () => writeFile(review, "Approved, with a follow-up.\n") });
    assert.deepEqual(raced, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.deepEqual(await preserved(), before, "the stale copy is removed");
    assert.ok(!existsSync(interrupted), "an interrupted copy of the workspace is removed");
    assert.ok(existsSync(sibling), "another workspace's copy is not");

    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    const [added] = (await preserved()).filter((name) => !before.includes(name));
    await rm(sibling, { recursive: true, force: true });
    assert.equal(await readFile(join(evidenceHome(), added!, "files", ".t3", "review", "issue-7-review.md"), "utf8"), "Approved, with a follow-up.\n");
  } finally {
    await f.dispose();
  }
}, 120_000);
