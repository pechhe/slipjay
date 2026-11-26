import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { landThroughRunner, readLandingHandoff } from "../../src/lib/runner/runner-client.ts";
import { project } from "../support/workspace-project.ts";
import { waitForExit, withTestRunner } from "../support/test-runner.ts";
import { occupy } from "./fixtures/workspace-sweep-fixture.ts";
import { isolateAdoptionFixtures, runCli, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

// End-to-end runner proof that published adoption handoff & archive survive lead retirement;
// the full cleanup-path matrix (remove, prune, sweep, new-work, continuations) lives in workspace-adopt-publication.test.ts.
test("published adoption survives lead retirement: remove", async () => {
  const f = await project({ policy: { spares: 0 } });
  let release = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    await attachWorkspaceIssue(helper.workspacePath, 123);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    await writeFile(join(lead.workspacePath, "helper.txt"), "helper reworked by lead\n");
    // A real helper process keeps it through the lead's post-publication sweep.
    release = occupy(helper.workspacePath);
    await withTestRunner(f, async ({ location, env }) => {
      const result = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(result.ok, true);
      const handoff = await readLandingHandoff(location, result.operation!.id, env) as { handoff: { evidence: { helpers: unknown[] } } };
      assert.deepEqual(handoff.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
      if (result.housekeeping?.pid) await waitForExit(result.housekeeping.pid);
    });
    await cleanupLandedWorkspace(lead.workspacePath);
    assert.equal(existsSync(lead.workspacePath), false);
    release();
    await runCli(f.repo, "remove", helper.workspacePath);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); await f.dispose(); }
}, 180_000);
