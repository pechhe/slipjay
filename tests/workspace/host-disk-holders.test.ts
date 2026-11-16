import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { processWorkingDirectories } from "../../src/lib/workspace/workspace-holders.ts";
import { holdersOfOpenFiles, openPathsByProcess } from "../../src/lib/host-disk/disk-holders.ts";
import type { OpenPaths } from "../../src/lib/host-disk/disk-holders.ts";

test("timed-out lsof partial output is never proof of a complete holder inventory", async () => {
  const run = async () => ({ code: 1, timedOut: true, truncated: false, signal: null, stdout: "p1\ncnode\nn/x\n", stderr: "" });
  assert.equal(await openPathsByProcess({ platform: "darwin", run }), null);
  assert.equal(await processWorkingDirectories({ platform: "darwin", run }), null);
  for (const override of [{ timedOut: false, truncated: true }, { timedOut: false, stdout: "" }]) {
    const incomplete = async () => ({ ...await run(), ...override });
    assert.equal(await openPathsByProcess({ platform: "darwin", run: incomplete }), null);
    assert.equal(await processWorkingDirectories({ platform: "darwin", run: incomplete }), null);
  }
});

const open: OpenPaths = [
  { pid: 10, command: "node", paths: new Set(["/tmp/x-scratch/node_modules/a/b.node", "/usr/lib/libc.so"]) },
  { pid: 11, command: "bash", paths: new Set(["/tmp/x-scratch-other/file"]) },
  { pid: 12, command: "tail", paths: new Set(["/tmp/x-scratch"]) },
];

test("a process with a file mapped under the directory holds it, wherever its working directory is", () => {
  assert.deepEqual(holdersOfOpenFiles("/tmp/x-scratch", open).map((holder) => holder.pid), [10, 12]);
});

test("a sibling whose name only starts the same does not hold it", () => {
  assert.deepEqual(holdersOfOpenFiles("/tmp/y-scratch", open), []);
  assert.deepEqual(holdersOfOpenFiles("/tmp/x-scratch-other", open).map((holder) => holder.pid), [11]);
});
