import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, provisionSpare, readySpares, startSpareRefill } from "../src/lib/slipjay.ts";
import { listWorkspaces } from "../src/lib/workspace-state.ts";
import { metadataPath, workspaceMetadata } from "../src/lib/workspace-state.ts";
import { installInputFingerprint } from "../src/lib/install-inputs.ts";
import { withWorkspaceTransaction } from "../src/lib/workspace-transaction.ts";

const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

async function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** Commit the primary checkout's changes and advance the integration branch to them. */
function advance(repo: string, message: string) {
  jj(repo, ["commit", "-m", message]);
  jj(repo, ["bookmark", "set", "main", "-r", "@-"]);
}

/**
 * A Bun workspace project whose root `postinstall` runs a tracked script that
 * imports a sibling: each install appends a line to `installs.log`.
 */
async function bunProject(policy?: Record<string, unknown>) {
  const f = await project({ ignore: "node_modules\n", policy });
  const installs = join(f.root, "installs.log");
  process.env.FIXTURE_INSTALL_LOG = installs;
  await write(f.repo, {
    "package.json": JSON.stringify({
      name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*"],
      scripts: { postinstall: "node scripts/count-install.mjs" },
    }, null, 2),
    "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
    "scripts/count-install.mjs": 'import { record } from "./install-log.mjs";\nrecord();\n',
    "scripts/install-log.mjs": [
      'import { appendFileSync } from "node:fs";',
      "export function record() {",
      "  const delay = Number(process.env.FIXTURE_INSTALL_DELAY_MS) || 0;",
      "  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
      '  appendFileSync(process.env.FIXTURE_INSTALL_LOG, process.cwd() + "\\n");',
      "}",
      "",
    ].join("\n"),
    "scripts/unrelated.mjs": "export const unrelated = 1;\n",
  });
  execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
  advance(f.repo, "Add dependencies");
  await rm(installs, { force: true });
  const count = async () => (await readFile(installs, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { ...f, count };
}

async function spareName(repo: string) {
  const [spare] = await readySpares(repo);
  assert.ok(spare, "a prepared spare exists");
  return spare.name;
}

test("a claimed spare reuses its dependencies when the refresh leaves install inputs unchanged", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    assert.equal(await f.count(), 1);
    await write(f.repo, { "README.md": "changed\n", "scripts/unrelated.mjs": "export const unrelated = 2;\n" });
    advance(f.repo, "Change non-install files");

    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true);
    assert.deepEqual({ ...(created.readiness as object), installInputs: undefined },
      { state: "ready", packageManager: "bun", installInputs: undefined, reused: true });
    assert.equal(await f.count(), 1, "no install ran on claim");
    assert.ok(existsSync(join(created.workspacePath, "node_modules", ".bun")), "the provisioned node_modules is in place");
    assert.equal(await readFile(join(created.workspacePath, "README.md"), "utf8"), "changed\n", "the claim refreshed to the integration head");
    assert.equal((await workspaceMetadata(created.current.name))?.preparedDependencies, undefined);
  } finally {
    await f.dispose();
  }
}, 120_000);

const inputChanges: Array<[string, (repo: string) => Promise<void>]> = [
  ["a nested package.json", (repo) => write(repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", description: "d" }) })],
  ["the lockfile", async (repo) => {
    await write(repo, { "packages/y/package.json": JSON.stringify({ name: "y", version: "1.0.0", dependencies: { x: "workspace:*" } }) });
    execFileSync("bun", ["install"], { cwd: repo, stdio: "pipe" });
  }],
  ["a file the install lifecycle script imports", (repo) => write(repo, {
    "scripts/install-log.mjs": 'import { appendFileSync } from "node:fs";\nexport function record() { appendFileSync(process.env.FIXTURE_INSTALL_LOG, "v2\\n"); }\n',
  })],
];

for (const [label, change] of inputChanges) {
  test(`a claimed spare reinstalls when ${label} changed`, async () => {
    const f = await bunProject();
    try {
      await provisionSpare(f.repo);
      await change(f.repo);
      await rm(f.root + "/installs.log", { force: true });
      advance(f.repo, `Change ${label}`);

      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, true);
      assert.equal((created.readiness as { reused?: boolean }).reused, undefined);
      assert.equal(await f.count(), 1, "the claim installed");
    } finally {
      await f.dispose();
    }
  }, 120_000);
}

const unprovable: Array<[string, (name: string, workspacePath: string) => Promise<void>, boolean]> = [
  ["was prepared without recorded install inputs", async (name) => {
    const { preparedDependencies: _dropped, ...metadata } = (await workspaceMetadata(name)) ?? {};
    await writeFile(metadataPath(name), JSON.stringify(metadata));
  }, true],
  ["lost its node_modules", (_name, workspacePath) => rm(join(workspacePath, "node_modules"), { recursive: true, force: true }), true],
  ["is not marked prepared", async (name) => {
    await writeFile(metadataPath(name), JSON.stringify({ ...await workspaceMetadata(name), prepared: false }));
  }, false],
];

for (const [label, degrade, claimable] of unprovable) {
  test(`a spare that ${label} is never handed out without installing`, async () => {
    const f = await bunProject();
    try {
      await provisionSpare(f.repo);
      const [spare] = await readySpares(f.repo);
      await degrade(await spareName(f.repo), spare!.root!);
      await rm(f.root + "/installs.log", { force: true });

      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, claimable);
      assert.equal((created.readiness as { reused?: boolean }).reused, undefined);
      assert.equal(await f.count(), 1, "the assignment installed");
      assert.ok(existsSync(join(created.workspacePath, "node_modules", ".bun")));
    } finally {
      await f.dispose();
    }
  }, 120_000);
}

test("a host readiness hook decides for itself even when the spare is reusable", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const calls: string[] = [];
    const created = await createWorkspace("task", f.repo, { hooks: { prepare: async (_root, path) => { calls.push(path); return "host"; } } });
    assert.equal(created.pooled, true);
    assert.deepEqual(calls, [created.workspacePath]);
    assert.equal(created.readiness, "host");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the install-input fingerprint covers lockfiles, manifests, package-manager config and patches only", async () => {
  const f = await bunProject();
  try {
    const base = await installInputFingerprint(f.repo);
    assert.match(base ?? "", /^sha256:[0-9a-f]{64}$/);
    await write(f.repo, { "README.md": "other\n", "src/app.ts": "export {};\n" });
    assert.equal(await installInputFingerprint(f.repo), base, "unrelated files do not change it");
    const inputs = ["bun.lock", "bunfig.toml", ".npmrc", "patches/x.patch", "packages/x/package.json", "scripts/count-install.mjs"];
    let previous = base;
    for (const path of inputs) {
      const current = await readFile(join(f.repo, path), "utf8").catch(() => "");
      await write(f.repo, { [path]: `${current}\n` });
      const next = await installInputFingerprint(f.repo);
      assert.ok(next && next !== previous, `${path} is an install input`);
      previous = next;
    }
    assert.equal(await installInputFingerprint(join(f.root, "not-a-repo")), null);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the install-input fingerprint is computable on a host without Node", async () => {
  const f = await bunProject();
  const path = process.env.PATH;
  try {
    // Only the tools SlipJay itself runs: no `node` on PATH.
    const bin = join(f.root, "bin-without-node");
    await mkdir(bin);
    for (const tool of ["bun", "jj", "git"]) {
      // An exec shim, not a symlink: a tool may be a wrapper that finds its binary beside itself.
      const real = execFileSync("which", [tool], { encoding: "utf8" }).trim();
      await writeFile(join(bin, tool), `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
    }
    // System directories stay, for tool wrappers' own shell needs, unless they hold a Node.
    process.env.PATH = [bin, ...["/usr/bin", "/bin"].filter((dir) => !existsSync(join(dir, "node")))].join(":");
    const withoutNode = await installInputFingerprint(f.repo);
    assert.match(withoutNode ?? "", /^sha256:[0-9a-f]{64}$/);
    process.env.PATH = path;
    assert.notEqual(await installInputFingerprint(f.repo), withoutNode, "the Node version is an install input when Node is present");
  } finally {
    process.env.PATH = path;
    await f.dispose();
  }
}, 120_000);

test("the install-input fingerprint follows file: dependencies, patch paths, lifecycle flags and the install environment", async () => {
  const f = await bunProject();
  try {
    await write(f.repo, {
      "packages/v/package.json": JSON.stringify({
        name: "v", version: "1.0.0", dependencies: { foo: "file:../../vendor/foo" }, patchedDependencies: { "x@1.0.0": "tools/x.patch" },
        scripts: { prepare: "node --import=./register.mjs run.mjs" },
      }),
      "packages/v/tools/x.patch": "patch\n",
      "packages/v/register.mjs": "export {};\n",
      "packages/v/run.mjs": "export {};\n",
      "vendor/foo/package.json": JSON.stringify({ name: "foo", version: "1.0.0" }),
      "vendor/foo/index.js": "module.exports = 1;\n",
    });
    let previous = await installInputFingerprint(f.repo);
    assert.ok(previous);
    for (const path of ["vendor/foo/index.js", "packages/v/tools/x.patch", "packages/v/register.mjs"]) {
      await write(f.repo, { [path]: `${await readFile(join(f.repo, path), "utf8")}// changed\n` });
      const next = await installInputFingerprint(f.repo);
      assert.ok(next && next !== previous, `${path} is an install input`);
      previous = next;
    }
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.notEqual(await installInputFingerprint(f.repo), previous, "NODE_ENV changes what an install produces");
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
    await write(f.repo, { "packages/w/package.json": JSON.stringify({ name: "w", scripts: { prepare: "bun run --filter '*' build" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a lifecycle script running other packages is not followed");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a claim that cannot take the pool in time installs a fresh workspace instead of waiting", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = () => {};
    const acquired = new Promise<void>((resolve) => { holding = resolve; });
    const provisioning = withWorkspaceTransaction(`pool:${f.repo}`, async () => { holding(); await held; });
    await acquired;
    try {
      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, false);
      assert.equal(await f.count(), 2, "the fresh workspace installed");
      assert.equal((await readySpares(f.repo)).length, 1, "the spare was left alone");
    } finally {
      release();
      await provisioning;
    }
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a spare refill runs detached and niced without blocking its caller", async () => {
  const f = await bunProject();
  process.env.FIXTURE_INSTALL_DELAY_MS = "8000";
  try {
    const startedAt = Date.now();
    const result = await startSpareRefill(f.repo);
    assert.ok(Date.now() - startedAt < 8_000, "returns before the provisioning install could finish");
    assert.equal(result.started, true);
    assert.equal(await readySpares(f.repo).then((spares) => spares.length), 0, "the spare is still being prepared");
    const [pgid, nice] = execFileSync("ps", ["-o", "pgid=,nice=", "-p", String(result.pid)], { encoding: "utf8" }).trim().split(/\s+/);
    assert.equal(Number(pgid), result.pid, "the child leads its own process group");
    assert.equal(Number(nice), 10);

    const deadline = Date.now() + 90_000;
    while ((await readySpares(f.repo)).length === 0) {
      assert.ok(Date.now() < deadline, "the refill prepared a spare");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const until = Date.now() + 10_000;
    let log = "";
    while (!/"provisioned":true/.test(log)) {
      assert.ok(Date.now() < until, `the refill logged its outcome: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      log = await readFile(result.logPath!, "utf8").catch(() => "");
    }
    assert.equal(await f.count(), 1);
    const metadata = await workspaceMetadata(await spareName(f.repo));
    const prepared = metadata?.preparedDependencies as { installInputs?: string } | undefined;
    assert.match(String(prepared?.installInputs), /^sha256:/);
  } finally {
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 120_000);

test("concurrent starts prepare their checkouts outside the allocation lock", async () => {
  const f = await project();
  try {
    // Each readiness waits until both are underway: serialized preparation would never get there.
    const entered: string[] = [];
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    const prepare = async (_root: string, path: string) => {
      entered.push(path);
      if (entered.length === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const serialized = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("preparation was serialized")), 20_000); });
      try { await Promise.race([bothEntered, serialized]); } finally { clearTimeout(timer); }
      return "host";
    };
    const [first, second] = await Promise.all([
      createWorkspace("first", f.repo, { hooks: { prepare } }),
      createWorkspace("second", f.repo, { hooks: { prepare } }),
    ]);
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.deepEqual([...entered].sort(), [first.workspacePath, second.workspacePath].sort());
  } finally {
    await f.dispose();
  }
}, 120_000);

test("concurrent starts of one Issue prepare its checkout one at a time", async () => {
  const f = await project();
  try {
    let active = 0;
    let overlapped = false;
    const prepare = async () => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      active -= 1;
      return "host";
    };
    const [first, second] = await Promise.all([
      createWorkspace("Issue #96601", f.repo, { issueNumber: 96601, hooks: { prepare } }),
      createWorkspace("Issue #96601", f.repo, { issueNumber: 96601, hooks: { prepare } }),
    ]);
    assert.equal(first.workspacePath, second.workspacePath);
    assert.equal(overlapped, false, "two preparations ran in one checkout at once");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the pool keeps as many spares as declared, counting those still being prepared", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    const [first, second] = await Promise.all([provisionSpare(f.repo), provisionSpare(f.repo)]);
    assert.deepEqual([first.provisioned, second.provisioned], [true, true]);
    assert.notEqual(first.name, second.name, "concurrent refills prepare different spares");
    assert.equal((await readySpares(f.repo)).length, 2);
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "spare-exists" });
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a pool of none provisions nothing", async () => {
  const f = await bunProject({ spares: 0 });
  try {
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "pool-disabled" });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a claim during an in-flight refill takes a ready spare and leaves the one being prepared", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    const [ready] = [await provisionSpare(f.repo)];
    assert.equal(ready.provisioned, true);
    process.env.FIXTURE_INSTALL_DELAY_MS = "6000";
    const refill = provisionSpare(f.repo);
    const deadline = Date.now() + 60_000;
    let inFlight: string | undefined;
    while (!inFlight) {
      assert.ok(Date.now() < deadline, "the second spare registered");
      inFlight = (await listWorkspaces(f.repo)).find((workspace) => workspace.metadata?.spare === true && workspace.metadata?.prepared === false)?.name;
      if (!inFlight) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true, "the claim did not install synchronously");
    assert.equal(created.workspacePath, ready.workspacePath, "it took the ready spare");
    assert.ok((await listWorkspaces(f.repo)).some((workspace) => workspace.name === inFlight), "the spare being prepared was left alone");
    const finished = await refill;
    assert.equal(finished.provisioned, true);
    assert.deepEqual((await readySpares(f.repo)).map((spare) => spare.name), [inFlight]);
  } finally {
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 180_000);

test("a refill adopts a spare whose preparer died and finishes it", async () => {
  const f = await bunProject();
  try {
    const first = await provisionSpare(f.repo);
    const [spare] = await readySpares(f.repo);
    await writeFile(metadataPath(spare!.name), JSON.stringify({ ...await workspaceMetadata(spare!.name), prepared: false, preparingPid: 2 ** 22 + 1 }));
    assert.equal((await readySpares(f.repo)).length, 0);
    const adopted = await provisionSpare(f.repo);
    assert.deepEqual([adopted.provisioned, adopted.name], [true, first.name]);
    assert.equal((await readySpares(f.repo)).length, 1);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("an install with no spare to claim clones node_modules from the primary checkout, then verifies it", async () => {
  const f = await bunProject();
  try {
    const created = await createWorkspace("seeded", f.repo);
    assert.equal(created.pooled, false);
    assert.equal((created.readiness as { seeded?: boolean }).seeded, true, "the primary's install inputs matched, so its node_modules seeded this one");
    assert.equal(await f.count(), 1, "the verifying install ran");
    const modules = join(created.workspacePath, "node_modules");
    assert.ok(existsSync(join(modules, ".bun")), "the cloned tree is in place");
    for (const entry of await readdir(modules)) {
      const path = join(modules, entry);
      if (!lstatSync(path).isSymbolicLink()) continue;
      assert.ok(!readlinkSync(path).startsWith("/"), `${entry} is a relative link, so it resolves inside the new checkout`);
      assert.ok(existsSync(path), `${entry} resolves`);
    }
  } finally {
    await f.dispose();
  }
}, 180_000);
