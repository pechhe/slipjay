import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { metadataPath } from "../../src/lib/workspace/workspace-state.ts";
import { EMPTY_IDLE_MS, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { occupy } from "./fixtures/workspace-housekeeping-fixture.ts";

const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

test("an empty workspace attached to a closed Issue is swept; open, unknown and worked-on ones are kept", async () => {
  const f = await project();
  const path = process.env.PATH;
  try {
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), '#!/bin/sh\ncase "$3" in 41|44|45) echo CLOSED;; 42) echo OPEN;; *) echo "gh: unavailable" >&2; exit 1;; esac\n');
    await chmod(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const closed = await createWorkspace("Issue #41", f.repo, { issueNumber: 41 });
    const open = await createWorkspace("Issue #42", f.repo, { issueNumber: 42 });
    const unknown = await createWorkspace("Issue #43", f.repo, { issueNumber: 43 });
    const worked = await createWorkspace("Issue #44", f.repo, { issueNumber: 44 });
    await writeFile(join(worked.workspacePath, "work.txt"), "work\n");

    const held = await createWorkspace("Issue #45", f.repo, { issueNumber: 45 });
    const holder = occupy(held.workspacePath);
    const fresh = await sweepDisposableWorkspaces(f.repo);
    assert.deepEqual(fresh.removed, [], "a just-allocated closed Issue's workspace survives the sweep its allocation triggers");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000 });
    holder.dispose();
    assert.deepEqual(swept.removed, [closed.current.name], "after the idle period, a closed Issue's empty workspace goes");
    assert.equal(existsSync(closed.workspacePath), false);
    assert.match(swept.skipped.find(({ name }) => name === held.current.name)?.reason ?? "", /live process/, "a closed Issue's workspace in use is kept");
    for (const kept of [open, unknown, worked, held]) assert.ok(existsSync(kept.workspacePath), kept.current.name);

    await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    const offline = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.deepEqual(offline.removed, [], "gh failing keeps everything");
  } finally {
    process.env.PATH = path;
    await f.dispose();
  }
}, 120_000);

test("resuming an Issue's workspace without a task still restarts its idle period", async () => {
  const f = await project();
  try {
    const first = await createWorkspace("Issue #47", f.repo, { issueNumber: 47 });
    const path = metadataPath(first.current.name);
    const old = new Date(Date.now() - 2 * EMPTY_IDLE_MS).toISOString();
    const aged = { ...JSON.parse(await readFile(path, "utf8")), updatedAt: old, attachedAt: old };
    await writeFile(path, JSON.stringify(aged));
    const resumed = await createWorkspace("", f.repo, { issueNumber: 47 });
    assert.equal(resumed.workspacePath, first.workspacePath);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    assert.ok(Date.parse(metadata.updatedAt) > Date.parse(old), "the resume records a fresh assignment time");
    assert.equal(metadata.task, "Issue #47", "an empty task keeps the recorded one");
  } finally { await f.dispose(); }
}, 120_000);
