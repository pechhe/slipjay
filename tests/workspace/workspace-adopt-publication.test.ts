import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { planDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../src/lib/workspace/workspace-finalization.ts";
import { dropSupersededCandidate } from "../../src/lib/runner/runner-client.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { isolateAdoptionFixtures, runCli, freezeLead, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

for (const path of ["remove", "prune", "sweep", "new-work", "continuation", "shared-source", "shared-review-sweep", "shared-continuation"] as const) {
  test(`publication cleanup preserves the helper's pinned identity and archived coverage: ${path}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await attachWorkspaceIssue(helper.workspacePath, 123);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      await writeFile(join(lead.workspacePath, "helper.txt"), "reworked for publication\n");
      const source = await revisionFacts(lead.workspacePath, "@");
      await freezeLead(lead.workspacePath, source.commitId);
      if (path === "continuation" || path === "shared-continuation") {
        jj(lead.workspacePath, ["new"]);
        await writeFile(join(lead.workspacePath, "follow-up.txt"), "first follow-up\n");
        jj(lead.workspacePath, ["describe", "-m", "First follow-up"]);
        jj(lead.workspacePath, ["new"]);
        await writeFile(join(lead.workspacePath, "next.txt"), "second follow-up\n");
        jj(lead.workspacePath, ["describe", "-m", "Second follow-up"]);
      }
      const dependentBase = path === "shared-continuation" ? (await revisionFacts(lead.workspacePath, "@")).commitId : source.commitId;
      const dependent = path === "shared-source" || path === "shared-review-sweep" || path === "shared-continuation" ? await createWorkspace("based on published source", f.repo, { base: dependentBase }) : null;
      // The runner flattens the source onto integration, with different commit identities.
      // Reproduce the client's post-publication transition without needing a listening runner.
      jj(f.repo, ["new", "main"]);
      jj(f.repo, ["restore", "--from", source.commitId]);
      jj(f.repo, ["describe", "-m", "Published flattened artifact"]);
      const published = await revisionFacts(f.repo, "@");
      jj(f.repo, ["bookmark", "set", "main", "-r", published.commitId]);
      jj(f.repo, ["new", "main"]);
      jj(f.repo, ["git", "push", "--bookmark", "main"]);
      await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), {
        version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath,
        integrationRoot: f.repo, integrationBranch: "main", artifactCommitId: published.commitId, operationId: "fixture",
      });
      const lines: string[] = [];
      await dropSupersededCandidate(lead.workspacePath, lead.workspacePath, source, published.commitId, (line) => lines.push(line));
      if (path === "shared-continuation") assert.match(lines.join("\n"), /follow-up work shared/);
      else assert.deepEqual(lines, []);
      assert.equal((await revisionFacts(helper.workspacePath, "@", { ignoreWorkingCopy: true })).commitId, revision,
        "post-publication cleanup must not rebase a helper off its original lead base");
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      if (path === "shared-continuation") {
        assert.equal(jj(dependent!.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), dependentBase);
        assert.equal((await revisionFacts(lead.workspacePath, "@")).commitId, dependentBase, "shared follow-up work stays untouched");
        return;
      }
      if (path === "continuation") {
        assert.equal(await readFile(join(lead.workspacePath, "follow-up.txt"), "utf8"), "first follow-up\n");
        assert.equal(await readFile(join(lead.workspacePath, "next.txt"), "utf8"), "second follow-up\n");
        const parents = jj(lead.workspacePath, ["log", "-r", `::@ & ${published.commitId}`, "--no-graph", "-T", "commit_id"]);
        assert.equal(parents, published.commitId, "both follow-ups are now on the published artifact");
        return;
      }
      if (dependent) {
        assert.equal(jj(dependent.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), source.commitId);
        assert.equal(await workspaceCoverage((await workspaceContext(dependent.workspacePath))!, dependent.current.name), "source-covered");
        if (path === "shared-source") await runCli(f.repo, "remove", dependent.workspacePath);
      }
      await removeWorkspace(f.repo, lead.current.name, { retainMaterial: true });
      assert.equal((await planDisposableWorkspaces(f.repo, { emptyIdleMs: 0 })).find((item) => item.name === helper.current.name)!.action, "remove");
      if (path === "remove" || path === "shared-source") await runCli(f.repo, "remove", helper.workspacePath);
      if (path === "prune") await runCli(f.repo, "prune", "--empty");
      if (path === "sweep" || path === "shared-review-sweep") await sweepDisposableWorkspaces(f.repo, { pruneState: false, issueClosed: () => false });
      if (path === "shared-review-sweep") assert.equal(existsSync(dependent!.workspacePath), false);
      if (path === "new-work") {
        jj(helper.workspacePath, ["workspace", "update-stale"]);
        jj(helper.workspacePath, ["new"]);
        await writeFile(join(helper.workspacePath, "new.txt"), "unadopted follow-up\n");
        jj(helper.workspacePath, ["describe", "-m", "Helper follow-up"]);
        assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "uncovered");
        await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
      } else assert.equal(existsSync(helper.workspacePath), false);
    } finally { await f.dispose(); }
  });
}
