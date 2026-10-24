import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readReleaseResult, releaseWorkspace, stillArchivedState } from "../../src/lib/workspace/workspace-release.ts";
import { restoreArchive } from "../../src/lib/workspace/workspace-archive.ts";

async function checkoutWithWork(f: Awaited<ReturnType<typeof project>>, task: string) {
  const created = await createWorkspace(task, f.repo);
  const root = created.workspacePath;
  const name = created.current.name;
  await writeFile(join(root, ".gitignore"), ".env\n");
  await writeFile(join(root, "notes.md"), `${task}\n`);
  await writeFile(join(root, ".env"), "TOKEN=keep\n");
  return { root, name };
}

test("releasing archives the checkout, retires it, and restores its ignored files", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-happy");

  const result = await releaseWorkspace(workspace.root, { operationId: "op-happy" });

  assert.equal(result.state, "retired", JSON.stringify(result));
  assert.equal(existsSync(workspace.root), false, "the checkout is gone");
  const recorded = await readReleaseResult("op-happy");
  assert.deepEqual(recorded, result, "the result is durable and answers a replay");

  const restored = await restoreArchive((result as { archiveId: string }).archiveId, { name: "release-happy-restored" });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
  assert.equal(await readFile(join(restored.workspacePath, ".env"), "utf8"), "TOKEN=keep\n");
  assert.equal(await readFile(join(restored.workspacePath, "notes.md"), "utf8"), "release-happy\n");
});

test("replaying an operation id answers the recorded result instead of releasing again", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-replay");
  const first = await releaseWorkspace(workspace.root, { operationId: "op-replay" });
  assert.equal(first.state, "retired");

  const second = await releaseWorkspace(workspace.root, { operationId: "op-replay" });

  assert.deepEqual(second, first, "the same id answers the same result, even though the path is gone");
});

test("a checkout a live process holds is refused and stays", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-held");
  const processes = [{ pid: process.pid, cwd: workspace.root, command: "bun test" }];

  const result = await releaseWorkspace(workspace.root, { operationId: "op-held", processes });

  assert.equal(result.state, "refused", JSON.stringify(result));
  assert.match((result as { reason: string }).reason, /in use by a live process/);
  assert.equal(existsSync(workspace.root), true, "a held checkout is never released");
  assert.equal(existsSync(join(workspace.root, ".env")), true, "and keeps its ignored files");
});

test("an operation id that is not a plain name is refused before anything happens", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-badid");

  for (const operationId of ["../config", "a/b", "--operation", "", ".."]) {
    const result = await releaseWorkspace(workspace.root, { operationId });
    assert.equal(result.state, "refused", `${operationId} must be refused`);
  }
  assert.equal(existsSync(workspace.root), true);
});

test("an archive and a checkout that disagree on the commit, the names or the bytes are not the same state", () => {
  const archive = { commitId: "a".repeat(40), inventory: [".env", "notes.md"], inventoryDigests: { ".env": "h1", "notes.md": "h2" } };
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: ["notes.md", ".env"] }), true, "order does not matter");
  assert.equal(stillArchivedState(archive, { commitId: "b".repeat(40), inventory: [".env", "notes.md"] }), false, "a moved commit is not covered");
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env"] }), false, "a lost ignored file is not covered");
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env", "notes.md", "new.txt"] }), false, "a gained file is not covered");
  assert.equal(
    stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env", "notes.md"], inventoryDigests: { ".env": "rewritten", "notes.md": "h2" } }),
    false,
    "a rewritten ignored file is not covered",
  );
});

test("a teardown that writes an ignored file refuses the release and keeps the checkout", async () => {
  // The teardown runs inside retirement, after the archive was made: what it writes is not
  // in that archive, so the release must refuse rather than delete what it never kept.
  const f = await project({
    policy: {
      workspaceTeardown: {
        executable: "node",
        args: ["-e", "require('node:fs').appendFileSync('.env', 'written-by-teardown\\n')"],
      },
    },
  });
  const workspace = await checkoutWithWork(f, "release-teardown");

  const result = await releaseWorkspace(workspace.root, { operationId: "op-teardown" });

  assert.equal(result.state, "refused", JSON.stringify(result));
  assert.match((result as { reason: string }).reason, /changed/);
  assert.equal(existsSync(workspace.root), true, "the checkout stays");
  assert.match(await readFile(join(workspace.root, ".env"), "utf8"), /written-by-teardown/, "with the file the teardown wrote");
});
