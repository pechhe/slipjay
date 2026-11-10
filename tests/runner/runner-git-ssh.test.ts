import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { gitSshCommand } from "../../src/lib/runner/runner-service.ts";

test("the runner's Git transport shares one SSH connection per host and account, kept in its own directory (SJ-223)", () => {
  const home = mkdtempSync(join(tmpdir(), "runner-git-ssh-"));
  try {
    const command = gitSshCommand(home);
    assert.equal(command, `ssh -o ControlMaster=auto -o ControlPath=${join(home, "ssh", "git-%C")} -o ControlPersist=600`);
    assert.equal(statSync(join(home, "ssh")).mode & 0o777, 0o700);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
