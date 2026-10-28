import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test, vi } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { archiveWorkspace } from "../../src/lib/workspace/workspace-archive.ts";
import { releaseWorkspace, retirementResultPath } from "../../src/lib/workspace/workspace-release.ts";
import * as state from "../../src/lib/workspace/workspace-state.ts";
import * as transactions from "../../src/lib/infra/workspace-transaction.ts";

vi.mock("../../src/lib/workspace/workspace-state.ts", { spy: true });
vi.mock("../../src/lib/infra/workspace-transaction.ts", { spy: true });

const actualTransactions = await vi.importActual<typeof transactions>("../../src/lib/infra/workspace-transaction.ts");
const actualState = await vi.importActual<typeof state>("../../src/lib/workspace/workspace-state.ts");
const barrier = () => {
  let opened = false;
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return {
    promise,
    open: () => { opened = true; resolve(); },
    wait: () => vi.waitFor(() => assert.ok(opened, "the operation reached its barrier"), { timeout: 10_000 }),
  };
};

async function interruptedRelease() {
  const f = await project();
  const missing = await createWorkspace("release-rename-missing", f.repo);
  const archived = await archiveWorkspace(missing.workspacePath, { reason: "interrupted" });
  assert.ok("archive" in archived);
  const operationId = `rename-${missing.current.name}`;
  await mkdir(dirname(retirementResultPath(operationId)), { recursive: true });
  await writeFile(retirementResultPath(operationId), JSON.stringify({
    state: "retiring", operationId, workspacePath: missing.workspacePath,
    workspaceName: missing.current.name, archiveId: archived.archive.id, commitId: archived.archive.commitId,
    at: new Date().toISOString(),
  }));
  jj(f.repo, ["workspace", "forget", missing.current.name]);
  await rm(missing.workspacePath, { recursive: true, force: true });
  const live = await createWorkspace("release-rename-live", f.repo);
  const sidecars = [state.lockPath(live.current.name), ...state.landingStatePaths(live.current.name)];
  for (const path of sidecars) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ workspaceName: live.current.name, marker: path }));
  }
  const workspaces = await state.listWorkspaces(f.repo);
  const rename = () => state.renameListedWorkspace(live.current, workspaces, missing.current.name);
  const replay = () => releaseWorkspace(missing.workspacePath, { operationId });
  const assertPreserved = async () => {
    assert.equal((await state.workspaceMetadata(missing.current.name))?.workspacePath, live.workspacePath);
    const moved = [state.lockPath(missing.current.name), ...state.landingStatePaths(missing.current.name)];
    for (const [index, path] of moved.entries()) {
      const record = JSON.parse(await readFile(path, "utf8"));
      assert.equal(record.workspaceName, missing.current.name);
      assert.equal(record.marker, sidecars[index]);
    }
  };
  return { f, missing, rename, replay, assertPreserved };
}

test("a rename waits through reconciliation's record check and sidecar removals", async () => {
  const fixture = await interruptedRelease();
  const checked = barrier();
  const proceed = barrier();
  const renameAttempted = barrier();
  const key = `writer:${fixture.missing.current.name}`;
  let attempts = 0;
  let entries = 0;
  const pending: Promise<unknown>[] = [];
  vi.mocked(transactions.withWorkspaceTransaction).mockImplementation((transactionKey, operation, options) => {
    if (transactionKey === key && ++attempts === 2) renameAttempted.open();
    return actualTransactions.withWorkspaceTransaction(transactionKey, async () => {
      if (transactionKey === key) entries += 1;
      return operation();
    }, options);
  });
  vi.mocked(state.workspaceMetadata).mockImplementation(async (name) => {
    const metadata = await actualState.workspaceMetadata(name);
    if (name === fixture.missing.current.name && attempts === 1) {
      checked.open();
      await proceed.promise;
    }
    return metadata;
  });
  try {
    const releasing = fixture.replay();
    pending.push(releasing);
    await checked.wait();
    // This is the record-check/removal window: the real writer key must be held.
    await assert.rejects(actualTransactions.withWorkspaceTransaction(key, async () => {}, { wait: false }), { code: "ELOCKED" });
    const renaming = fixture.rename();
    pending.push(renaming);
    await renameAttempted.wait();
    assert.equal(entries, 1, "rename has not entered the reconciliation's writer section");
    proceed.open();
    assert.equal((await releasing).state, "retired", "reconciliation finished before the name was reused");
    await renaming;
    assert.equal(entries, 2);
    await fixture.assertPreserved();
  } finally {
    proceed.open();
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
    await fixture.f.dispose();
  }
});

test("a rename winning the writer key keeps all sidecars and makes the replay uncertain", async () => {
  const fixture = await interruptedRelease();
  const renaming = barrier();
  const proceed = barrier();
  const replayAttempted = barrier();
  const key = `writer:${fixture.missing.current.name}`;
  let attempts = 0;
  const pending: Promise<unknown>[] = [];
  vi.mocked(transactions.withWorkspaceTransaction).mockImplementation((transactionKey, operation, options) => {
    const attempt = transactionKey === key ? ++attempts : 0;
    if (attempt === 2) replayAttempted.open();
    return actualTransactions.withWorkspaceTransaction(transactionKey, async () => {
      if (attempt === 1) {
        renaming.open();
        await proceed.promise;
      }
      return operation();
    }, options);
  });
  try {
    const renamed = fixture.rename();
    pending.push(renamed);
    await renaming.wait();
    const releasing = fixture.replay();
    pending.push(releasing);
    await replayAttempted.wait();
    proceed.open();
    await renamed;
    const result = await releasing;
    assert.equal(result.state, "uncertain", JSON.stringify(result));
    assert.ok("reason" in result);
    assert.match(result.reason, /now belongs to/);
    await fixture.assertPreserved();
    assert.equal((await fixture.replay()).state, "uncertain", "subsequent replays also preserve the reused name");
    await fixture.assertPreserved();
  } finally {
    proceed.open();
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
    await fixture.f.dispose();
  }
});
