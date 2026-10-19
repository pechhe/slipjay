import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, provisionSpare, readySpares, refillPool, refreshSpares, spareAllowance, startSpareRefill, sweepDisposableWorkspaces } from "../../src/lib/slipjay.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { machineConfigPath } from "../../src/lib/workspace/workspace-paths.ts";
import { setMachineSpareLimit } from "../../src/lib/policy/machine-config.ts";
import { listWorkspaces } from "../../src/lib/workspace/workspace-state.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";

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
      "  const start = Date.now();",
      '  if (process.env.FIXTURE_INSTALL_STARTED) appendFileSync(process.env.FIXTURE_INSTALL_STARTED, process.cwd() + "\\n");',
      "  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
      '  appendFileSync(process.env.FIXTURE_INSTALL_LOG, process.cwd() + "\\n");',
      '  if (process.env.FIXTURE_INSTALL_SPANS) appendFileSync(process.env.FIXTURE_INSTALL_SPANS, JSON.stringify([start, Date.now()]) + "\\n");',
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
    await write(f.repo, {
      "README.md": "changed\n", "scripts/unrelated.mjs": "export const unrelated = 2;\n",
      // A release: version bumps, a new export and a new test script, none of which an install reads.
      "packages/x/package.json": JSON.stringify({ name: "x", version: "1.1.0", exports: { ".": "./index.ts" }, scripts: { test: "bun test" } }),
    });
    advance(f.repo, "Change non-install files");

    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true);
    assert.deepEqual({ ...(created.readiness as object), installInputs: undefined },
      { state: "ready", packageManager: "bun", installInputs: undefined, reused: true });
    assert.equal(await f.count(), 1, "no install ran on claim");
    assert.ok(existsSync(join(created.workspacePath, "node_modules", ".bun")), "the provisioned node_modules is in place");
    assert.equal(await readFile(join(created.workspacePath, "README.md"), "utf8"), "changed\n", "the claim refreshed to the integration head");
    const recorded = (await workspaceMetadata(created.current.name))?.preparedDependencies as { installInputs?: string } | undefined;
    assert.equal(recorded?.installInputs, await installInputFingerprint(created.workspacePath), "the claimed workspace records its install inputs, so it can seed others");
  } finally {
    await f.dispose();
  }
}, 120_000);

const inputChanges: Array<[string, (repo: string) => Promise<void>]> = [
  ["a nested package.json's install fields", (repo) => write(repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) })],
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
    const inputs = ["bun.lock", "bunfig.toml", ".npmrc", "patches/x.patch", "scripts/count-install.mjs"];
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

test("a manifest counts by what an install reads of it, not by its metadata or the scripts an install never runs", async () => {
  const f = await bunProject();
  try {
    const fingerprint = () => installInputFingerprint(f.repo);
    const root = (fields: Record<string, unknown>) => write(f.repo, {
      "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*"], ...fields }, null, 2),
    });
    const member = (fields: Record<string, unknown>) => write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", ...fields }) });
    await root({ scripts: { postinstall: "bun run prepare:generated", "prepare:generated": "node scripts/count-install.mjs" } });
    let previous = await fingerprint();
    assert.ok(previous);

    await root({
      version: "2.0.0", description: "release", exports: { ".": "./src/index.ts" },
      scripts: { postinstall: "bun run prepare:generated", "prepare:generated": "node scripts/count-install.mjs", test: "bun test" },
    });
    await member({ version: "1.1.0", types: "./index.d.ts", files: ["dist"], scripts: { build: "tsc" } });
    assert.equal(await fingerprint(), previous, "metadata, exports and scripts outside the install lifecycle are no input");

    const installChanges: Array<[string, () => Promise<void>]> = [
      ["a script the lifecycle runs", () => root({ scripts: { postinstall: "bun run prepare:generated", "prepare:generated": "node scripts/count-install.mjs --quiet" } })],
      ["a member's dependencies", () => member({ dependencies: { left: "1.0.0" } })],
      ["a member's lifecycle script", () => member({ dependencies: { left: "1.0.0" }, scripts: { postinstall: "node scripts/count-install.mjs" } })],
      ["a member's bin", () => member({ dependencies: { left: "1.0.0" }, scripts: { postinstall: "node scripts/count-install.mjs" }, bin: { x: "x.js" } })],
      ["the pre hook of a script the lifecycle runs", () => root({ scripts: {
        postinstall: "bun run prepare:generated", "prepare:generated": "node scripts/count-install.mjs --quiet", "preprepare:generated": "node scripts/unrelated.mjs",
      } })],
    ];
    for (const [label, change] of installChanges) {
      await change();
      const next = await fingerprint();
      assert.ok(next && next !== previous, `${label} is an install input`);
      previous = next;
    }

    // A lifecycle script that reads its package's manifest makes the whole manifest an input.
    await write(f.repo, { "packages/x/stamp.mjs": 'import { readFileSync } from "node:fs";\nreadFileSync(new URL("./package.json", import.meta.url));\n' });
    await member({ scripts: { postinstall: "node stamp.mjs" } });
    previous = await fingerprint();
    assert.ok(previous);
    await member({ version: "1.2.0", scripts: { postinstall: "node stamp.mjs" } });
    assert.notEqual(await fingerprint(), previous, "a version the lifecycle reads is an install input");
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
    // The system tools stay, for tool wrappers' own shell needs (vite-plus's `bun` runs sed,
    // dirname and uname), but not a Node among them: on Linux it sits in /usr/bin beside them.
    const linked = new Set(await readdir(bin));
    for (const dir of ["/usr/bin", "/bin"]) {
      for (const tool of await readdir(dir)) {
        if (/^node(js)?$/.test(tool) || linked.has(tool)) continue;
        linked.add(tool);
        await symlink(join(dir, tool), join(bin, tool));
      }
    }
    process.env.PATH = bin;
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

test("lifecycle scripts of manifests outside the install's workspaces are no input, and are still hashed", async () => {
  const f = await bunProject();
  try {
    await write(f.repo, { ".repos/vendored/package.json": JSON.stringify({ name: "vendored", scripts: { prepare: "turbo run build --filter=a" } }) });
    const withVendored = await installInputFingerprint(f.repo);
    assert.ok(withVendored, "a vendored manifest outside `workspaces` does not refuse the fingerprint");
    await write(f.repo, { ".repos/vendored/package.json": JSON.stringify({ name: "vendored", version: "2.0.0" }) });
    assert.notEqual(await installInputFingerprint(f.repo), withVendored, "its manifest still counts as an install input");

    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { prepare: "turbo run build --filter=a" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a declared workspace member is still judged");
    await write(f.repo, { "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*", "!packages/x"] }) });
    assert.ok(await installInputFingerprint(f.repo), "a negated pattern leaves the member out");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a workspace list that is not read exactly is never trusted to leave a manifest out", async () => {
  const f = await project({ ignore: "node_modules\n" });
  try {
    const judged = JSON.stringify({ name: "t", scripts: { prepare: "turbo run build --filter=a" } });
    const manifest = (workspaces: unknown) => JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, ...(workspaces ? { workspaces } : {}) });
    const outcome = async (files: Record<string, string>) => { await write(f.repo, files); return await installInputFingerprint(f.repo); };

    assert.equal(await outcome({ "package.json": manifest(["packages/**/foo"]), "packages/foo/package.json": judged }), null, "`**` also matches no directory levels");
    await rm(join(f.repo, "packages"), { recursive: true });
    assert.ok(await outcome({ "package.json": manifest(["packages/**/foo"]), "packages/a/package.json": judged }), "a manifest the pattern cannot reach is left out");
    await rm(join(f.repo, "packages"), { recursive: true });
    assert.equal(await outcome({ "package.json": manifest(["packages/{a,b}"]), "other/package.json": judged }), null, "an unsupported pattern judges every manifest");
    assert.equal(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - >-\n    other\n" }), null, "an unsupported YAML form judges every manifest");
    assert.equal(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages: [apps/*]\n" }), null, "an inline YAML list judges every manifest");
    assert.ok(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - 'tools' # note\n\nallowBuilds:\n  x: true\n" }), "a plain list is read exactly");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a pnpm workspace's package list decides which manifests an install runs scripts for", async () => {
  const f = await project({ ignore: "node_modules\n" });
  try {
    await write(f.repo, {
      "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}` }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - 'tools'  # quoted\n\nallowBuilds:\n  x: true\n",
      ".repos/vendored/package.json": JSON.stringify({ name: "vendored", scripts: { prepare: "turbo run build --filter=a" } }),
      "apps/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
    });
    jj(f.repo, ["file", "track", "."]);
    assert.ok(await installInputFingerprint(f.repo), "a vendored manifest outside the package list is not judged");
    await write(f.repo, { "tools/package.json": JSON.stringify({ name: "tools", scripts: { prepare: "turbo run build --filter=a" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a listed package is judged");
    await write(f.repo, { "pnpm-workspace.yaml": "allowBuilds:\n  x: true\n" });
    assert.equal(await installInputFingerprint(f.repo), null, "with no package list every manifest is judged");
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

/** Set this machine's spare limits (~/.slipjay/config.json) for the duration of `body`. */
async function withMachineSpares<T>(spares: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(machineConfigPath()), { recursive: true });
  await writeFile(machineConfigPath(), JSON.stringify({ spares }));
  try { return await body(); } finally { await rm(machineConfigPath(), { force: true }); }
}

/** An allowance without its source, for tests about counts. */
const counts = ({ source: _source, ...allowance }: Awaited<ReturnType<typeof spareAllowance>>) => allowance;

const refill = async (repo: string) => {
  const outcomes: object[] = [];
  await refillPool(repo, (outcome) => outcomes.push(outcome));
  return outcomes;
};

test("this machine's limit lowers a repository's declared spares, never raises them, and 0 disables the pool here", async () => {
  const f = await bunProject({ spares: 8 });
  try {
    const context = (await workspaceContext(f.repo))!;
    await withMachineSpares({ [f.repo]: 3 }, async () => {
      await refill(f.repo);
      assert.equal((await readySpares(f.repo)).length, 3, "the pool stops at the machine's limit");
    });
    await withMachineSpares({ [f.repo]: 2 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 2, declared: 8, machineLimit: 2 });
      const outcomes = await refill(f.repo);
      assert.equal(outcomes.filter((outcome) => "retired" in outcome).length, 1, "lowering the limit retires the excess spare");
      assert.equal((await readySpares(f.repo)).length, 2);
      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, true, "a claim still takes a ready spare");
    });
    await withMachineSpares({ [f.repo]: 0 }, async () => {
      assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "pool-disabled" });
    });
    await withMachineSpares({ "/elsewhere/other": 0 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 8, declared: 8, machineLimit: null }, "another checkout's limit does not apply");
    });
  } finally {
    await f.dispose();
  }
  const g = await bunProject({ spares: 1 });
  try {
    const context = (await workspaceContext(g.repo))!;
    await withMachineSpares({ [g.repo]: 3 }, async () => {
      assert.deepEqual(counts(await spareAllowance(context)), { spares: 1, declared: 1, machineLimit: 3 });
    });
    await withMachineSpares({ [g.repo]: 9 }, async () => {
      await assert.rejects(spareAllowance(context), /spares must be an integer from 0 to 8/);
    });
    await withMachineSpares([] as unknown as Record<string, unknown>, async () => {
      await assert.rejects(spareAllowance(context), /must map integration checkout paths to spare counts/);
    });
  } finally {
    await g.dispose();
  }
}, 240_000);

test("after an install-input change, a refill refreshes stale spares with one install and clones the rest", async () => {
  const f = await bunProject({ spares: 3 });
  try {
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 3);
    await write(f.repo, { "README.md": "changed\n" });
    advance(f.repo, "Change non-install files");
    const unchanged = await f.count();
    assert.deepEqual((await refreshSpares(f.repo)).map((spare) => spare.dependencies), ["reused", "reused", "reused"]);
    assert.equal(await f.count(), unchanged, "nothing installed when install inputs are unchanged");
    assert.deepEqual(await refreshSpares(f.repo), [], "spares already on the integration head are left alone");

    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    // No checkout has the new inputs installed, so the first refresh must install.
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    const before = await f.count();
    const refreshed = await refreshSpares(f.repo);
    assert.deepEqual(refreshed.map((spare) => spare.dependencies), ["installed", "seeded", "seeded"], "one install, then clones of it");
    assert.equal(await f.count(), before + 3, "each clone was verified by the frozen install");
    const spares = await readySpares(f.repo);
    assert.equal(spares.length, 3, "every spare is ready again");
    for (const spare of spares) {
      const inputs = (spare.metadata?.preparedDependencies as { installInputs?: string } | undefined)?.installInputs;
      assert.equal(inputs, await installInputFingerprint(spare.root), `${spare.name} recorded its current install inputs`);
      assert.match(await readFile(join(spare.root, "packages/x/package.json"), "utf8"), /"engines"/, `${spare.name} is on the integration head`);
    }

    // A claim of a stale spare installs in place, and the refill then clones that claim's install.
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=20" } }) });
    advance(f.repo, "Change an install input again");
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true);
    assert.equal((created.readiness as { seeded?: boolean }).seeded, undefined, "no checkout had the new inputs, so the claim installed");
    assert.deepEqual((await refreshSpares(f.repo)).map((spare) => spare.dependencies), ["seeded", "seeded"], "the remaining spares cloned the claim's install");
  } finally {
    await f.dispose();
  }
}, 300_000);

test("a spare on the integration head whose recorded install inputs are stale is refreshed, then claimed without installing", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const name = await spareName(f.repo);
    // As after a fingerprint format change or a package-manager upgrade: the spare is current, its record is not.
    const metadata = (await workspaceMetadata(name))!;
    await writeFile(metadataPath(name), JSON.stringify({ ...metadata, preparedDependencies: { ...metadata.preparedDependencies as object, installInputs: "sha256:stale" } }));

    assert.deepEqual((await refreshSpares(f.repo)).map((spare) => spare.name), [name], "the stale record is refreshed although the spare is on the head");
    const [spare] = await readySpares(f.repo);
    assert.equal((spare!.metadata?.preparedDependencies as { installInputs?: string }).installInputs, await installInputFingerprint(spare!.root));
    assert.deepEqual(await refreshSpares(f.repo), [], "a current record is left alone");

    const before = await f.count();
    const created = await createWorkspace("task", f.repo);
    assert.equal((created.readiness as { reused?: boolean }).reused, true, "the claim reuses the refreshed dependencies");
    assert.equal(await f.count(), before, "no install ran on claim");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("refills of two repositories install one after the other, and a claim never waits for them", async () => {
  const a = await bunProject({ spares: 2 });
  const b = await bunProject({ spares: 1 });
  const spans = join(a.root, "spans.jsonl");
  try {
    await provisionSpare(a.repo);
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_DELAY_MS = "3000";
    const refills = Promise.all([refill(a.repo), refill(b.repo)]);
    const claimedAt = Date.now();
    const created = await createWorkspace("task", a.repo);
    assert.equal(created.pooled, true, "the claim took the ready spare");
    assert.ok(Date.now() - claimedAt < 3_000, "the claim did not wait for a refill's install");
    await refills;
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.ok(installs.length >= 2, `both repositories installed: ${installs.length}`);
    for (let index = 1; index < installs.length; index += 1) {
      assert.ok(installs[index]![0] >= installs[index - 1]![1], `installs did not overlap: ${JSON.stringify(installs)}`);
    }
  } finally {
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await a.dispose();
    await b.dispose();
  }
}, 300_000);

test("a claim that must install never waits for a refill's install", async () => {
  const f = await bunProject({ spares: 2 });
  const spans = join(f.root, "spans.jsonl");
  const started = join(f.root, "started.log");
  try {
    await refill(f.repo);
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_STARTED = started;
    process.env.FIXTURE_INSTALL_DELAY_MS = "4000";
    // The refill refreshes one stale spare at a time; claim the other once its install is under way.
    const refilling = refill(f.repo);
    while (!(await readFile(started, "utf8").catch(() => ""))) await new Promise((done) => setTimeout(done, 25));
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true, "the claim took the spare the refill had not reserved");
    await refilling;
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.ok(installs.length >= 2, `the refill and the claim both installed: ${JSON.stringify(installs)}`);
    assert.ok(installs[1]![0] < installs[0]![1], `the claim's install ran beside the refill's: ${JSON.stringify(installs)}`);
  } finally {
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_STARTED;
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 300_000);

test("concurrent claims of stale spares install one at a time, and the later one clones the earlier install", async () => {
  const f = await bunProject({ spares: 2 });
  const spans = join(f.root, "spans.jsonl");
  try {
    await refill(f.repo);
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_DELAY_MS = "2000";
    const claims = await Promise.all([createWorkspace("first", f.repo), createWorkspace("second", f.repo)]);
    assert.deepEqual(claims.map((claim) => claim.pooled), [true, true]);
    assert.deepEqual(claims.map((claim) => Boolean((claim.readiness as { seeded?: boolean }).seeded)).sort(), [false, true],
      "one claim installed and the other cloned it");
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.equal(installs.length, 2);
    assert.ok(installs[1]![0] >= installs[0]![1], `the installs did not overlap: ${JSON.stringify(installs)}`);
  } finally {
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 300_000);

test("the allowance comes from the integration bookmark's committed policy, never the checkout's working files", async () => {
  const f = await bunProject({ spares: 3 });
  const main = () => jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]).trim();
  const setSpares = async (spares: number) => {
    const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
    await writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ ...policy, spares }));
  };
  try {
    await setSpares(1);
    const allowance = await spareAllowance((await workspaceContext(f.repo))!);
    assert.deepEqual(allowance, { spares: 3, declared: 3, machineLimit: null, source: { integrationBranch: "main", commitId: main() } },
      "an uncommitted edit in the primary checkout does not change the allowance");
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 3);
    await setSpares(2);
    advance(f.repo, "Lower spares");
    const lowered = await spareAllowance((await workspaceContext(f.repo))!);
    assert.deepEqual(lowered.source, { integrationBranch: "main", commitId: main() }, "the source names the commit read");
    assert.equal(lowered.declared, 2);
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 2, "the pool never exceeds the allowance");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("retiring assigned workspaces leaves the pool at its allowance, and old checkout paths still count", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    await refill(f.repo);
    const claimed = await createWorkspace("task", f.repo);
    assert.equal(claimed.pooled, true);
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 2);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000, issueClosed: () => null });
    assert.deepEqual(swept.removed, [claimed.current.name], "the idle assigned workspace retires");
    assert.equal((await readySpares(f.repo)).length, 2, "retiring it takes no spare");

    // A limit keyed by another spelling of the checkout's path, such as a symlink, still applies.
    const alias = join(f.root, "alias");
    await symlink(f.repo, alias);
    await withMachineSpares({ [alias]: 1 }, async () => {
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).machineLimit, 1);
      // Setting or clearing the limit replaces every spelling of the checkout's path.
      await setMachineSpareLimit(f.repo, 0);
      assert.deepEqual(JSON.parse(await readFile(machineConfigPath(), "utf8")).spares, { [await realpath(f.repo)]: 0 });
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).spares, 0);
      await setMachineSpareLimit(alias, null);
      assert.equal((await spareAllowance((await workspaceContext(f.repo))!)).machineLimit, null);
    });
    // A spare recorded under the checkout's old path is still one of this repository's.
    const [spare] = await readySpares(f.repo);
    await writeFile(metadataPath(spare!.name), JSON.stringify({ ...await workspaceMetadata(spare!.name), integrationRoot: join(f.root, "old-checkout") }));
    assert.deepEqual(await provisionSpare(f.repo), { provisioned: false, reason: "spare-exists" }, "the moved spare counts against the allowance");
  } finally {
    await f.dispose();
  }
}, 240_000);
