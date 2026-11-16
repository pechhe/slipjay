import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

test("launchd installer writes both timed agents without loading or contacting a service in inspection mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "disk-guard-install-"));
  try {
    const bin = join(root, "bin"); await mkdir(bin);
    await writeFile(join(bin, "slipjay"), "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "slipjay"), 0o755);
    await writeFile(join(bin, "launchctl"), "#!/bin/sh\nexit 99\n"); await chmod(join(bin, "launchctl"), 0o755);
    const run = spawnSync("bash", ["scripts/install-disk-guard-launchd.sh", "--no-load"], { env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const parsed = spawnSync("python3", ["-c", "import json,plistlib,sys; print(json.dumps([plistlib.load(open(p,'rb')) for p in sys.argv[1:]]))", ...["disk", "maintain"].map((kind) => join(root, "Library/LaunchAgents", `com.pechhe.slipjay-${kind}.plist`))], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    const units = JSON.parse(parsed.stdout) as Array<{ StartInterval: number; RunAtLoad: boolean; ProgramArguments: string[]; EnvironmentVariables: { PATH: string } }>;
    assert.deepEqual(units.map((unit) => unit.StartInterval), [300, 3600]);
    assert.ok(units.every((unit) => unit.RunAtLoad && unit.EnvironmentVariables.PATH.startsWith(bin)));
    assert.deepEqual(units[0]!.ProgramArguments, [join(bin, "slipjay"), "disk"]);
    assert.deepEqual(units[1]!.ProgramArguments, ["/bin/bash", join(root, ".slipjay/maintain.sh"), join(bin, "slipjay")]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
