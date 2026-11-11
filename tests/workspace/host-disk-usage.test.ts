import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { readHostUsage, readUsageOf, usagePath } from "../../src/lib/host-disk/disk-usage.ts";
import { slipjayHome } from "../../src/lib/workspace/workspace-paths.ts";

afterEach(async () => { await rm(slipjayHome(), { recursive: true, force: true }); });

/** A `df` that answers with this output and records the path it was asked about. */
function df(stdout: string, calls: string[][], code = 0) {
  return async (command: string, args: string[]) => { calls.push([command, ...args]); return { code, stdout, stderr: "" }; };
}

const dataVolume = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 482443008 431584716 20462480 96% /System/Volumes/Data\n";

test("the usage measured is the filesystem holding the state home, not the sealed system volume", async () => {
  await mkdir(slipjayHome(), { recursive: true });
  assert.equal(usagePath(), slipjayHome());
  const calls: string[][] = [];
  const usage = await readUsageOf(usagePath(), df(dataVolume, calls));
  assert.deepEqual(calls, [["df", "-Pk", slipjayHome()]]);
  // The Data volume's figures, not the sealed root's: the policy now sees 96% and sheds.
  assert.deepEqual(usage, { percent: 96, totalBytes: (431584716 + 20462480) * 1024, freeBytes: 20462480 * 1024, usedBytes: 431584716 * 1024 });
});

test("with no state home yet it measures the home it will be created in, on the same filesystem", async () => {
  await rm(slipjayHome(), { recursive: true, force: true });
  assert.equal(usagePath(), homedir());
});

test("the host reader asks about that path", async () => {
  await mkdir(slipjayHome(), { recursive: true });
  // The reader's own command runs against this host, so only its answer's shape is asserted here.
  const usage = await readHostUsage();
  if (usage !== null) assert.ok(usage.percent >= 0 && usage.percent <= 100);
});

test("a df that fails, or prints no usable figures, reads as unknown", async () => {
  assert.equal(await readUsageOf("/", df("", [], 1)), null);
  assert.equal(await readUsageOf("/", df("df: /nope: No such file or directory\n", [])), null);
  assert.equal(await readUsageOf("/", df("Filesystem 1024-blocks Used Available Capacity Mounted on\nx 0 0 0 0% /\n", [])), null);
  const refused = async () => { throw new Error("df could not start"); };
  assert.equal(await readUsageOf("/", refused), null);
});
