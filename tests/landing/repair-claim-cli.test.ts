import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { importSourceBundle } from "../../src/lib/landing/submission-source-export.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
test("fresh isolated CLI claimant restores and repairs a failed candidate while the stale author is fenced", async () => {
  const f = await project({ verify: () => 'if (!require("node:fs").existsSync("fixed.txt")) { console.error("Error: correction required"); process.exit(1); }' });
  try {
    const author = await createWorkspace("original author", f.repo);
    await writeFile(join(author.workspacePath, "candidate.txt"), "failed source\n");
    jj(author.workspacePath, ["describe", "-m", "Candidate needing repair"]);
    await withTestRunner(f, async ({ env, location }) => {
      const original = await landThroughRunner(author.workspacePath, { location, env, onLine: () => {} });
      assert.equal(original.ok, false); assert.equal(original.operation.status, "failed");
      const source = original.operation.commitId, operationId = original.operation.id;
      const cold = join(f.root, "cold-repair-repository");
      jj(f.root, ["git", "clone", f.remote, cold]);
      jj(cold, ["git", "remote", "set-url", "origin", "https://github.com/fixture/project.git"]);
      jj(cold, ["config", "set", "--repo", "user.name", "Fixture"]);
      jj(cold, ["config", "set", "--repo", "user.email", "fixture@example.com"]);
      const repairer = await createWorkspace("fresh repairer", cold);
      const cwd = repairer.workspacePath;
      const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore", detached: true });
      try {
        const claimed = await promisify(execFile)("bun", [cli, "runner", "repair-claim", operationId], { cwd, env, timeout: 20000 });
        const view = JSON.parse(claimed.stdout);
        assert.equal(view.claim.source, source); assert.equal(claimed.stderr, "");
        assert.equal("token" in view.claim, false); assert.equal("tokenSha256" in view.claim, false);
        // A second CLI process reconciles the persisted capability, rather than creating a second owner.
        const again = await promisify(execFile)("bun", [cli, "runner", "repair-claim", operationId], { cwd, env, timeout: 20000 });
        assert.equal(JSON.parse(again.stdout).claim.claimId, view.claim.claimId);
        await writeFile(join(author.workspacePath, "stale.txt"), "must not be admitted\n");
        await assert.rejects(landThroughRunner(author.workspacePath, { location, env, onLine: () => {} }), /refused|ownership|claim/);
        const bundle = join(f.root, "repair.bundle");
        await promisify(execFile)("bun", [cli, "runner", "source", operationId, bundle], { cwd, env, timeout: 30000 });
        await importSourceBundle(bundle, cwd, operationId, source);
        jj(cwd, ["edit", source]);
        await writeFile(join(cwd, "fixed.txt"), "corrected\n");
        const proposed = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
        assert.notEqual(proposed, source);
        const repaired = await promisify(execFile)("bun", [cli, "land"], { cwd, env, timeout: 90000 });
        const result = JSON.parse(repaired.stdout);
        assert.equal(result.ok, true); assert.notEqual(result.outcome.operationId, operationId);
        assert.equal(f.remoteFile("fixed.txt"), "corrected\n");
        assert.equal(f.remoteFile("candidate.txt"), "failed source\n");
        const events = await (await fetch(`${location}/v1/metrics/events?since=0&limit=1000`, { headers: { authorization: "Bearer test-token" } })).json() as { events: { operationId: string; event: { type: string; operationId?: string } }[] };
        assert.ok(events.events.some((row) => row.operationId === result.outcome.operationId && row.event.type === "repair_proposed" && row.event.operationId === operationId));
        assert.equal(result.outcome.recovery.kind, "already-published");
        assert.equal((await readFile(join(author.workspacePath, "stale.txt"), "utf8")), "must not be admitted\n");
      } finally { holder.kill(); }
    });
  } finally { await f.dispose(); }
}, 120000);
