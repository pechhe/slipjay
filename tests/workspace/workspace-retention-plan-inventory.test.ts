import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { stateHome } from "../../src/lib/workspace/workspace-paths.ts";
import { lockPath, metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { later, byName, landed } from "./fixtures/workspace-retention-plan-fixture.ts";
import { occupy } from "./fixtures/workspace-sweep-fixture.ts";

async function fingerprint(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await stat(path).catch(() => null);
        found.push(`${path}\t${info?.size}\t${info?.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return found.sort();
}

test("the plan explains every workspace, changes nothing, and the sweep then does what it planned", async () => {
  const f = await project({ ignore: "notes/\n" });
  const release: Array<() => void> = [];
  try {
    const delivered = await landed(f, "delivered.txt");
    const idle = await createWorkspace("idle", f.repo);
    const occupied = await createWorkspace("occupied", f.repo);
    const owned = await createWorkspace("owned", f.repo);
    const notes = await createWorkspace("notes", f.repo);
    const open = await createWorkspace("open", f.repo);
    const unknown = await createWorkspace("unknown", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    const corrupt = await createWorkspace("corrupt", f.repo);
    const owing = await createWorkspace("owing", f.repo);
    await attachWorkspaceIssue(open.workspacePath, 41);
    await attachWorkspaceIssue(unknown.workspacePath, 42);
    await provisionSpare(f.repo);
    release.push(occupy(occupied.workspacePath));
    await mkdir(join(lockPath(owned.current.name), ".."), { recursive: true });
    await writeFile(lockPath(owned.current.name), JSON.stringify({ version: 1, pid: process.pid }));
    await mkdir(join(notes.workspacePath, "notes"));
    await writeFile(join(notes.workspacePath, "notes", "draft.md"), "mine\n");
    await writeFile(metadataPath(corrupt.current.name), "{ not json");
    await writeFile(metadataPath(owing.current.name), JSON.stringify({ ...await workspaceMetadata(owing.current.name), pendingRunnerFacts: [{ id: "pending" }] }));
    // An edit JJ has not snapshotted yet: only a snapshot would show it as work.
    await writeFile(join(edited.workspacePath, "README.md"), "edited\n");

    // Issue #42's tracker read fails outright: its state is unknown, not a sweep failure.
    const options = { now: later(), issueClosed: (_root: string, issue: number) => { if (issue === 41) return false; throw new Error("tracker down"); } };
    const roots = [stateHome(), join(f.repo, ".jj"), ...[delivered, idle, edited, notes].map((workspace) => join(workspace.workspacePath, ".jj"))];
    const before = await Promise.all(roots.map(fingerprint));
    const plan = await planDisposableWorkspaces(f.repo, options);
    assert.deepEqual(await Promise.all(roots.map(fingerprint)), before, "the plan writes no state, operation or working copy");

    const entries = byName(plan);
    const reason = (workspace: { current: { name: string } }) => entries[workspace.current.name]?.reason ?? "";
    assert.equal(entries.default?.action, "keep");
    assert.equal(entries.default?.state, "integration");
    assert.match(reason(occupied), /live process: pid \d+/);
    assert.ok(entries[occupied.current.name]?.holders?.length, "the plan names the live process");
    assert.match(reason(owned), /live process/);
    assert.match(reason(notes), /notes\/draft\.md/);
    assert.deepEqual(entries[notes.current.name]?.uniqueFiles, ["notes/draft.md"]);
    assert.match(reason(open), /issue #41 open/);
    assert.match(reason(unknown), /issue #42 state unknown/, "an unreadable Issue state is unknown, never a pass");
    assert.match(reason(edited), /edited since its last snapshot: README\.md/);
    assert.equal(reason(corrupt), "metadata unreadable", "unreadable metadata is unknown, never a pass");
    assert.match(reason(owing), /pending runner facts/, "the plan applies removal's own refusals");
    const spare = plan.find((entry) => entry.state === "spare");
    assert.equal(spare?.action, "keep");
    assert.equal(spare?.reason, "prepared spare");
    assert.equal(entries[idle.current.name]?.action, "remove");
    assert.equal(entries[delivered.current.name]?.action, "remove");
    assert.equal(entries[delivered.current.name]?.state, "landed");
    assert.deepEqual(entries[delivered.current.name]?.landing, { phase: "landed", published: true });
    assert.equal(entries[idle.current.name]?.landing, null);
    for (const entry of plan) {
      assert.equal(entry.repository, f.repo);
      assert.ok(entry.sizeBytes && entry.sizeBytes > 0, `${entry.name} has a size`);
    }

    const removals = plan.filter((entry) => entry.action === "remove").map((entry) => entry.name).sort();
    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.deepEqual([...swept.removed].sort(), removals, "the sweep removes exactly what the plan said it would");
    for (const kept of [occupied, owned, notes, open, unknown, edited, corrupt, owing]) assert.ok(existsSync(kept.workspacePath), kept.current.name);
  } finally {
    for (const dispose of release) dispose();
    await f.dispose();
  }
}, 240_000);
