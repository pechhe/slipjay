import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { acquirePrimaryWriter, activePrimaryWriter, assertNoForeignPrimaryWriter, primaryWriterName, releasePrimaryWriter } from "../src/lib/primary-checkout-writer.ts";
import { lockHome } from "../src/lib/workspace-paths.ts";

test("Direct checkout protection still admits one writer and serialises with integration", async () => {
  const root = await mkdtemp(join(tmpdir(), "peach-primary-writer-"));
  const repo = join(root, "repo"), other = join(root, "other");
  await mkdir(repo); await mkdir(other);
  try {
    assert.notEqual(await primaryWriterName(repo), await primaryWriterName(other));
    const release = await acquirePrimaryWriter({ integrationRoot: repo, integrationBranch: "main", owner: "thread:a", surface: "peach" });
    await acquirePrimaryWriter({ integrationRoot: repo, integrationBranch: "main", owner: "thread:a", surface: "peach" });
    await assert.rejects(acquirePrimaryWriter({ integrationRoot: repo, integrationBranch: "main", owner: "thread:b", surface: "peach" }), /already being written/);
    await acquirePrimaryWriter({ integrationRoot: other, integrationBranch: "main", owner: "thread:b", surface: "peach" });
    await assert.rejects(assertNoForeignPrimaryWriter(repo), /being written by Direct/);
    await assertNoForeignPrimaryWriter(repo, "thread:a");
    await releasePrimaryWriter(repo, "thread:b");
    assert.equal((await activePrimaryWriter(repo))?.owner, "thread:a");
    await release();
    assert.equal(await activePrimaryWriter(repo), null);
    await assertNoForeignPrimaryWriter(repo);
    const stale = join(lockHome(), `${await primaryWriterName(repo)}.json`);
    await writeFile(stale, JSON.stringify({ version: 1, pid: 2_147_483_646, owner: "thread:dead", surface: "local" }));
    await acquirePrimaryWriter({ integrationRoot: repo, integrationBranch: "main", owner: "thread:c", surface: "local" });
    assert.equal((await activePrimaryWriter(repo))?.owner, "thread:c");
  } finally {
    await releasePrimaryWriter(repo, "thread:c");
    await releasePrimaryWriter(repo, "thread:a");
    await releasePrimaryWriter(other, "thread:b");
    await rm(root, { recursive: true, force: true });
  }
});
