import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { runRequiredVerification } from "../src/lib/required-verification.ts";
import { verificationSlotEnvironment } from "../src/lib/verification-slot.ts";

/** A check that records the directory it ran in. */
const recordCwd = (marker: string) => ({ executable: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd())`] });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "peach-required-verification-")));
  const root = path.join(base, "checkout");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(root, "escape"));
  const marker = path.join(base, "ran-in.txt");
  // Run as if inside a held slot, so the test never queues behind real landings.
  const run = (checks: object[]) => runRequiredVerification({ root, checks, environment: () => verificationSlotEnvironment(process.env) });
  return { root, marker, run, dispose: () => rm(base, { recursive: true, force: true }) };
}

test("a check runs in its declared relative cwd inside the checkout", async () => {
  const f = await fixture();
  try {
    await f.run([{ ...recordCwd(f.marker), cwd: "packages/app" }]);
    assert.equal(await readFile(f.marker, "utf8"), path.join(f.root, "packages", "app"));
  } finally { await f.dispose(); }
});

test("a check whose cwd is a symlink out of the checkout is refused before it runs", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run([{ ...recordCwd(f.marker), cwd: "escape" }]),
      /Required verification check 1 cwd "escape" resolves outside the checkout/);
    await assert.rejects(readFile(f.marker, "utf8"), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("a capability probe whose cwd is a symlink out of the checkout is refused before it runs", async () => {
  const f = await fixture();
  try {
    const capability = { id: "fixture", probe: { ...recordCwd(f.marker), cwd: "escape" }, onUnavailable: "continue", unavailableExitCodes: [19], unavailableStderrIncludes: ["unavailable"] };
    await assert.rejects(f.run([{ executable: process.execPath, args: ["-e", ""], capability }]),
      /Required verification check 1 capability probe fixture cwd "escape" resolves outside the checkout/);
    await assert.rejects(readFile(f.marker, "utf8"), { code: "ENOENT" });
  } finally { await f.dispose(); }
});
