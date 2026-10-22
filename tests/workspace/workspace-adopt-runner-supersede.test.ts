import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { readLandingHandoff } from "../../src/lib/runner/runner-client.ts";
import { controlRunner, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { frozenAdoptions, workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { project } from "../support/workspace-project.ts";
import { waitForExit, withTestRunner } from "../support/test-runner.ts";
import type { Operation } from "../../src/lib/runner/runner-contract.ts";
import { occupy } from "./fixtures/workspace-sweep-fixture.ts";
import { isolateAdoptionFixtures, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

for (const lostResponse of [false, true]) {
  test(`a real queued landing is superseded by the reland that publishes its adoption${lostResponse ? " after a lost response" : ""}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    let release = () => {};
    try {
      const { lead, helper, revision, base } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      release = occupy(helper.workspacePath);
      await withTestRunner(f, async ({ location, env }) => {
        assert.equal((await controlRunner(location, "pause", env)).ok, true);
        const abort = new AbortController();
        let firstId = "";
        await assert.rejects(landThroughRunner(lead.workspacePath, { location, env, signal: abort.signal,
          onOperation: (id) => { firstId = id; abort.abort(); } }));
        assert.ok(firstId);
        await writeFile(join(lead.workspacePath, "later.txt"), "superseding candidate\n");
        let nextId = "";
        let observedFreeze = false;
        const fetch = globalThis.fetch;
        const observing = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          if (String(input) === `${location}/v1/operations` && init?.method === "POST") {
            const records = Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions));
            assert.equal(records.filter((record) => record.adoptions.length).length, 2, "both copies are durable before the superseding POST");
            observedFreeze = true;
          }
          const response = await fetch(input, init);
          if (lostResponse && String(input) === `${location}/v1/operations` && init?.method === "POST") {
            await response.arrayBuffer();
            return new Response("lost superseding response body");
          }
          return response;
        });
        let publishing: ReturnType<typeof landThroughRunner> | undefined;
        let published: Awaited<ReturnType<typeof landThroughRunner>> | undefined;
        try {
          if (lostResponse) {
            await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }), /outcome is unknown/);
            assert.equal(Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions))
              .filter((record) => record.adoptions.length).length, 2, "both copies survive a lost acknowledgement");
          }
          publishing = landThroughRunner(lead.workspacePath, { location, env, onOperation: (id) => { nextId = id; } });
          void publishing.catch(() => {});
          await vi.waitFor(() => assert.ok(nextId), { timeout: 30_000 });
          assert.equal(observedFreeze, true);
          const response = await fetch(`${location}/v1/operations/${firstId}`, { headers: { authorization: `Bearer ${env.SLIPJAY_RUNNER_TOKEN}` } });
          const old = await response.json() as { operation: Operation };
          assert.deepEqual(old.operation.result, { type: "superseded", by: nextId });
          const records = Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions));
          assert.deepEqual(records.find((record) => record.operationId === firstId)!.adoptions, []);
          assert.deepEqual((await workspaceMetadata(lead.current.name))!.pendingLandingRequests, {});
        } finally {
          observing.mockRestore();
          await controlRunner(location, "resume", env);
          // Join the follower even when an assertion fails, before the runner
          // fixture drains workers and closes its service.
          if (publishing) published = await publishing;
        }
        assert.ok(published);
        assert.equal(published.ok, true);
        const retained = await readLandingHandoff(location, nextId, env) as { handoff: { evidence: { helpers: unknown[] } } };
        assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
        if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
      });
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      release();
      await removeWorkspace(f.repo, helper.current.name);
      assert.equal(existsSync(helper.workspacePath), false);
    } finally { release(); await f.dispose(); }
  }, 180_000);
}
