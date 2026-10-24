import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { cleanupLandedWorkspace, forgetWorkspace, removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue, statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../src/lib/workspace/workspace-finalization.ts";
import { pruneWorkspaceState } from "../../src/lib/workspace/workspace-state-prune.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { isolateAdoptionFixtures, runCli, freezeLead, contribution, publishSource } from "./fixtures/workspace-adopt-fixture.ts";
import { seedWorkspace } from "./fixtures/workspace-generation.ts";

isolateAdoptionFixtures();

for (const archival of ["cleanup", "prune"] as const) {
  test(`${archival} archives operation-bound adoption and source after publication without client follow-up`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      // Only archive proof is under test; seedWorkspace names the retained start-to-retirement E2E.
      const { lead, helper, base, revision } = await contribution(f, seedWorkspace);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      await freezeLead(lead.workspacePath, source);
      const review = await createWorkspace("review source", f.repo, { base: source });
      const state = await publishSource(f, lead, source, "fixture");
      await writeFile(statePath(lead.current.name), JSON.stringify(state));
      if (archival === "cleanup") assert.equal((await cleanupLandedWorkspace(lead.workspacePath)).cleaned, true,
        "published source ancestry must not keep the lead as new-unlanded-work");
      else await forgetWorkspace(f.repo, lead.current.name, lead.workspacePath);
      await pruneWorkspaceState();
      assert.equal(await workspaceMetadata(lead.current.name), null);
      const archives = await Promise.all((await readdir(landedHome())).filter((name) => name.startsWith("artifact-")).map(async (name) => JSON.parse(await readFile(join(landedHome(), name), "utf8"))));
      const archived = archives.find((record) => record.artifactCommitId === state.artifactCommitId);
      assert.equal(archived.publishedSource, source);
      assert.deepEqual(archived.adoptionCoverage, [{ workspaceName: helper.current.name, base, revisions: [revision] }]);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      assert.equal(await workspaceCoverage((await workspaceContext(review.workspacePath))!, review.current.name), "source-covered");
      await runCli(f.repo, "remove", helper.workspacePath);
      await sweepDisposableWorkspaces(f.repo, { emptyIdleMs: 0, pruneState: false });
      assert.equal(existsSync(review.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

for (const path of ["remove", "prune", "cleanup", "new-work"] as const) {
  test(`archived coverage judges original helper revisions after author state is pruned: ${path}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      // Keep real issue attachment and lifecycle checks on seeded, genuine JJ generations.
      const { lead, helper } = await contribution(f, seedWorkspace);
      await attachWorkspaceIssue(helper.workspacePath, 123);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      await writeFile(join(lead.workspacePath, "helper.txt"), "reworked\n");
      // Focused archive fixture: integration and the published archive are already established.
      // workspace-adopt-runner-*.test.ts exercise their creation through the real publishing runner.
      const artifactCommitId = jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      await freezeLead(lead.workspacePath, artifactCommitId);
      jj(f.repo, ["bookmark", "set", "main", "-r", artifactCommitId]);
      jj(f.repo, ["git", "push", "--bookmark", "main"]);
      await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), {
        version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath,
        integrationRoot: f.repo, integrationBranch: "main", artifactCommitId, operationId: "fixture",
      });
      await removeWorkspace(f.repo, lead.current.name, { retainMaterial: true });
      await pruneWorkspaceState();
      assert.equal(await workspaceMetadata(lead.current.name), null);
      if (path === "remove") await runCli(f.repo, "remove", helper.workspacePath);
      if (path === "prune") await sweepDisposableWorkspaces(f.repo, { emptyIdleMs: 0, issueClosed: () => false });
      if (path === "cleanup") assert.equal((await cleanupLandedWorkspace(helper.workspacePath)).cleaned, true);
      if (path === "new-work") {
        jj(helper.workspacePath, ["new"]);
        await writeFile(join(helper.workspacePath, "new.txt"), "unadopted\n");
        await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
      } else assert.equal(existsSync(helper.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

test("historical handoff helpers without archived adoption coverage never authorise deletion", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    // The absent archive proof is the subject; see seedWorkspace's coverage contract.
    const { lead, helper, base, revision } = await contribution(f, seedWorkspace);
    const artifactCommitId = jj(lead.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", artifactCommitId]);
    const state = { version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath, integrationRoot: f.repo,
      integrationBranch: "main", artifactCommitId, helpers: [{ revision, base, scope: "helper.txt" }] };
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
    await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
  } finally { await f.dispose(); }
});
