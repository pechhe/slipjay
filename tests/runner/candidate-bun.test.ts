import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { candidateBun } from "../../src/lib/runner/candidate-bun.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";

let root: string;
let home: string;
let globalBin: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "candidate-bun-"));
  home = join(root, "runner");
  globalBin = join(root, "global");
  await mkdir(globalBin);
  await writeFile(join(globalBin, "bun"), `#!${process.execPath}\nconsole.log('1.2.2');\n`);
  await chmod(join(globalBin, "bun"), 0o755);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const environment = () => ({ ...process.env, PATH: globalBin });
async function candidate(name: string, packageManager: string) {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(join(path, "package.json"), JSON.stringify({ packageManager }));
  return path;
}
async function provision(version: string, reported = version) {
  const binary = join(home, "toolchains", "bun", version, "bin", "bun");
  await mkdir(dirname(binary), { recursive: true });
  // A fake executable isolates runtime selection from downloading real toolchains.
  await writeFile(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(reported)});\n`);
  await chmod(binary, 0o755);
  await symlink("bun", join(dirname(binary), "bunx"));
  return binary;
}

test("old and new candidate runtimes remain isolated, including nested bun lookup", async () => {
  const versions = ["1.2.3", "1.2.4"];
  const previousPath = process.env.PATH;
  const selections = await Promise.all(versions.map(async (version) => {
    const path = await candidate(version, `bun@${version}`);
    const binary = await provision(version);
    const selected = await candidateBun(path, environment(), home);
    assert.equal(selected.runtime?.version, version);
    assert.equal(selected.runtime?.sha256, createHash("sha256").update(await readFile(binary)).digest("hex"));
    const child = await runBoundedProcess({ executable: process.execPath, args: ["-e", "process.stdout.write(require('node:child_process').execFileSync('bun',['--version']))"],
      cwd: path, env: selected.environment, timeoutMs: 5_000, maxOutputBytes: 1024 });
    assert.equal(child.exitCode, 0, child.stderr);
    assert.equal(child.stdout.trim(), version);
    return selected.environment.PATH;
  }));
  assert.notEqual(selections[0], selections[1]);
  assert.equal(process.env.PATH, previousPath);
});

test("uses the global Bun only when it exactly matches the candidate pin", async () => {
  const path = await candidate("matching-global", "bun@1.2.2");
  const env = environment();
  const selected = await candidateBun(path, env, home);
  assert.equal(selected.runtime?.version, "1.2.2");
  assert.equal(selected.environment, env, "a matching global runtime must not reorder PATH");
  await assert.rejects(candidateBun(await candidate("missing", "bun@9.9.9"), environment(), home), /Bun 9.9.9 is not installed/);
});

test("refuses runtime directories that could shadow unrelated tools", async () => {
  const binary = await provision("1.2.7");
  await writeFile(join(dirname(binary), "node"), "unrelated tool");
  await assert.rejects(candidateBun(await candidate("shadowing", "bun@1.2.7"), environment(), home), /contains other tools/);
});

test("refuses a provisioned binary that reports another version", async () => {
  await provision("1.2.5", "1.2.6");
  await assert.rejects(candidateBun(await candidate("wrong-binary", "bun@1.2.5"), environment(), home), /Bun 1.2.5 is not installed/);
});

test("rejects malformed pins before deriving a toolchain path", async () => {
  for (const [index, pin] of ["bun@../outside", "bun@latest", "bun@^1.4.3"].entries())
    await assert.rejects(candidateBun(await candidate(`invalid-${index}`, pin), environment(), home), /requires an exact stable version/);
});

test("leaves other package managers and repositories without a manifest unchanged", async () => {
  const env = environment();
  assert.deepEqual(await candidateBun(await candidate("pnpm", "pnpm@12.14.0"), env, home), { environment: env });
  assert.deepEqual(await candidateBun(join(root, "absent"), env, home), { environment: env });
});


test("missing environment keeps runner-only variables out of private command defaults", async () => {
  const previous = process.env.SLIPJAY_RUNTIME_TEST_SECRET;
  process.env.SLIPJAY_RUNTIME_TEST_SECRET = "must-not-inherit";
  try {
    const selected = await candidateBun(await candidate("implicit-env", "pnpm@12.14.0"), undefined, home);
    assert.equal(selected.environment.SLIPJAY_RUNTIME_TEST_SECRET, undefined);
    assert.equal(selected.environment.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.SLIPJAY_RUNTIME_TEST_SECRET;
    else process.env.SLIPJAY_RUNTIME_TEST_SECRET = previous;
  }
});

test("invalid manifests reach their normal dependency or gate command without a runtime parse error", async () => {
  const path = join(root, "invalid-manifest");
  await mkdir(path);
  const env = environment();
  for (const source of ["{ malformed", "null", "42", "[]"]) {
    await writeFile(join(path, "package.json"), source);
    assert.deepEqual(await candidateBun(path, env, home), { environment: env });
  }
});
