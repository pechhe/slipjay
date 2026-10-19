import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readLandingState } from "../../src/lib/workspace/workspace-state.ts";
import type { PrimaryCheckoutOutcome } from "../../src/lib/landing/landing-candidate.ts";

// An Isolated landing integrates and pushes whatever the primary checkout holds, and
// moves that checkout onto integrated ancestry, carrying uncommitted edits that apply cleanly.

type Fixture = Awaited<ReturnType<typeof project>>;
const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const status = (cwd: string) => new Promise<Record<string, unknown>>((resolveStatus, reject) =>
  execFile("bun", [cli, "status"], { cwd }, (error, stdout) => error ? reject(error) : resolveStatus(JSON.parse(stdout))));

const primary = (f: Fixture) => ({
  change: jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]),
  parent: jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]),
  conflict: jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "conflict"]) === "true",
});

async function land(f: Fixture, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Kept, so its landing record (where the primary checkout outcome lives) stays readable.
  const landed = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(landed.ok, true, landed.lines.join("\n"));
  assert.equal(f.remoteFile(file), `${file}\n`);
  const result = (await readLandingState(workspace.current.name, { readOnly: true }))! as { artifactCommitId: string; cleanupPending?: boolean; primaryCheckout?: PrimaryCheckoutOutcome };
  return { workspace, result };
}

test("an empty primary checkout moves onto the new integration", async () => {
  const f = await project();
  try {
    const { workspace, result } = await land(f, "empty.txt");
    assert.deepEqual(result.primaryCheckout, { action: "moved" });
    assert.equal(primary(f).parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
    assert.deepEqual((await status(workspace.workspacePath)).landing, {
      phase: "landed", artifactCommitId: result.artifactCommitId, primaryCheckout: { action: "moved" } });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("uncommitted primary edits are carried onto the new integration unchanged", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "local.txt"), "unlanded\n");
    const before = primary(f);
    await land(f, "first.txt");
    const { result } = await land(f, "second.txt");
    assert.deepEqual(result.primaryCheckout, { action: "moved", reason: "carried-edits" });
    const after = primary(f);
    assert.equal(after.change, before.change);
    assert.equal(after.parent, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
    assert.equal(after.conflict, false);
    assert.equal(await readFile(join(f.repo, "local.txt"), "utf8"), "unlanded\n");
    assert.equal(await readFile(join(f.repo, "second.txt"), "utf8"), "second.txt\n");
    assert.match(jj(f.repo, ["diff", "-r", "@", "--name-only"]), /^local\.txt$/m);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("uncommitted primary edits that would conflict with the landing stay exactly where they are", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "clash.txt"), "local\n");
    const before = primary(f);
    const { result } = await land(f, "clash.txt");
    assert.equal(result.primaryCheckout?.action, "left");
    assert.equal(result.primaryCheckout?.reason, "edits-conflict");
    assert.match(result.primaryCheckout?.warning ?? "", /conflict/);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(primary(f), before);
    assert.equal(await readFile(join(f.repo, "clash.txt"), "utf8"), "local\n");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a conflicted primary checkout is reported as a warning and left for its owner", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "README.md"), "a\n");
    jj(f.repo, ["commit", "-m", "a"]);
    const a = jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "change_id"]);
    jj(f.repo, ["new", "main"]);
    await writeFile(join(f.repo, "README.md"), "b\n");
    jj(f.repo, ["rebase", "-r", "@", "--onto", a]);
    const before = primary(f);
    assert.equal(before.conflict, true);

    const { result } = await land(f, "conflict.txt");
    assert.equal(result.primaryCheckout?.action, "left");
    assert.match(result.primaryCheckout?.warning ?? "", /conflicts/);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(primary(f), before);
  } finally {
    await f.dispose();
  }
}, 120_000);
