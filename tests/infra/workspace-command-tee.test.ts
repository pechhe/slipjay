import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { runWorkspaceCommand } from "../../src/lib/infra/workspace-command.ts";

test("tee streams both streams to the terminal and keeps them for the caller", async () => {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await runWorkspaceCommand("sh", ["-c", "echo installed; echo 'error: No version matching' >&2; exit 3"], { tee: true });
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "installed\n");
    assert.equal(result.stderr, "error: No version matching\n");
    assert.ok(out.mock.calls.some(([chunk]) => String(chunk).includes("installed")));
    assert.ok(err.mock.calls.some(([chunk]) => String(chunk).includes("No version matching")));
  } finally { out.mockRestore(); err.mockRestore(); }
});

test("tee reports a command that cannot start as a failure naming it", async () => {
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await runWorkspaceCommand("slipjay-no-such-command", [], { tee: true });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /slipjay-no-such-command could not start/);
  } finally { err.mockRestore(); }
});
