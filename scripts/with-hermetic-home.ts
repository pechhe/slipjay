#!/usr/bin/env bun
// Run one test command with a disposable HOME, like scripts/vitest-hermetic-env.ts
// does for Vitest. Bun resolves homedir() at startup, so the isolated value must be
// set before the test runtime launches rather than inside the test file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_GIT_IDENTITY } from "./fixture-git-config.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-hermetic-home.ts <command> [args...]");
  process.exit(2);
}
const home = realpathSync(mkdtempSync(join(tmpdir(), "peach-test-home-")));
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
for (const key of Object.keys(env)) {
  // JJ_CONFIG and GIT_CONFIG_* would still name the developer's real configuration under the disposable HOME.
  if (/^(CMUX_|SLIPJAY_COMMAND_|XDG_(CONFIG|STATE|DATA)_HOME$|JJ_CONFIG$|GIT_CONFIG_(GLOBAL|SYSTEM)$)/.test(key) || key === "PI_CODING_AGENT_DIR") delete env[key];
}
try {
  writeFileSync(join(home, ".gitconfig"), FIXTURE_GIT_IDENTITY, { mode: 0o600 });
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
