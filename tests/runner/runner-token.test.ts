import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

/** A fake `bws` that counts its calls and fails while `fail` exists. */
async function fakeBitwarden() {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-bws-"));
  const calls = join(dir, "calls"), fail = join(dir, "fail");
  await writeFile(join(dir, "bws"), `#!/bin/sh\necho call >> "${calls}"\n[ -e "${fail}" ] && exit 1\necho '[{"key":"SLIPJAY_RUNNER_TOKEN","value":"from-bitwarden"}]'\n`);
  await chmod(join(dir, "bws"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, SLIPJAY_RUNNER_TOKEN: "" };
  const count = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { dir, env, fail, count };
}

test("one command asks Bitwarden for the runner token once", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-client.ts");
  const bws = await fakeBitwarden();
  try {
    assert.deepEqual(await Promise.all([runnerToken(bws.env), runnerToken(bws.env)]), ["from-bitwarden", "from-bitwarden"]);
    assert.equal(await runnerToken(bws.env), "from-bitwarden");
    assert.equal(await bws.count(), 1);
    assert.equal(await runnerToken({ ...bws.env, SLIPJAY_RUNNER_TOKEN: "from-env" }), "from-env");
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a failed Bitwarden lookup is asked again on the next call", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-client.ts");
  const bws = await fakeBitwarden();
  try {
    await writeFile(bws.fail, "");
    await assert.rejects(runnerToken(bws.env), /SLIPJAY_RUNNER_TOKEN/);
    await rm(bws.fail);
    assert.equal(await runnerToken(bws.env), "from-bitwarden");
    assert.equal(await bws.count(), 2);
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});
