import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const OLD = new Date(Date.now() - 200 * 3600_000);

/** A disposable HOME whose machine config declares a disk policy over directories inside it. */
async function home(disk: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-disk-cmd-"));
  await mkdir(join(dir, ".slipjay"), { recursive: true });
  await writeFile(join(dir, ".slipjay", "config.json"), JSON.stringify({ disk }));
  return dir;
}
const cliRun = (dir: string, args: string[]) => spawnSync("bun", [cli, ...args], { cwd: dir, env: { ...process.env, HOME: dir }, encoding: "utf8", timeout: 60_000 });
const policy = (dir: string, thresholds: Record<string, number> = {}) => ({
  thresholds, ballast: { path: join(dir, "ballast"), bytes: 0 }, runRoot: join(dir, "runs"),
  scratchRoots: [{ path: join(dir, "tmp"), match: ["*-scratch"], ttlHours: 72 }], regenerable: [join(dir, "tmp", "cache")],
});

test("disk --plan lists the managed directories and changes nothing; disk applies the same policy", async () => {
  // Thresholds at 1% make any real disk "shed" without reaching refill-stop or critical.
  const shed = { warnPercent: 1, shedPercent: 1, refillPercent: 99, criticalPercent: 100, ballastRecreatePercent: 1 };
  const home = await mkdtemp(join(tmpdir(), "slipjay-disk-cmd-"));
  await mkdir(join(home, ".slipjay"), { recursive: true });
  await writeFile(join(home, ".slipjay", "config.json"), JSON.stringify({ disk: policy(home, shed) }));
  try {
    await mkdir(join(home, "tmp", "cache"), { recursive: true });
    await mkdir(join(home, "tmp", "old-scratch"));
    await utimes(join(home, "tmp", "old-scratch"), OLD, OLD);
    const plan = cliRun(home, ["disk", "--plan", "--json"]);
    assert.equal(plan.status, 0, plan.stderr);
    const planned = JSON.parse(plan.stdout) as { level: string; rows: Array<{ class: string; action: string }> };
    assert.equal(planned.level, "shed");
    // Open files are read from /proc, so only Linux can judge scratch; elsewhere it is kept, never guessed at.
    const linux = platform() === "linux";
    // The real disk's unexplained-space row is report-only and its size is the host's, so it is left out here.
    assert.deepEqual(planned.rows.filter((row) => row.class !== "unexplained" && !row.class.endsWith("-volume") && row.class !== "loop-image").map((row) => `${row.class}:${row.action}`).sort(), ["regenerable:remove", linux ? "scratch:remove" : "scratch:keep"]);
    const text = cliRun(home, ["disk", "--plan"]);
    assert.match(text.stdout, linux ? /^remove\tscratch\t.*old-scratch\t/m : /^keep\tscratch\t.*old-scratch\t/m);
    assert.equal(existsSync(join(home, "tmp", "cache")) && existsSync(join(home, "tmp", "old-scratch")), true, "--plan changed nothing");
    const applied = cliRun(home, ["disk"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(existsSync(join(home, "tmp", "cache")), false);
    if (linux) {
      assert.match(applied.stdout, /^removed\tscratch\t.*old-scratch\t/m);
      assert.equal(existsSync(join(home, "tmp", "old-scratch")), false);
    } else assert.equal(existsSync(join(home, "tmp", "old-scratch")), true, "scratch that cannot be judged is kept");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("disk rejects unknown arguments and a malformed disk key", async () => {
  const h = await home({ thresholds: { shedPercent: "x" } });
  try {
    const bad = cliRun(h, ["disk", "--plan"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /thresholds\.shedPercent/);
    assert.equal(cliRun(h, ["disk", "--bogus"]).status, 1);
  } finally { await rm(h, { recursive: true, force: true }); }
});

test("maintain reports the disk outcome, and a failing disk pass does not stop the rest but exits 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-disk-cmd-"));
  try {
    await mkdir(join(dir, ".slipjay", "state", "archive-requests"), { recursive: true });
    await writeFile(join(dir, ".slipjay", "state", "archive-requests", "broken.json"), "{ not a request");
    await writeFile(join(dir, ".slipjay", "config.json"), JSON.stringify({ disk: policy(dir) }));
    const good = cliRun(dir, ["maintain", "--json"]);
    assert.equal(good.status, 0, good.stderr);
    const reported = JSON.parse(good.stdout) as { disk: { state: string; level: string }; diskError?: string };
    assert.equal(reported.disk.state, "applied");
    assert.equal(reported.diskError, undefined);

    await writeFile(join(dir, ".slipjay", "config.json"), JSON.stringify({ disk: { thresholds: { shedPercent: "x" } } }));
    const plain = cliRun(dir, ["maintain"]);
    assert.equal(plain.status, 1, "a failing disk pass exits 1");
    assert.match(plain.stderr, /maintain could not apply the disk policy: .*thresholds\.shedPercent/);
    assert.match(plain.stdout, /^failed\tbroken\t/m, "the other steps still ran and reported");
    const json = cliRun(dir, ["maintain", "--json"]);
    assert.equal(json.status, 1);
    const failed = JSON.parse(json.stdout) as { diskError: string; requests: unknown[]; evictions: unknown };
    assert.match(failed.diskError, /thresholds\.shedPercent/);
    assert.ok(failed.evictions && "requests" in failed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("maintain text output names Issues over the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-disk-cmd-"));
  try {
    await mkdir(join(dir, "runs", "7"), { recursive: true });
    await writeFile(join(dir, "runs", "7", "manifest.json"), JSON.stringify({ issue: "7", owner: "henry", created: "2026-10-01T00:00:00Z", pin: true }));
    await writeFile(join(dir, "runs", "7", "big"), Buffer.alloc(2 * 1024 * 1024));
    await mkdir(join(dir, ".slipjay"), { recursive: true });
    await writeFile(join(dir, ".slipjay", "config.json"), JSON.stringify({ disk: { ...policy(dir), issueCapBytes: 1024 * 1024 } }));
    const run = cliRun(dir, ["maintain"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^over cap\t7\t.*\thenry$/m);
    assert.equal(existsSync(join(dir, "runs", "7", "big")), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
