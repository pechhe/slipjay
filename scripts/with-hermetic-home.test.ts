import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./with-hermetic-home.ts", import.meta.url));
const probe = "console.log(JSON.stringify({ home: require('node:os').homedir(), timeout: process.env.SLIPJAY_COMMAND_TIMEOUT_MS ?? null, agent: process.env.PI_CODING_AGENT_DIR ?? null, jjConfig: process.env.JJ_CONFIG ?? null, gitConfig: process.env.GIT_CONFIG_GLOBAL ?? null }))";

test("runs the command with a disposable HOME and without host session or config-path variables", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, SLIPJAY_COMMAND_TIMEOUT_MS: "1000", PI_CODING_AGENT_DIR: "/host/agent", JJ_CONFIG: "/host/jj.toml", GIT_CONFIG_GLOBAL: "/host/gitconfig" },
  });
  expect(result.status).toBe(0);
  const seen = JSON.parse(result.stdout.trim());
  expect(seen.home).not.toBe(homedir());
  expect(seen.home).toContain("peach-test-home-");
  expect(seen.timeout).toBeNull();
  expect(seen.agent).toBeNull();
  expect(seen.jjConfig).toBeNull();
  expect(seen.gitConfig).toBeNull();
  expect(existsSync(seen.home)).toBe(false);
});

test("propagates the command's failure", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "process.exit(3)"]);
  expect(result.status).toBe(3);
});
