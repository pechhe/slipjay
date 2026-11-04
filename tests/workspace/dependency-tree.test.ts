import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { dependencyTreeDamage } from "../../src/lib/workspace/dependency-tree.ts";
import { installedTreeDamage } from "../../src/lib/workspace/workspace-dependencies.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { provisionSpare, readySpares, repairDamagedSpares } from "../../src/lib/workspace/workspace-pool.ts";
import { bunProject, spareName } from "./fixtures/workspace-spare-dependencies-fixture.ts";

async function pkg(dir: string, manifest: object | string = { name: "p", version: "1.0.0" }) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

async function scratch<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dependency-tree-"));
  try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("healthy pnpm, hoisted, scoped, metadata-only and workspace-link layouts have no damage", async () => {
  await scratch(async (root) => {
    const modules = join(root, "node_modules");
    // pnpm: top-level links into the virtual store; a package with no root index file; a scoped, peer-suffixed entry.
    await pkg(join(modules, ".pnpm/vfile@6.0.3/node_modules/vfile"));
    await pkg(join(modules, ".pnpm/@types+node@22.0.0_x@1.0.0/node_modules/@types/node"), { name: "@types/node", types: "index.d.ts" });
    await symlink(".pnpm/vfile@6.0.3/node_modules/vfile", join(modules, "vfile"));
    // a store entry links to the entries of its dependencies, and a workspace package to the store.
    await pkg(join(modules, ".pnpm/unified@11.0.5/node_modules/unified"));
    await symlink("../../vfile@6.0.3/node_modules/vfile", join(modules, ".pnpm/unified@11.0.5/node_modules/vfile"));
    await mkdir(join(root, "packages/lib/node_modules"), { recursive: true });
    await symlink("../../../node_modules/.pnpm/unified@11.0.5/node_modules/unified", join(root, "packages/lib/node_modules/unified"));
    // hoisted: a plain, a scoped and a nested package, and a workspace link.
    await pkg(join(modules, "plain"));
    await pkg(join(modules, "@scope/scoped"));
    await pkg(join(modules, "plain/node_modules/nested"));
    await mkdir(join(root, "packages/app"), { recursive: true });
    await symlink("../packages/app", join(modules, "app"));
    await mkdir(join(modules, ".bin"), { recursive: true });
    await writeFile(join(modules, ".pnpm/lock.yaml"), "lockfileVersion: 9\n");
    assert.equal(await dependencyTreeDamage(root, ["package.json", "packages/lib/package.json"]), null);
  });
});

test("a package directory without a usable manifest is damage, in every layout", async () => {
  await scratch(async (root) => {
    const modules = join(root, "node_modules");
    // As found: the virtual-store entry kept lib/, a licence and an empty readme but lost its manifest.
    await mkdir(join(modules, ".pnpm/vfile@6.0.3/node_modules/vfile/lib"), { recursive: true });
    await writeFile(join(modules, ".pnpm/vfile@6.0.3/node_modules/vfile/readme.md"), "");
    await pkg(join(modules, ".pnpm/ok@1.0.0/node_modules/ok"));
    await mkdir(join(modules, "hoisted/lib"), { recursive: true });
    await pkg(join(modules, "empty"), "");
    await pkg(join(modules, "corrupt"), "{ not json");
    await pkg(join(modules, "@scope/scoped"), "[]");
    await pkg(join(modules, "fine/node_modules/nested"), "");
    await pkg(join(modules, "fine"));
    const damage = await dependencyTreeDamage(root, ["package.json"]);
    assert.ok(damage);
    assert.deepEqual(damage.paths.map((path) => path.slice(modules.length + 1)).sort(), [
      ".pnpm/vfile@6.0.3/node_modules/vfile/package.json", "@scope/scoped/package.json", "corrupt/package.json",
      "empty/package.json", "fine/node_modules/nested/package.json", "hoisted/package.json",
    ].sort());
  });
});

test("a link into a virtual store whose entry is gone is damage; a stale link elsewhere is not", async () => {
  await scratch(async (root) => {
    const modules = join(root, "node_modules");
    await mkdir(join(modules, ".pnpm"), { recursive: true });
    await symlink(".pnpm/gone@1.0.0/node_modules/gone", join(modules, "gone"));
    await symlink("../elsewhere", join(modules, "elsewhere"));
    const damage = await dependencyTreeDamage(root, ["package.json"]);
    assert.deepEqual(damage?.paths, [join(modules, "gone")]);
  });
});

test("a dependency whose store entry is gone is damage found through its consumer's link, in the store and in a workspace package", async () => {
  await scratch(async (root) => {
    const modules = join(root, "node_modules");
    // vfile's directory was deleted outright, so there is no package left to lack a manifest.
    await pkg(join(modules, ".pnpm/unified@11.0.5/node_modules/unified"));
    await symlink("../../vfile@6.0.3/node_modules/vfile", join(modules, ".pnpm/unified@11.0.5/node_modules/vfile"));
    await mkdir(join(root, "packages/lib/node_modules"), { recursive: true });
    await symlink("../../../node_modules/.pnpm/gone@1.0.0/node_modules/gone", join(root, "packages/lib/node_modules/gone"));
    const damage = await dependencyTreeDamage(root, ["package.json", "packages/lib/package.json"]);
    assert.deepEqual(damage?.paths.map((path) => path.slice(root.length + 1)).sort(),
      ["node_modules/.pnpm/unified@11.0.5/node_modules/vfile", "packages/lib/node_modules/gone"]);
  });
});

test("a directory that cannot be read is reported, not taken as empty", async () => {
  await scratch(async (root) => {
    const modules = join(root, "node_modules");
    await pkg(join(modules, ".pnpm/locked@1.0.0/node_modules/locked"));
    await chmod(join(modules, ".pnpm/locked@1.0.0/node_modules"), 0o000);
    try {
      const damage = await dependencyTreeDamage(root, ["package.json"]);
      assert.match(damage?.paths[0] ?? "", /locked@1\.0\.0\/node_modules \(unreadable: EACCES\)/);
    } finally { await chmod(join(modules, ".pnpm/locked@1.0.0/node_modules"), 0o755); }
  });
});

test("every tracked manifest's tree is checked, and a missing tree is not damage", async () => {
  await scratch(async (root) => {
    await pkg(join(root, "packages/a/node_modules/broken"), "");
    assert.equal(await dependencyTreeDamage(root, ["package.json"]), null);
    assert.equal((await dependencyTreeDamage(root, ["package.json", "packages/a/package.json"]))?.total, 1);
    // A tree the install recorded is not optional: its disappearance is damage, but a presumed one's absence is not.
    await pkg(join(root, "node_modules/ok"));
    assert.equal(await dependencyTreeDamage(root, ["package.json", "packages/b/package.json"]), null);
    const gone = await dependencyTreeDamage(root, ["package.json", "packages/b/package.json"], { required: true });
    assert.deepEqual(gone?.paths, [join(root, "packages/b/node_modules (missing)")]);
  });
});

/** A package directory with nothing in it, as a damaged import leaves it: the install over it succeeds regardless. */
const plant = (root: string) => mkdir(join(root, "node_modules/damaged-pkg/lib"), { recursive: true });

test("a spare whose tree was damaged after it was prepared is not reused, and the claim repairs it", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const [spare] = await readySpares(f.repo);
    await plant(spare!.root);
    assert.ok(await installedTreeDamage(spare!.root), "the fixture damage is visible");
    const before = await f.count();
    const created = await createWorkspace("task", f.repo);
    const readiness = created.readiness as { reused?: boolean; repaired?: boolean };
    assert.notEqual(readiness.reused, true, "unchanged install inputs did not make a damaged tree reusable");
    assert.equal(readiness.repaired, true);
    assert.equal(await f.count() - before, 2, "the install that could not repair it, then the reinstall from scratch");
    assert.equal(existsSync(join(created.workspacePath, "node_modules/damaged-pkg")), false);
    assert.equal(await installedTreeDamage(created.workspacePath), null);
  } finally { await f.dispose(); }
}, 180_000);

test("a claim re-checks every tree the install recorded, not just the root", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const name = await spareName(f.repo);
    const [spare] = await readySpares(f.repo);
    // A workspace package with its own installed tree, as a real install leaves; the record names it.
    await mkdir(join(spare!.root, "packages/x/node_modules/dep"), { recursive: true });
    await writeFile(join(spare!.root, "packages/x/node_modules/dep/package.json"), "{}");
    const metadata = (await workspaceMetadata(name))!;
    const prepared = metadata.preparedDependencies as { trees?: string[] };
    await writeFile(metadataPath(name), JSON.stringify({ ...metadata, preparedDependencies: { ...prepared, trees: ["package.json", "packages/x/package.json"] } }));
    await rm(join(spare!.root, "packages/x/node_modules"), { recursive: true });
    const created = await createWorkspace("task", f.repo);
    assert.notEqual((created.readiness as { reused?: boolean }).reused, true, "damage outside the root tree is not reused either");
  } finally { await f.dispose(); }
}, 180_000);

test("a damaged checkout is not a seed for another workspace", async () => {
  const f = await bunProject();
  try {
    await plant(f.repo);
    const created = await createWorkspace("seeded", f.repo);
    const readiness = created.readiness as { seeded?: boolean; repaired?: boolean };
    assert.notEqual(readiness.seeded, true, "the primary's tree matches the install inputs but is damaged");
    assert.equal(existsSync(join(created.workspacePath, "node_modules/damaged-pkg")), false, "the damage did not propagate");
    assert.equal(await installedTreeDamage(created.workspacePath), null);
  } finally { await f.dispose(); }
}, 180_000);

test("repairing damaged spares reinstalls an unclaimed one and leaves healthy ones alone", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const name = await spareName(f.repo);
    const report: object[] = [];
    assert.deepEqual(await repairDamagedSpares(f.repo, (o) => report.push(o)), [], "a healthy spare is not touched");
    const [spare] = await readySpares(f.repo);
    await plant(spare!.root);
    const before = await f.count();
    assert.deepEqual(await repairDamagedSpares(f.repo, (o) => report.push(o)), [name]);
    assert.equal(await f.count() - before, 1, "one install from scratch");
    assert.equal(await installedTreeDamage(spare!.root), null);
    assert.equal((await readySpares(f.repo)).length, 1, "the repaired spare is ready to claim again");
    const created = await createWorkspace("task", f.repo);
    assert.equal((created.readiness as { reused?: boolean }).reused, true, "and its repaired dependencies are reused");
  } finally { await f.dispose(); }
}, 180_000);
