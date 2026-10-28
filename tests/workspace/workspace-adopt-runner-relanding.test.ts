import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { readLandingHandoff } from "../../src/lib/runner/runner-client.ts";
import { controlRunner, LandingNotSubmitted, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { frozenAdoptions, workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { waitForExit, withTestRunner } from "../support/test-runner.ts";
import { drainFixtureWorkers } from "../support/fixture-workers.ts";
import { occupy } from "./fixtures/workspace-sweep-fixture.ts";
import { isolateAdoptionFixtures, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

test("a failed runner landing carries its adoption into the successful replacement", async () => {
  const f = await project({ policy: { spares: 0 }, verify: () => 'if (!require("node:fs").existsSync("fixed.txt")) process.exit(1)' });
  let release = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    release = occupy(helper.workspacePath);
    await withTestRunner(f, async ({ location, env }) => {
      const failed = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(failed.ok, false);
      // The failed attempt schedules the repository's housekeeping, which reads the workspace list in the
      // same repository; a concurrent listing can fail and leave no context. Join it before reading.
      await drainFixtureWorkers(f.root);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
      await writeFile(join(lead.workspacePath, "fixed.txt"), "verification fixed\n");
      const published = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(published.ok, true);
      assert.notEqual(published.operation!.id, failed.operation!.id);
      const retained = await readLandingHandoff(location, published.operation!.id, env) as { handoff: { evidence: { helpers: unknown[]; intent: string } } };
      assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
      assert.equal(retained.handoff.evidence.intent, "Adopt helper", "carried-only adoption uses the commit description");
      if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
    });
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
    release();
    await removeWorkspace(f.repo, helper.current.name);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); await f.dispose(); }
}, 180_000);

test("a real 422 refusal releases its pending request and a new candidate publishes the adoption", async () => {
  const f = await project({ policy: { spares: 0 } });
  let release = () => {};
  let releaseLead = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    release = occupy(helper.workspacePath);
    releaseLead = occupy(lead.workspacePath);
    await writeFile(join(lead.workspacePath, "README.md"), "lead version\n");
    // Publish a conflicting change without going through the runner being tested.
    await writeFile(join(f.repo, "README.md"), "upstream version\n");
    jj(f.repo, ["describe", "-m", "Upstream README"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    jj(f.repo, ["git", "push", "--bookmark", "main"]);
    jj(f.repo, ["new", "main"]);
    await withTestRunner(f, async ({ location, env }) => {
      await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }),
        (error) => error instanceof LandingNotSubmitted && /conflict/i.test(error.message));
      const refused = (await workspaceMetadata(lead.current.name))!;
      assert.deepEqual(refused.pendingLandingRequests, {});
      const firstKey = Object.keys(frozenAdoptions(refused.landingAdoptions))[0]!;
      assert.equal(frozenAdoptions(refused.landingAdoptions)[firstKey]!.adoptions.length, 1);
      // Back out only the conflicting lead edit; the helper stays in the candidate.
      await writeFile(join(lead.workspacePath, "README.md"), "fixture\n");
      const published = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(published.ok, true);
      const retained = await readLandingHandoff(location, published.operation.id, env) as { handoff: { evidence: { helpers: unknown[] } } };
      assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
      const after = (await workspaceMetadata(lead.current.name))!;
      assert.equal(Object.keys(frozenAdoptions(after.landingAdoptions)).length, 2, "reland used a new source key");
      assert.deepEqual(frozenAdoptions(after.landingAdoptions)[firstKey]!.adoptions, []);
      assert.deepEqual(after.pendingLandingRequests, {});
      if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
    });
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
    release();
    await removeWorkspace(f.repo, helper.current.name);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); releaseLead(); await f.dispose(); }
}, 180_000);

test("a lost real submission response keeps its pending identity and adoption evidence", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    await withTestRunner(f, async ({ location, env }) => {
      await controlRunner(location, "pause", env);
      const fetch = globalThis.fetch;
      const losing = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const response = await fetch(input, init);
        if (String(input) === `${location}/v1/operations` && init?.method === "POST") {
          assert.equal(response.ok, true, "runner accepted the real request before its response was lost");
          await response.arrayBuffer();
          return new Response("lost response body");
        }
        return response;
      });
      try { await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }), /outcome is unknown/); }
      finally { losing.mockRestore(); }
      const metadata = (await workspaceMetadata(lead.current.name))!;
      assert.equal(Object.keys(metadata.pendingLandingRequests as object).length, 1);
      const records = Object.values(frozenAdoptions(metadata.landingAdoptions));
      assert.deepEqual(records.flatMap((record) => record.adoptions.flatMap((item) => item.revisions)), [revision]);
      assert.equal(records[0]!.operationId, undefined, "unacknowledged acceptance stays unresolved");
      await drainFixtureWorkers(f.root);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    });
  } finally { await f.dispose(); }
}, 180_000);
