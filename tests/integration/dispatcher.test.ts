import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { installPackage } from "../support/installed-package.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

function run(binary: string, args: string[], cwd = homedir()) {
  return spawnSync("bun", [binary, ...args], { cwd, env: process.env, encoding: "utf8", timeout: 30_000 });
}

test("checkout and installed dispatch preserve version, usage, invalid commands and family usage errors", async () => {
  assert.notEqual(homedir(), userInfo().homedir, "CLI checks require a disposable HOME");
  const installed = await installPackage();
  try {
    for (const binary of [cli, installed.bin]) {
      const reported = run(binary, ["--version"]);
      assert.equal(reported.status, 0, reported.stderr);
      assert.equal(reported.stdout, `${version}\n`);
      assert.equal(reported.stderr, "");
      for (const args of [[], ["unknown-command"], ["constructor"], ["toString"], ["--help"]]) {
        const invalid = run(binary, args);
        assert.equal(invalid.status, 2, invalid.stderr);
        assert.equal(invalid.stdout, "");
        assert.match(invalid.stderr, /^Usage: slipjay <--version\|status\|/);
      }
      for (const [command, args] of [
        ["start", ["--unknown"]], ["attempt", []], ["landed", []], ["adopt", []],
        ["prune", []], ["evict", ["--unknown"]], ["archive", ["--unknown"]], ["restore", []],
        ["archives", ["extra"]], ["maintain", ["extra"]], ["retire", []], ["retire-result", []],
        ["retirements", ["extra"]], ["cleanup", ["--unknown"]], ["remove", []],
        ["repair", []], ["land", ["--unknown"]], ["promote", ["--unknown"]],
        ["deploy", []], ["reset", ["extra"]], ["deploys", ["--unknown"]],
        ["config", ["--unknown"]], ["policy", []], ["cutover", ["--unknown"]],
        ["metrics", ["--unknown"]], ["record-preview", []], ["watch", []], ["cancel", []], ["runner", []],
      ] as const) {
        const invalid = run(binary, [command, ...args]);
        assert.equal(invalid.status, command === "start" ? 2 : 1, invalid.stderr);
        assert.equal(invalid.stdout, "", command);
        assert.match(invalid.stderr, new RegExp(`^Usage: slipjay ${command}`));
        assert.doesNotMatch(invalid.stderr, /\n\s+at /, "top-level errors have no stack trace");
      }
      const retired = run(binary, ["release"]);
      assert.equal(retired.status, 2);
      assert.equal(retired.stdout, "");
      assert.match(retired.stderr, /^slipjay release is retired;/);
    }
  } finally { await installed.dispose(); }
});

test("importing every command family leaves stdin, runner startup, signals and output untouched", async () => {
  const installed = await installPackage();
  try {
    const probe = await installed.script("import-handlers.mjs", `
      import assert from "node:assert/strict";
      const signals = ["SIGINT", "SIGTERM"];
      // The library's lock dependency registers its own exit hooks on load; only what a handler module adds is the handler's.
      await import(${JSON.stringify(`${installed.packageUrl}/src/lib/slipjay.ts`)});
      const before = signals.map(signal => process.listeners(signal));
      const exitCode = process.exitCode;
      Object.defineProperty(process, "stdin", { get() { throw new Error("handler import read stdin"); } });
      process.argv = [process.execPath, "fixture", "runner", "serve"];
      for (const module of ${JSON.stringify(["workspace-commands", "retention-commands", "start-commands", "landing-commands", "release-commands", "policy-commands", "cutover-command", "observation-commands", "runner-command", "hook-command", "command-context"])}) {
        await import(${JSON.stringify(`${installed.packageUrl}/src/launcher/`)} + module + ".ts");
      }
      assert.deepEqual(signals.map(signal => process.listeners(signal)), before);
      assert.equal(process.exitCode, exitCode);
    `);
    const imported = run(probe, [], installed.root);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");
  } finally { await installed.dispose(); }
});
