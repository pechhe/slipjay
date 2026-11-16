import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureScratch } from "./fixture-scratch.ts";

const scratchName = `slipjay-test-${process.pid}-`;

test("a scratch directory is made in the first root this process may write to", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "slipjay-fixture-scratch-test-")));
  try {
    const scratch = createFixtureScratch([root, tmpdir()]);
    expect(scratch.startsWith(join(root, scratchName))).toBe(true);
    expect(statSync(scratch).isDirectory()).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a preferred root this process may not write to leaves the temp directory to supply the scratch", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "slipjay-fixture-scratch-test-")));
  const readOnly = join(parent, "shm");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o500);
  try {
    // A read-only agent shell is this case: /dev/shm refuses the directory, and every write must go to $TMPDIR.
    const scratch = createFixtureScratch([readOnly, tmpdir()]);
    expect(scratch.startsWith(join(realpathSync(tmpdir()), scratchName))).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  } finally {
    chmodSync(readOnly, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
});
