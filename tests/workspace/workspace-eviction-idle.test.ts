import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { evictIdleWorkspaces, recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";
import { metadataPath } from "../../src/lib/workspace/workspace-state.ts";

const HOUR = 60 * 60_000;

async function checkout(f: Awaited<ReturnType<typeof project>>, task: string) {
  const workspace = await createWorkspace(task, f.repo);
  const name = workspace.current.name;
  await writeFile(join(workspace.workspacePath, "package.json"), JSON.stringify({ name: task }, null, 2));
  await mkdir(join(workspace.workspacePath, "node_modules", "small"), { recursive: true });
  await writeFile(join(workspace.workspacePath, "node_modules", "small", "index.js"), "module.exports = 1;\n");
  await recordWorkspaceActivity(name, Date.now() - 30 * HOUR);
  return { ...workspace, name };
}

const metadata = async (name: string) => JSON.parse(await readFile(metadataPath(name), "utf8"));

test("a plan names the idle checkout and changes nothing", async () => {
  const f = await project();
  const workspace = await checkout(f, "plan-evicts");
  const before = await metadata(workspace.name);

  const { plans } = await evictIdleWorkspaces(workspace.workspacePath, { plan: true });
  const planned = plans.find((entry) => entry.name === workspace.name);

  assert.equal(planned?.action, "evict");
  assert.deepEqual(planned?.dependencyPaths, ["node_modules"]);
  assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), true);
  assert.deepEqual(await metadata(workspace.name), before);
});

test("an idle checkout sheds its dependency tree and keeps its commits", async () => {
  const f = await project();
  const workspace = await checkout(f, "idle-evicts");

  const { outcome } = await evictIdleWorkspaces(workspace.workspacePath);
  const result = outcome.results.find((entry) => entry.name === workspace.name);

  assert.equal(result?.evicted, true);
  assert.deepEqual(result?.removedPaths, ["node_modules"]);
  assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), false);
  // Source and history stay: only the reproducible install goes.
  assert.equal(existsSync(join(workspace.workspacePath, "package.json")), true);
  const after = await metadata(workspace.name);
  assert.equal(typeof after.evictedAt, "string");
  // A later claim must not reuse a readiness record for trees that are gone.
  assert.equal(after.preparedDependencies?.state, "stale");
});

test("a checkout someone is working in keeps its dependencies, and its clock moves", async () => {
  const f = await project();
  const workspace = await checkout(f, "held-evicts");
  const processes = [{ pid: process.pid, cwd: workspace.workspacePath, command: "bun test" }];

  const { outcome } = await evictIdleWorkspaces(workspace.workspacePath, { processes });

  assert.equal(outcome.results.length, 0);
  assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), true);
  const after = await metadata(workspace.name);
  assert.ok(Date.now() - Date.parse(after.lastActivityAt) < 60_000, "observing a holder records activity");
  assert.equal(after.evictedAt, undefined);
});

test("a checkout used within the idle window keeps its dependencies", async () => {
  const f = await project();
  const workspace = await checkout(f, "recent-evicts");
  await recordWorkspaceActivity(workspace.name, Date.now() - HOUR);

  const { outcome } = await evictIdleWorkspaces(workspace.workspacePath);

  assert.equal(outcome.results.length, 0);
  assert.match(outcome.skipped.find((entry) => entry.name === workspace.name)?.reason ?? "", /used within 24h/);
  assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), true);
});

test("an idle checkout sheds declared generated output and keeps evidence and source", async () => {
  const f = await project({ policy: { generatedPaths: ["**/build", "**/.svelte-kit"], evidencePaths: ["artifacts/**"] } });
  const created = await createWorkspace("generated-evicts", f.repo);
  const root = created.workspacePath;
  const name = created.current.name;
  await mkdir(join(root, "build", "cache"), { recursive: true });
  await writeFile(join(root, "build", "cache", "out.js"), "generated\n");
  await mkdir(join(root, "apps", "web", ".svelte-kit"), { recursive: true });
  await writeFile(join(root, "apps", "web", ".svelte-kit", "env.js"), "generated\n");
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "artifacts", "review.md"), "a person wrote this\n");
  await writeFile(join(root, "src.js"), "source\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await recordWorkspaceActivity(name, Date.now() - 30 * HOUR);

  const { outcome } = await evictIdleWorkspaces(root);
  const result = outcome.results.find((entry) => entry.name === name);

  assert.deepEqual(result?.removedPaths.sort(), ["apps/web/.svelte-kit", "build", "node_modules"].sort());
  assert.equal(existsSync(join(root, "build")), false, "declared generated output goes");
  assert.equal(existsSync(join(root, "apps", "web", ".svelte-kit")), false);
  assert.equal(existsSync(join(root, "node_modules")), false, "dependencies go as before");
  assert.equal(existsSync(join(root, "src.js")), true, "source stays");
  assert.equal(existsSync(join(root, "artifacts", "review.md")), true, "evidence a person keeps stays");
});
