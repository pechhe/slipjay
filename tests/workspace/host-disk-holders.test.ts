import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { holdersOfOpenFiles } from "../../src/lib/host-disk/disk-holders.ts";
import type { OpenPaths } from "../../src/lib/host-disk/disk-holders.ts";

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
