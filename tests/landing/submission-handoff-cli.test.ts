import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readLandingHandoff } from "../../src/lib/runner/runner-client.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
test("actual CLI submits bounded author handoff and retrieves it without the file or transcript", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("handoff fixture", f.repo);
    const cwd = workspace.workspacePath;
    await writeFile(join(cwd, "candidate.txt"), "recoverable source\n");
    jj(cwd, ["describe", "-m", "Retain handoff fixture"]);
    const source = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const file = join(f.root, "handoff.json");
    await writeFile(file, JSON.stringify({ version: 1, source, intent: "Reproduce after author loss", scope: ["candidate.txt"], spec: null,
      helpers: [], checks: [{ revision: source, command: "true", result: "not-run", detail: "Fixture only" }], reviews: [], toolchain: [], gaps: ["APP_SECRET=fixture-secret"] }));
    // Retain the author workspace while checking the CLI result, as an attached author would.
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore", detached: true });
    try {
      await withTestRunner(f, async ({ env, location }) => {
        const { stdout } = await promisify(execFile)("bun", [cli, "land", "--handoff", file], { cwd, env, timeout: 90000 });
        const result = JSON.parse(stdout);
        assert.equal(result.ok, true);
        const id = result.outcome.operationId;
        const manifest = await readLandingHandoff(location, id, env) as { handoff: { authority: string; evidence: { source: string; checks: { result: string }[] } } };
        assert.equal(manifest.handoff.authority, "author-reported");
        assert.equal(manifest.handoff.evidence.source, source);
        assert.equal(manifest.handoff.evidence.checks[0]!.result, "not-run");
        assert.equal(JSON.stringify(manifest).includes("fixture-secret"), false);
        await writeFile(file, "author file no longer exists as evidence");
        const read = await promisify(execFile)("bun", [cli, "runner", "handoff", id], { cwd, env, timeout: 20000 });
        assert.deepEqual(JSON.parse(read.stdout), manifest);
        assert.equal(read.stderr, "");
        assert.equal((await fetch(`${location}/v1/operations/${id}/handoff`)).status, 401);
        assert.equal(f.remoteFile("candidate.txt"), "recoverable source\n");
      });
    } finally { holder.kill(); }
  } finally { await f.dispose(); }
}, 120000);
