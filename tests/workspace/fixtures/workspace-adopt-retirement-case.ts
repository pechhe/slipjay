import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adoptWorkspace } from "../../../src/lib/workspace/workspace-adopt.ts";
import { cleanupLandedWorkspace, removeWorkspace } from "../../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue } from "../../../src/lib/workspace/workspace-state.ts";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../../src/lib/workspace/workspace-sweep.ts";
import { landThroughRunner, readLandingHandoff } from "../../../src/lib/runner/runner-client.ts";
import { jj, project } from "../../support/workspace-project.ts";
import { waitForExit, withTestRunner } from "../../support/test-runner.ts";
import { occupy } from "./workspace-sweep-fixture.ts";
import { runCli, contribution } from "./workspace-adopt-fixture.ts";

// Each scenario lands and then retires the lead's workspace a different way, so
// each gets its own file so its duration is measured separately against the 30s target.
// Each file keeps an explicit test() so static tooling (vp test list) sees the case.
export type AdoptionRetirementPath = "remove" | "prune" | "sweep" | "new-work";

/** Run one post-publication retirement scenario; each test file isolates its fixtures first. */
export async function runAdoptionRetirementCase(path: AdoptionRetirementPath) {
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
    if (path === "remove") await runCli(f.repo, "remove", helper.workspacePath);
    if (path === "prune") await runCli(f.repo, "prune", "--empty");
    if (path === "sweep") {
      // Publication above is real. Only the subsequent sweep is under test here;
      // workspace-sweep-landing.test.ts covers a landing triggering that sweep.
      await sweepDisposableWorkspaces(f.repo);
    }
    if (path === "new-work") {
      jj(helper.workspacePath, ["workspace", "update-stale"]);
      jj(helper.workspacePath, ["new"]);
      await writeFile(join(helper.workspacePath, "new.txt"), "not adopted\n");
      jj(helper.workspacePath, ["describe", "-m", "New work"]);
      await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
      assert.equal((await planDisposableWorkspaces(f.repo, { emptyIdleMs: 0 })).find((item) => item.name === helper.current.name)!.action, "keep");
    } else assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); await f.dispose(); }
}
