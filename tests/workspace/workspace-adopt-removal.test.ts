import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { cleanupLandedWorkspace, missingCheckoutRefusal, removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue, metadataPath, statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { bindLandingOperation, writtenLandingHandoff } from "../../src/lib/landing/submission-adoptions.ts";
import { land } from "./fixtures/workspace-sweep-fixture.ts";
import { isolateAdoptionFixtures, runCli, publishSource } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

test("allowWork preserves policy cleanup semantics; CLI discard still refuses a live holder", async () => {
  const f = await project({ ignore: "unique.txt\n", policy: { spares: 0 } });
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    const workspace = await createWorkspace("policy cleanup", f.repo);
    await writeFile(join(workspace.workspacePath, "work.txt"), "work\n");
    await writeFile(join(workspace.workspacePath, "unique.txt"), "material for explicit cleanup\n");
    jj(workspace.workspacePath, ["describe", "-m", "Work"]);
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: workspace.workspacePath, stdio: "ignore", detached: true });
    await assert.rejects(runCli(f.repo, "remove", "--discard", workspace.workspacePath), /live process/);
    holder.kill();
    await new Promise<void>((resolve) => holder!.once("exit", () => resolve()));
    holder = null;
    await removeWorkspace(f.repo, workspace.current.name, { allowWork: true, allowIssue: true });
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally { holder?.kill(); await f.dispose(); }
});

for (const resolution of ["closed", "discard", "unbound-cleanup"] as const) {
  test(`source-only coverage ${resolution === "unbound-cleanup" ? "delivers an unbound review workspace" : `preserves the open Issue guard until ${resolution}`}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const lead = await createWorkspace("source only", f.repo);
      await writeFile(join(lead.workspacePath, "source.txt"), "published source\n");
      jj(lead.workspacePath, ["describe", "-m", "Source only"]);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      assert.equal(await writtenLandingHandoff(context, "source-only", source, false, async () => undefined), undefined);
      await bindLandingOperation(context, "source-only", "source-only");
      const review = await createWorkspace("review only", f.repo, { base: source });
      if (resolution !== "unbound-cleanup") await attachWorkspaceIssue(review.workspacePath, 123);
      const state = await publishSource(f, lead, source, "source-only");
      await writeFile(statePath(lead.current.name), JSON.stringify(state));
      assert.equal((await cleanupLandedWorkspace(lead.workspacePath)).cleaned, true);
      assert.equal(await workspaceCoverage((await workspaceContext(review.workspacePath))!, review.current.name), "source-covered");
      if (resolution === "unbound-cleanup") {
        assert.equal((await cleanupLandedWorkspace(review.workspacePath)).cleaned, true);
        assert.equal(existsSync(review.workspacePath), false);
        return;
      }
      await assert.rejects(runCli(f.repo, "remove", review.workspacePath), /Issue|issue/);
      await sweepDisposableWorkspaces(f.repo, { pruneState: false, emptyIdleMs: 0, issueClosed: () => false });
      assert.equal(existsSync(review.workspacePath), true);
      if (resolution === "closed") await sweepDisposableWorkspaces(f.repo, { pruneState: false, emptyIdleMs: 0, issueClosed: () => true });
      else await runCli(f.repo, "remove", "--discard", review.workspacePath);
      assert.equal(existsSync(review.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

test("missing checkout removal ignores its own preparing pid and retains another live preparer", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const workspace = await createWorkspace("preparer", f.repo);
    const metadata = await workspaceMetadata(workspace.current.name);
    await rm(workspace.workspacePath, { recursive: true, force: true });
    const target = { ...workspace.current, root: workspace.workspacePath, metadata: { ...metadata, preparingPid: process.pid } };
    assert.equal(await missingCheckoutRefusal(f.repo, target), null);
    assert.match((await missingCheckoutRefusal(f.repo, { ...target, metadata: { ...target.metadata, preparingPid: process.ppid } }))!, /prepared by a live process/);
  } finally { await f.dispose(); }
});

test("explicit discard retains pending runner facts and unique files", async () => {
  const f = await project({ ignore: "unique.txt\n", policy: { spares: 0 } });
  try {
    const helper = await createWorkspace("unadopted", f.repo);
    await writeFile(join(helper.workspacePath, "work.txt"), "unlanded\n");
    jj(helper.workspacePath, ["describe", "-m", "Work"]);
    await attachWorkspaceIssue(helper.workspacePath, 123);
    await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
    await writeFile(join(helper.workspacePath, "unique.txt"), "only here\n");
    const discard = { allowWork: true, allowIssue: true, retainMaterial: true };
    await assert.rejects(removeWorkspace(f.repo, helper.current.name, discard), /unique|files cleanup/);
    await assert.rejects(runCli(f.repo, "remove", "--discard", helper.workspacePath), /unique|files cleanup/);
    const metadata = await workspaceMetadata(helper.current.name);
    await writeFile(metadataPath(helper.current.name), JSON.stringify({ ...metadata, pendingRunnerFacts: [{ id: "pending" }] }));
    await assert.rejects(removeWorkspace(f.repo, helper.current.name, discard), /pending runner facts/);
    await assert.rejects(runCli(f.repo, "remove", "--discard", helper.workspacePath), /pending runner facts/);
  } finally { await f.dispose(); }
});

for (const kind of ["unbound", "issue", "landed"] as const) {
  test(`remove --discard explicitly removes ${kind} unlanded work`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const workspace = await createWorkspace(`discard ${kind}`, f.repo);
      if (kind === "issue") await attachWorkspaceIssue(workspace.workspacePath, 123);
      if (kind === "landed") await land(f, workspace.workspacePath, "delivered.txt", { keep: true });
      await writeFile(join(workspace.workspacePath, "new.txt"), "unlanded\n");
      jj(workspace.workspacePath, ["describe", "-m", "Unlanded work"]);
      await assert.rejects(runCli(f.repo, "remove", workspace.workspacePath), /Kept/);
      await runCli(f.repo, "remove", "--discard", workspace.workspacePath);
      assert.equal(existsSync(workspace.workspacePath), false);
    } finally { await f.dispose(); }
  }, 180_000);
}
