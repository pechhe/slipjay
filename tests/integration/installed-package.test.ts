import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { installPackage } from "../support/installed-package.ts";
import { project } from "../support/workspace-project.ts";

// The packed distributable, installed outside the checkout under the disposable HOME the
// test setup provides, behaves as the source tree does: the binary, both public entries
// and the three detached background entries all resolve inside the installed package.

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(SOURCE_ROOT, "package.json"), "utf8")) as { version: string }).version;
const ENTRIES = ["client-facts", "housekeeping-run", "spare-refill"] as const;

test("the installed binary reports the package version and starts a workspace as JSON", async () => {
  const installed = await installPackage();
  const f = await project();
  try {
    assert.equal(execFileSync(installed.bin, ["--version"], { cwd: installed.root, encoding: "utf8" }).trim(), VERSION);
    const started = spawnSync(installed.bin, ["start", "--json", "installed task"], { cwd: f.repo, encoding: "utf8", env: process.env });
    assert.equal(started.status, 0, started.stderr);
    const receipt = JSON.parse(started.stdout) as { workspacePath: string };
    assert.ok(existsSync(receipt.workspacePath), "the receipt names a real checkout");

    // A caller importing the handler has a different argv[1]; JSON start must still spawn the package binary.
    const invoke = await installed.script("invoke-start.mjs", `
      import { runStart } from ${JSON.stringify(`${installed.packageUrl}/src/launcher/start-commands.ts`)};
      await runStart(["--integration", "--json", "imported handler task"]);
    `);
    const imported = spawnSync("bun", [invoke], { cwd: f.repo, encoding: "utf8", env: process.env, timeout: 120_000 });
    assert.equal(imported.status, 0, imported.stderr);
    const second = JSON.parse(imported.stdout) as { workspacePath: string; integrationRoot: string };
    assert.equal(imported.stdout, `${JSON.stringify(second)}\n`);
    assert.equal(second.integrationRoot, f.repo);
    assert.notEqual(second.workspacePath, receipt.workspacePath);
    assert.ok(existsSync(second.workspacePath));
  } finally {
    await f.dispose();
    await installed.dispose();
  }
}, 180_000);

test("both public package names resolve to the installed facade with the same exports", async () => {
  const installed = await installPackage();
  try {
    const script = await installed.script("probe.mjs", `
      import * as main from "@pechhe/slipjay";
      import * as delivery from "@pechhe/slipjay/delivery";
      console.log(JSON.stringify({
        main: import.meta.resolve("@pechhe/slipjay"),
        delivery: import.meta.resolve("@pechhe/slipjay/delivery"),
        same: main === delivery || JSON.stringify(Object.keys(main).sort()) === JSON.stringify(Object.keys(delivery).sort()),
        workspace: typeof main.createWorkspace,
        landing: typeof delivery.landingPreview,
      }));
    `);
    const probe = JSON.parse(installed.bun([script])) as Record<string, unknown>;
    assert.equal(probe.main, `${installed.packageUrl}/src/lib/slipjay.ts`);
    assert.equal(probe.delivery, `${installed.packageUrl}/src/lib/slipjay.ts`);
    assert.deepEqual([probe.same, probe.workspace, probe.landing], [true, "function", "function"]);
  } finally {
    await installed.dispose();
  }
}, 120_000);

test("every detached background entry is launched from, and runs inside, the installed package", async () => {
  assert.notEqual(homedir(), userInfo().homedir, "installed-package checks need the disposable HOME");
  const installed = await installPackage();
  const f = await project();
  try {
    // Interception: the launches run a recorder instead of bun, so the entry each caller built is observable.
    const log = join(installed.root, "launches.log");
    const recorder = join(installed.root, "recorder.sh");
    await installed.script("recorder.sh", `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(log)}\n`);
    execFileSync("chmod", ["+x", recorder]);
    const preload = await installed.script("preload.mjs", `process.execPath = ${JSON.stringify(recorder)};\n`);
    // The facade does not export the recorder, so the installed module is imported by its file URL.
    const launch = await installed.script("launch.mjs", `
      import { startHousekeeping, startSpareRefill } from "@pechhe/slipjay";
      import { recordClientFactsInBackground } from ${JSON.stringify(`${installed.packageUrl}/src/lib/runner/runner-client.ts`)};
      const repo = ${JSON.stringify(f.repo)};
      await startSpareRefill(repo);
      await startHousekeeping(repo);
      await recordClientFactsInBackground(repo, [], { ...process.env, SLIPJAY_RUNNER: "http://127.0.0.1:1" });
    `);
    // The test setup disables the automatic sweep; this child is the one place that launches it.
    installed.bun(["--preload", preload, launch], { env: { ...process.env, SLIPJAY_AUTO_HOUSEKEEPING: "1" } });
    await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0), { timeout: 15_000 }).toBe(3);
    const launched = readFileSync(log, "utf8").trim().split("\n").sort();
    assert.deepEqual(launched, ENTRIES.map((entry) => join(installed.packageRoot, "src", "launcher", `${entry}.ts`)).sort());
    for (const entry of launched) assert.ok(existsSync(entry), `${entry} is in the installed package`);

    // Smoke: each installed entry runs to completion against the disposable project.
    for (const [entry, args] of [["spare-refill", [f.repo]], ["housekeeping-run", [f.repo]], ["client-facts", [f.repo, "[]"]]] as const) {
      const run = spawnSync("bun", [join(installed.packageRoot, "src", "launcher", `${entry}.ts`), ...args], { cwd: installed.root, encoding: "utf8", env: process.env, timeout: 120_000 });
      assert.equal(run.status, 0, `${entry}: ${run.stderr}`);
    }
  } finally {
    await f.dispose();
    await installed.dispose();
  }
}, 240_000);
