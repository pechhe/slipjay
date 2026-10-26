import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

/** A fake `bws` that counts its calls, fails while `fail` exists, and prints `list` (default: the token) otherwise. */
async function fakeBitwarden(list = '[{"key":"SLIPJAY_RUNNER_TOKEN","value":"from-bitwarden"}]') {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-bws-"));
  const calls = join(dir, "calls"), fail = join(dir, "fail"), output = join(dir, "output");
  await writeFile(output, list);
  await writeFile(join(dir, "bws"), `#!/bin/sh\necho call >> "${calls}"\n[ -e "${fail}" ] && echo "secret-looking stderr" >&2 && exit 1\ncat "${output}"\n`);
  await chmod(join(dir, "bws"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, SLIPJAY_RUNNER_TOKEN: "" };
  const count = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { dir, env, fail, count };
}

test("one command asks Bitwarden for the runner token once", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
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
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const bws = await fakeBitwarden();
  try {
    await writeFile(bws.fail, "");
    await assert.rejects(runnerToken(bws.env), /SLIPJAY_RUNNER_TOKEN/); // three attempts
    await rm(bws.fail);
    assert.equal(await runnerToken(bws.env), "from-bitwarden");
    assert.equal(await bws.count(), 4);
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a transient Bitwarden failure does not fail the lookup", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const bws = await fakeBitwarden();
  try {
    // Fails on the first attempt only: the script removes its own failure marker after the first call.
    await writeFile(join(bws.dir, "bws"), `#!/bin/sh\necho call >> "${join(bws.dir, "calls")}"\nif [ -e "${bws.fail}" ]; then rm "${bws.fail}"; exit 1; fi\ncat "${join(bws.dir, "output")}"\n`);
    await writeFile(bws.fail, "");
    assert.equal(await runnerToken(bws.env), "from-bitwarden");
    assert.equal(await bws.count(), 2);
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a persistent failure stops after a finite number of attempts and names the cause without bws output", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const bws = await fakeBitwarden();
  try {
    await writeFile(bws.fail, "");
    await assert.rejects(runnerToken(bws.env), (error: Error) => {
      assert.match(error.message, /after 3 attempts \(bws exited non-zero\)/);
      assert.doesNotMatch(error.message, /secret-looking/);
      return true;
    });
    assert.equal(await bws.count(), 3);
    await writeFile(join(bws.dir, "output"), "this is not json with a secret");
    await rm(bws.fail);
    await assert.rejects(runnerToken(bws.env), (error: Error) => {
      assert.match(error.message, /bws returned unparsable output/);
      assert.doesNotMatch(error.message, /this is not json/);
      return true;
    });
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a lookup that times out says so", async () => {
  vi.resetModules();
  vi.doMock("../../src/lib/infra/bounded-process.ts", () => ({
    runBoundedProcess: async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }),
  }));
  try {
    const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
    await assert.rejects(runnerToken({ ...process.env, SLIPJAY_RUNNER_TOKEN: "" }), /after 3 attempts \(bws timed out\)/);
  } finally { vi.doUnmock("../../src/lib/infra/bounded-process.ts"); vi.resetModules(); }
});

test("an unrelated secret holding a raw newline or tab does not hide the token", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const bws = await fakeBitwarden(`[{"key":"OTHER","value":"line one\nline\ttwo \\"quoted\\""},{"key":"SLIPJAY_RUNNER_TOKEN","value":"from-bitwarden"}]`);
  try {
    assert.equal(await runnerToken(bws.env), "from-bitwarden");
    assert.equal(await bws.count(), 1);
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a truly absent key keeps the missing-key message and shows no output", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const bws = await fakeBitwarden('[{"key":"OTHER","value":"hidden-value"}]');
  try {
    await assert.rejects(runnerToken(bws.env), (error: Error) => {
      assert.equal(error.message, "Set SLIPJAY_RUNNER_TOKEN or save the Bitwarden key SLIPJAY_RUNNER_TOKEN");
      return true;
    });
    assert.equal(await bws.count(), 1);
  } finally { await rm(bws.dir, { recursive: true, force: true }); }
});

test("a bws that cannot be started is named as such", async () => {
  vi.resetModules();
  const { runnerToken } = await import("../../src/lib/runner/runner-transport.ts");
  const dir = await mkdtemp(join(tmpdir(), "slipjay-nobws-"));
  try {
    await assert.rejects(runnerToken({ ...process.env, PATH: dir, SLIPJAY_RUNNER_TOKEN: "" }), /after 3 attempts \(bws could not be started\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
