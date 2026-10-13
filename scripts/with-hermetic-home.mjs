#!/usr/bin/env node
// Run one test command with a disposable HOME, like scripts/vitest-hermetic-env.mjs
// does for Vitest. Bun resolves homedir() at startup, so the isolated value must be
// set before the test runtime launches rather than inside the test file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-hermetic-home.mjs <command> [args...]");
  process.exit(2);
}
const home = realpathSync(mkdtempSync(join(tmpdir(), "peach-test-home-")));
const env = { ...process.env, HOME: home };
for (const key of Object.keys(env)) {
  if (/^(CMUX_|SLIPJAY_COMMAND_|XDG_(CONFIG|STATE|DATA)_HOME$)/.test(key) || key === "PI_CODING_AGENT_DIR") delete env[key];
}
try {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
