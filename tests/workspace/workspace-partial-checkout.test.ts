import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { byName, later } from "./fixtures/workspace-retention-plan-fixture.ts";

/** A repository whose main holds `big/` (60 files) and `other/` (20 files) beside the fixture's own. */
async function wideProject() {
  const f = await project();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
  for (const [directory, count] of [["big", 60], ["other", 20]] as const) {
    await mkdir(join(f.repo, directory), { recursive: true });
    for (let index = 0; index < count; index++) await writeFile(join(f.repo, directory, `file-${index}.txt`), `${directory} ${index}\n`);
  }
  git("add", ".");
  git("commit", "-qm", "Wide tree");
  git("push", "-q", "origin", "main");
  jj(f.repo, ["git", "import"]);
  return f;
}

const operations = (cwd: string) => jj(cwd, ["--ignore-working-copy", "op", "log", "--no-graph", "-T", 'id.short() ++ "\\n"']).split("\n").length;
const trackedCount = (cwd: string) => jj(cwd, ["--ignore-working-copy", "file", "list"]).split("\n").length;

async function removeFiles(root: string, directory: string, from: number, to: number) {
  for (let index = from; index < to; index++) await rm(join(root, directory, `file-${index}.txt`));
}

test("a checkout missing most of its tracked files is named as partially written, with counts, and nothing is changed", async () => {
  const f = await wideProject();
  try {
    const partial = await createWorkspace("partial", f.repo);
    const expected = trackedCount(partial.workspacePath);
    await removeFiles(partial.workspacePath, "big", 0, 50);
    await removeFiles(partial.workspacePath, "other", 0, 20);
    const before = operations(partial.workspacePath);

    const entry = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[partial.current.name];
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", new RegExp(`partially written checkout: 70 of ${expected} tracked files are missing`));
    assert.match(entry?.reason ?? "", /slipjay remove --discard/, "names the supported removal");
    assert.match(entry?.reason ?? "", new RegExp(`slipjay start --base ${partial.current.name}@`), "names how to restore it");
    assert.match(entry?.reason ?? "", /from another checkout/, "says where to run the restore");
    assert.equal(operations(partial.workspacePath), before, "the plan takes no snapshot");

    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.deepEqual(swept.removed, []);
    assert.match(swept.skipped.find((item) => item.name === partial.current.name)?.reason ?? "", /partially written checkout/);
    assert.equal(operations(partial.workspacePath), before, "the sweep takes no snapshot of a suspected partial checkout");
    assert.ok(existsSync(partial.workspacePath));
    assert.equal(existsSync(join(partial.workspacePath, "big", "file-59.txt")), true, "files that exist are untouched");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("removal of a suspected partial checkout refuses with the diagnosis, and proceeds when discarding is explicit", async () => {
  const f = await wideProject();
  try {
    const partial = await createWorkspace("partial", f.repo);
    await removeFiles(partial.workspacePath, "big", 0, 60);
    const before = operations(partial.workspacePath);
    await assert.rejects(removeWorkspace(f.repo, partial.current.name), /partially written checkout: 60 of \d+ tracked files are missing/);
    assert.equal(operations(partial.workspacePath), before, "the refusal takes no snapshot");
    assert.ok(existsSync(partial.workspacePath));
    await removeWorkspace(f.repo, partial.current.name, { allowWork: true });
    assert.equal(existsSync(partial.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 240_000);

test("files outside the sparse patterns are not counted as missing, and a sparse checkout missing its own files is still named", async () => {
  const f = await wideProject();
  try {
    const sparse = await createWorkspace("sparse", f.repo);
    jj(sparse.workspacePath, ["sparse", "set", "--clear", "--add", "big"]);
    assert.equal(existsSync(join(sparse.workspacePath, "other")), false, "the pattern left other/ out of the checkout");

    const intact = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[sparse.current.name];
    assert.equal(intact?.action, "remove", `an intact sparse checkout is ordinary: ${intact?.reason}`);

    await removeFiles(sparse.workspacePath, "big", 0, 45);
    const entry = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[sparse.current.name];
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", /partially written checkout: 45 of 60 tracked files are missing/, "only files inside the sparse patterns are expected");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("a few deleted files are ordinary edits, not a partial checkout", async () => {
  const f = await wideProject();
  try {
    const edited = await createWorkspace("edited", f.repo);
    await removeFiles(edited.workspacePath, "big", 0, 5);
    const entry = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[edited.current.name];
    assert.equal(entry?.action, "keep");
    assert.match(entry?.reason ?? "", /edited since its last snapshot: big\/file-0\.txt/);
    assert.doesNotMatch(entry?.reason ?? "", /partially written/);
  } finally {
    await f.dispose();
  }
}, 240_000);
