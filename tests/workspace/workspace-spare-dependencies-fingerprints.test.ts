import { jj } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { BUN_VERSION, write, bunProject, counts } from "./fixtures/workspace-spare-dependencies-fixture.ts";

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

// A lifecycle script may really read a directory: copy it into node_modules, generate from it, or
// walk it. The fingerprint cannot see what a script does with a path it names, so a directory the
// script names stays a whole-tree input, and its contents count. Narrowing this to short-circuit a
// slow claim would let a stale node_modules be judged current, which costs more than the install.
test("a lifecycle script that reads a directory makes that directory's contents an install input", async () => {
  const f = await bunProject();
  try {
    const manifest = (fields: Record<string, unknown> = {}) => write(f.repo, {
      "package.json": JSON.stringify({
        name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*"],
        scripts: { postinstall: "node scripts/sync-templates.mjs" }, ...fields,
      }, null, 2),
    });
    await manifest();
    await write(f.repo, {
      "scripts/sync-templates.mjs": 'import { cpSync } from "node:fs";\ncpSync(new URL("../templates", import.meta.url), "node_modules/templates", { recursive: true });\n',
      "templates/greeting.txt": "hello\n",
    });
    const base = await installInputFingerprint(f.repo);
    assert.match(base ?? "", /^sha256:[0-9a-f]{64}$/);

    await write(f.repo, { "templates/greeting.txt": "goodbye\n" });
    const afterTemplate = await installInputFingerprint(f.repo);
    assert.ok(afterTemplate && afterTemplate !== base, "a file in the directory the script copies is an install input");

    await manifest({ version: "2.0.0", description: "release notes", keywords: ["fixture"] });
    assert.equal(await installInputFingerprint(f.repo), afterTemplate, "manifest metadata an install never reads is no input");
  } finally {
    await f.dispose();
  }
}, 120_000);
