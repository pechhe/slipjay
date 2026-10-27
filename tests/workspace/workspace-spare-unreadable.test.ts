import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

const readable = vi.hoisted(() => ({ processes: true }));
vi.mock("../../src/lib/workspace/workspace-holders.ts", async (original) => {
  const actual = await original<typeof import("../../src/lib/workspace/workspace-holders.ts")>();
  return { ...actual, processWorkingDirectories: async () => readable.processes ? await actual.processWorkingDirectories() : null };
});

const { createWorkspace } = await import("../../src/lib/workspace/workspace-create.ts");
const { readySpares } = await import("../../src/lib/workspace/workspace-pool.ts");
const { ProcessesUnreadableError } = await import("../../src/lib/workspace/workspace-spares.ts");
const { bunProject, refill } = await import("./fixtures/workspace-spare-dependencies-fixture.ts");

test("when the host's processes cannot be read, the pool takes no spare: a claim installs fresh and the refill says why", async () => {
  const f = await bunProject({ spares: 1 });
  try {
    await refill(f.repo);
    const [spare] = await readySpares(f.repo);
    assert.ok(spare);
    readable.processes = false;
    await assert.rejects(readySpares(f.repo), ProcessesUnreadableError);
    await assert.rejects(refill(f.repo), ProcessesUnreadableError);
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, false, "the claim did not take the spare it could not prove free");
    assert.notEqual(created.current.root, spare.root);
  } finally {
    readable.processes = true;
    await f.dispose();
  }
}, 240_000);
