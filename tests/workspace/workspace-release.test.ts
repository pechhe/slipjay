import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readReleaseResult, releaseWorkspace, stillArchivedState } from "../../src/lib/workspace/workspace-release.ts";
import { archiveWorkspace, restoreArchive } from "../../src/lib/workspace/workspace-archive.ts";

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
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: ["notes.md", ".env"], inventoryDigests: { ".env": "h1", "notes.md": "h2" } }), true, "order does not matter");
  assert.equal(stillArchivedState(archive, { commitId: "b".repeat(40), inventory: [".env", "notes.md"], inventoryDigests: { ".env": "h1", "notes.md": "h2" } }), false, "a moved commit is not covered");
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env"], inventoryDigests: { ".env": "h1" } }), false, "a lost ignored file is not covered");
  assert.equal(stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env", "notes.md", "new.txt"], inventoryDigests: { ".env": "h1", "notes.md": "h2", "new.txt": "h3" } }), false, "a gained file is not covered");
  assert.equal(
    stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env", "notes.md"], inventoryDigests: { ".env": "rewritten", "notes.md": "h2" } }),
    false,
    "a rewritten ignored file is not covered",
  );
  assert.equal(
    stillArchivedState(archive, { commitId: "a".repeat(40), inventory: [".env", "notes.md"] }),
    false,
    "without digests there is no proof, so the state is not equal",
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

test("an interrupted retirement reconciles from its intent instead of being lost", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-interrupted");
  // The archive a crash would have left behind, and the intent written before the removal.
  const archived = await archiveWorkspace(workspace.root, { reason: "interrupted" });
  assert.ok("archive" in archived, JSON.stringify(archived));
  const { retirementResultPath } = await import("../../src/lib/workspace/workspace-release.ts");
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(dirname(retirementResultPath("op-interrupted")), { recursive: true });
  await write(retirementResultPath("op-interrupted"), JSON.stringify({
    state: "retiring", operationId: "op-interrupted", workspacePath: workspace.root,
    workspaceName: workspace.name, archiveId: archived.archive.id, commitId: archived.archive.commitId,
    at: new Date().toISOString(),
  }));
  // The removal happened; the result never did.
  await rm(workspace.root, { recursive: true, force: true });

  const result = await releaseWorkspace(workspace.root, { operationId: "op-interrupted" });

  assert.equal(result.state, "retired", JSON.stringify(result));
  assert.equal((result as { archiveId: string }).archiveId, archived.archive.id);
  const restored = await restoreArchive(archived.archive.id, { name: "release-interrupted-restored" });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
});

test("an intent whose checkout still exists acts on nothing and says to reconcile", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-pending");
  const { retirementResultPath } = await import("../../src/lib/workspace/workspace-release.ts");
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(dirname(retirementResultPath("op-pending")), { recursive: true });
  await write(retirementResultPath("op-pending"), JSON.stringify({
    state: "retiring", operationId: "op-pending", workspacePath: workspace.root,
    workspaceName: workspace.name, archiveId: "missing-archive", commitId: "0".repeat(40),
    at: new Date().toISOString(),
  }));

  const result = await releaseWorkspace(workspace.root, { operationId: "op-pending" });

  assert.equal(result.state, "uncertain", JSON.stringify(result));
  assert.equal(existsSync(workspace.root), true, "nothing is removed while an attempt is unresolved");
});

test("an operation id already naming another workspace is answered without overwriting its record", async () => {
  const f = await project();
  const first = await checkoutWithWork(f, "release-first");
  const other = await checkoutWithWork(f, "release-other");
  const retired = await releaseWorkspace(first.root, { operationId: "op-one" });
  assert.equal(retired.state, "retired");

  const second = await releaseWorkspace(other.root, { operationId: "op-one" });

  assert.equal(second.state, "refused");
  assert.match((second as { reason: string }).reason, /already names/);
  const stillRecorded = await readReleaseResult("op-one");
  assert.equal(stillRecorded?.state, "retired", "the first result stays authoritative");
  assert.equal(existsSync(other.root), true, "the other checkout is untouched");
});

test("a refused operation stays refused under its own id, even at the same path", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-refused-terminal");
  const processes = [{ pid: process.pid, cwd: workspace.root, command: "bun test" }];
  const first = await releaseWorkspace(workspace.root, { operationId: "op-terminal", processes });
  assert.equal(first.state, "refused");

  // The holder is gone, but the id named one attempt: replaying it must not release what is
  // there now — a new attempt is a new operation.
  const second = await releaseWorkspace(workspace.root, { operationId: "op-terminal" });

  assert.equal(second.state, "refused");
  assert.equal(existsSync(workspace.root), true, "the checkout is untouched by the replay");
  assert.deepEqual(await readReleaseResult("op-terminal"), first);
});

test("reconciling an interrupted retirement also clears the workspace's own record", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-reconcile-meta");
  const archived = await archiveWorkspace(workspace.root, { reason: "interrupted" });
  assert.ok("archive" in archived);
  const { retirementResultPath } = await import("../../src/lib/workspace/workspace-release.ts");
  const { metadataPath } = await import("../../src/lib/workspace/workspace-state.ts");
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(dirname(retirementResultPath("op-meta")), { recursive: true });
  await write(retirementResultPath("op-meta"), JSON.stringify({
    state: "retiring", operationId: "op-meta", workspacePath: workspace.root,
    workspaceName: workspace.name, archiveId: archived.archive.id, commitId: archived.archive.commitId,
    at: new Date().toISOString(),
  }));
  await rm(workspace.root, { recursive: true, force: true });

  const result = await releaseWorkspace(workspace.root, { operationId: "op-meta" });

  assert.equal(result.state, "retired", JSON.stringify(result));
  assert.equal(existsSync(metadataPath(workspace.name)), false, "the workspace record does not outlive the checkout");
});

test("a name reused by another checkout is never stripped by a stale replay", async () => {
  const f = await project();
  const workspace = await checkoutWithWork(f, "release-name-reuse");
  const archived = await archiveWorkspace(workspace.root, { reason: "crashed" });
  assert.ok("archive" in archived);
  const { retirementResultPath } = await import("../../src/lib/workspace/workspace-release.ts");
  const { metadataPath } = await import("../../src/lib/workspace/workspace-state.ts");
  const { mkdir, readFile: read, writeFile: write } = await import("node:fs/promises");
  await mkdir(dirname(retirementResultPath("op-reuse")), { recursive: true });
  await write(retirementResultPath("op-reuse"), JSON.stringify({
    state: "retiring", operationId: "op-reuse", workspacePath: workspace.root,
    workspaceName: workspace.name, archiveId: archived.archive.id, commitId: archived.archive.commitId,
    at: new Date().toISOString(),
  }));
  // The checkout goes, and the name is taken over by a different checkout.
  await rm(workspace.root, { recursive: true, force: true });
  const record = JSON.parse(await read(metadataPath(workspace.name), "utf8"));
  await write(metadataPath(workspace.name), JSON.stringify({ ...record, workspacePath: "/somewhere/else" }));

  const result = await releaseWorkspace(workspace.root, { operationId: "op-reuse" });

  assert.equal(result.state, "uncertain", JSON.stringify(result));
  assert.match((result as { reason: string }).reason, /now belongs to/);
  assert.equal(existsSync(metadataPath(workspace.name)), true, "the live workspace keeps its record");
});
