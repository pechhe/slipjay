import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), platform: () => "darwin" }));
const { managedCleanupInventory } = await import("../../src/lib/workspace/workspace-claim-activation.ts");

// Lists one managed candidate; `ps eww` for it exits 0 with no HOME in its output.
async function inventoryWithCandidate(pid: number) {
  const bin = await mkdtemp(join(tmpdir(), "slipjay-ps-"));
  const ps = join(bin, "ps");
  await writeFile(ps, `#!/bin/sh\nif [ "$1" = "-axo" ]; then echo "${pid} bun /x/.bun/bin/slipjay start"; fi\nexit 0\n`);
  await chmod(ps, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try { return await managedCleanupInventory(); }
  finally { process.env.PATH = path; await rm(bin, { recursive: true, force: true }); }
}

test("darwin inventory ignores a candidate that exited before its environment was read", async () => {
  assert.deepEqual(await inventoryWithCandidate(2147483646), { complete: true, pids: [] });
});

test("darwin inventory fails closed for a live candidate whose environment is unreadable", async () => {
  assert.deepEqual(await inventoryWithCandidate(process.pid), { complete: false, pids: [] });
});
