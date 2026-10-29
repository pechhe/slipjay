import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { runWorkspaceCommand, withWorkspaceCommandSignal } from "../../src/lib/infra/workspace-command.ts";

test("a cancelled workspace-command scope stops its subprocess and fences later commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-command-cancel-"));
  const ready = join(root, "ready");
  const late = join(root, "late");
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const script = `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const command = withWorkspaceCommandSignal(controller.signal, async () => {
    try {
      await runWorkspaceCommand(process.execPath, ["-e", script], { cwd: root, timeoutMs: 60_000 });
    } catch {
      // Even a caller that catches a cancelled read cannot continue mutating the checkout.
      await runWorkspaceCommand(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(late)},"");`], { cwd: root });
    }
  }, pending);
  const rejected = assert.rejects(command, { name: "AbortError" });
  try {
    await vi.waitFor(() => assert.ok(existsSync(ready)));
    const pid = Number(await readFile(ready, "utf8"));
    assert.ok(pending.size > 0);
    controller.abort();
    await rejected;
    await Promise.allSettled([...pending]);
    assert.equal(pending.size, 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(existsSync(late), false);
  } finally {
    controller.abort();
    await rejected;
    await rm(root, { recursive: true, force: true });
  }
});
