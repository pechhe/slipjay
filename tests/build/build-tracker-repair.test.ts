import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { repairFailedLanding } from "../../src/lib/landing/repair-workspace.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { item, buildServer, SESSION } from "./fixtures/build-tracker-fixture.ts";

test("a Build landing's repair keeps its item, lands under the repairer's own session and never as a chore", async () => {
  const f = await project({ policy: { tracker: "build" },
    verify: () => 'if (!require("node:fs").existsSync("fixed.txt")) { console.error("Error: correction required"); process.exit(1); }' });
  const buildToken = "build-secret";
  const spec = item({ number: 96640, kind: "spec", status: "in_progress", bodyRevision: 2 });
  const ticket = item({ number: 96641, parentId: spec.id });
  const binds = { [spec.id]: [{ generation: 1, endedAt: null as string | null }] };
  const fake = await buildServer(buildToken, [spec, ticket], binds);
  const author = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96641 });
  try {
    await writeFile(join(author.workspacePath, "candidate.txt"), "failed source\n");
    await withTestRunner(f, async ({ location, env }) => {
      const failed = await landThroughRunner(author.workspacePath, { location, env, session: SESSION, onLine: () => {} });
      assert.equal(failed.ok, false);
      // Repaired from a fresh clone: the author's workspace still holds #96641 in its own repository.
      const cold = join(f.root, "cold-repository");
      jj(f.root, ["git", "clone", f.remote, cold]);
      jj(cold, ["git", "remote", "set-url", "origin", "https://github.com/fixture/project.git"]);
      for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.com"]]) jj(cold, ["config", "set", "--repo", key!, value!]);
      const setup = await repairFailedLanding(cold, failed.operation.id, { location, env });
      assert.equal(setup.issueNumber, 96641, "the repair workspace belongs to the failed landing's Ticket");
      await writeFile(join(setup.workspacePath, "fixed.txt"), "corrected\n");
      const land = (session?: string) => landThroughRunner(setup.workspacePath, { location, env: { ...env, HQ_FORGE_SESSION_ID: "", HQ_BUILD_SESSION_ID: "" }, session, onLine: () => {} });
      // Custody is the repairer's own: no session, or a Spec with no current lead, refuses before anything is submitted.
      await assert.rejects(land(), /needs your lead session for Spec #96640/);
      binds[spec.id] = [{ generation: 1, endedAt: "2026-10-17T00:00:00Z" }];
      await assert.rejects(land(SESSION), /has no current lead/);
      binds[spec.id] = [{ generation: 1, endedAt: "2026-10-17T00:00:00Z" }, { generation: 2, endedAt: null }];
      const admissions = fake.requests.length;
      const repaired = await land(SESSION);
      assert.equal(repaired.ok, true);
      const admission = fake.requests.slice(admissions).find((request) => request.action === "admitAttempt")!;
      assert.deepEqual([admission.input.specId, admission.input.ticketIds, admission.input.bindGeneration, admission.input.repairsOperationId],
        [spec.id, [ticket.id], 2, failed.operation.id]);
      assert.equal(fake.requests.slice(admissions).some((request) => request.action === "recordChoreLanding"), false, "never reported as a chore");
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    await rm(author.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 300_000);
