import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { repairFailedLanding } from "../../src/lib/landing/repair-workspace.ts";
import { landThroughRunner, manageRepairClaim } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { listWorkspaces } from "../../src/lib/workspace/workspace-state.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";

const failing = () => 'if (!require("node:fs").existsSync("fixed.txt")) { console.error("Error: correction required with s3cr3t-fixture-value"); process.exit(1); }';

async function failedLanding(f: Awaited<ReturnType<typeof project>>, location: string, env: NodeJS.ProcessEnv, name: string) {
  const author = await createWorkspace(`original author ${name}`, f.repo);
  await writeFile(join(author.workspacePath, "candidate.txt"), "failed source\n");
  jj(author.workspacePath, ["describe", "-m", "Candidate needing repair"]);
  const original = await landThroughRunner(author.workspacePath, { location, env, onLine: () => {} });
  assert.equal(original.ok, false);
  await rm(author.workspacePath, { recursive: true, force: true });
  return { operationId: original.operation.id, clone: clone(f, name) };
}

function clone(f: Awaited<ReturnType<typeof project>>, name: string) {
  const path = join(f.root, `${name}-repository`);
  jj(f.root, ["git", "clone", f.remote, path]);
  jj(path, ["git", "remote", "set-url", "origin", "https://github.com/fixture/project.git"]);
  return path;
}

const changeOf = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);

test("repair resumes an interrupted claim and refuses competing clones before allocation", async () => {
  const f = await project({ verify: failing });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      // Interrupted repair after allocation and accepted claim resumes that workspace and claim.
      const interrupted = await failedLanding(f, location, env, "interrupted");
      const workspace = await createWorkspace(`Repair ${interrupted.operationId}`, interrupted.clone);
      const claimed = await manageRepairClaim(workspace.workspacePath, location, interrupted.operationId, "claim", env) as { claim: { claimId: string } };
      const resumed = await repairFailedLanding(interrupted.clone, interrupted.operationId, { location, env });
      assert.deepEqual([resumed.resumed, resumed.workspacePath, resumed.claimId], [true, workspace.workspacePath, claimed.claim.claimId]);
      assert.equal(existsSync(resumed.briefPath), true);
      assert.equal(changeOf(resumed.workspacePath), resumed.changeId);

      // Claim race between two clones leaves the loser no workspace, and a third clone is refused before allocation.
      const raced = await failedLanding(f, location, env, "first");
      const second = clone(f, "second");
      const results = await Promise.allSettled([repairFailedLanding(raced.clone, raced.operationId, { location, env }), repairFailedLanding(second, raced.operationId, { location, env })]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      const loser = results.findIndex((result) => result.status === "rejected");
      const loserRoot = [raced.clone, second][loser]!;
      assert.match(String((results[loser] as PromiseRejectedResult).reason), /already being repaired|Another repair claimant|changed during admission/);
      assert.deepEqual((await listWorkspaces(loserRoot)).map((w) => w.name), ["default"], "the losing clone keeps no repair workspace");

      const third = clone(f, "third");
      await assert.rejects(repairFailedLanding(third, raced.operationId, { location, env }), /Not repairable: .*already being repaired/);
      assert.deepEqual((await listWorkspaces(third)).map((w) => w.name), ["default"]);
    });
  } finally { await f.dispose(); }
}, 300_000);
