import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";

test("concurrent starts prepare their checkouts outside the allocation lock", async () => {
  const f = await project();
  try {
    // Each readiness waits until both are underway: serialized preparation would never get there.
    const entered: string[] = [];
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    const prepare = async (_root: string, path: string) => {
      entered.push(path);
      if (entered.length === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const serialized = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("preparation was serialized")), 20_000); });
      try { await Promise.race([bothEntered, serialized]); } finally { clearTimeout(timer); }
      return "host";
    };
    const [first, second] = await Promise.all([
      createWorkspace("first", f.repo, { hooks: { prepare } }),
      createWorkspace("second", f.repo, { hooks: { prepare } }),
    ]);
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.deepEqual([...entered].sort(), [first.workspacePath, second.workspacePath].sort());
  } finally {
    await f.dispose();
  }
}, 120_000);

test("concurrent starts of one Issue prepare its checkout one at a time", async () => {
  const f = await project();
  try {
    let active = 0;
    let overlapped = false;
    const prepare = async () => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      active -= 1;
      return "host";
    };
    const [first, second] = await Promise.all([
      createWorkspace("Issue #96601", f.repo, { issueNumber: 96601, hooks: { prepare } }),
      createWorkspace("Issue #96601", f.repo, { issueNumber: 96601, hooks: { prepare } }),
    ]);
    assert.equal(first.workspacePath, second.workspacePath);
    assert.equal(overlapped, false, "two preparations ran in one checkout at once");
  } finally {
    await f.dispose();
  }
}, 120_000);
