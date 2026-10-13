import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./with-hermetic-home.mjs", import.meta.url));
const probe = "console.log(JSON.stringify({ home: require('node:os').homedir(), timeout: process.env.SLIPJAY_COMMAND_TIMEOUT_MS ?? null, agent: process.env.PI_CODING_AGENT_DIR ?? null }))";

test("runs the command with a disposable HOME and without host session variables", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, SLIPJAY_COMMAND_TIMEOUT_MS: "1000", PI_CODING_AGENT_DIR: "/host/agent" },
  });
  expect(result.status).toBe(0);
  const seen = JSON.parse(result.stdout.trim());
  expect(seen.home).not.toBe(homedir());
  expect(seen.home).toContain("peach-test-home-");
  expect(seen.timeout).toBeNull();
  expect(seen.agent).toBeNull();
  expect(existsSync(seen.home)).toBe(false);
});

test("propagates the command's failure", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "process.exit(3)"]);
  expect(result.status).toBe(3);
});
