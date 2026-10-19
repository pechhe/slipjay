import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { lockPath } from "../../src/lib/workspace/workspace-state.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);

/** A process working inside `cwd` until disposed, as a live session would be. */
function occupy(cwd: string) {
  const child = spawn("sleep", ["60"], { cwd, stdio: "ignore" });
  return () => child.kill();
}

async function land(f: { root: string; repo: string; remote: string }, cwd: string, file: string, options: { keep?: boolean } = {}) {
  await writeFile(join(cwd, file), `${file}\n`);
  const result = await landThroughTestRunner(f, cwd, options);
  assert.equal(result.ok, true, result.lines.join("\n"));
  return result;
}

test("an idle empty workspace is swept, but not while recent, occupied or claimed", async () => {
  const f = await project();
  const release: Array<() => void> = [];
  try {
    const idle = await createWorkspace("idle", f.repo);
    const occupied = await createWorkspace("occupied", f.repo);
    const locked = await createWorkspace("locked", f.repo);
    const issue = await createWorkspace("issue", f.repo);
    await attachWorkspaceIssue(issue.workspacePath, 41);
    await provisionSpare(f.repo);
    release.push(occupy(occupied.workspacePath));
    await mkdir(join(lockPath(locked.current.name), ".."), { recursive: true });
    await writeFile(lockPath(locked.current.name), JSON.stringify({ version: 1, pid: process.pid }));

    const recent = await sweepDisposableWorkspaces(f.repo, { issueClosed: () => null });
    assert.deepEqual(recent.removed, [], "nothing is removed before the idle threshold");

    const swept = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(swept.removed, [idle.current.name]);
    assert.equal(existsSync(idle.workspacePath), false);
    const reasons = Object.fromEntries(swept.skipped.map(({ name, reason }) => [name, reason]));
    assert.match(reasons[occupied.current.name] ?? "", /live process/);
    assert.match(reasons[locked.current.name] ?? "", /live process/);
    for (const kept of [occupied, locked, issue]) assert.ok(existsSync(kept.workspacePath), kept.current.name);
    const remaining = names(f.repo);
    assert.ok(remaining.includes(issue.current.name), "an Issue workspace that has not landed is never swept");
    assert.ok(remaining.some((name) => /-spare-/.test(name)), "spares are never swept");
    assert.ok(!remaining.includes(idle.current.name));
  } finally {
    for (const dispose of release) dispose();
    await f.dispose();
  }
}, 120_000);

/** Advance `main` in the primary checkout and move `workspace`'s change onto it from there, so its checkout goes stale. */
async function rewriteUnder(repo: string, workspace: string) {
  await writeFile(join(repo, "advanced.txt"), "advanced\n");
  jj(repo, ["commit", "-m", "Advance main"]);
  jj(repo, ["bookmark", "set", "main", "-r", "@-"]);
  jj(repo, ["rebase", "-r", `${workspace}@`, "-d", "main"]);
}

test("a stale idle workspace is updated and swept, but one holding edits is kept with them", async () => {
  const f = await project();
  try {
    const clean = await createWorkspace("clean", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    await writeFile(join(edited.workspacePath, "draft.txt"), "mine\n");
    await rewriteUnder(f.repo, clean.current.name);
    jj(f.repo, ["rebase", "-r", `${edited.current.name}@`, "-d", "main"]);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(swept.removed, [clean.current.name], JSON.stringify(swept.skipped));
    assert.match(swept.skipped.find(({ name }) => name === edited.current.name)?.reason ?? "", /held edits/);
    assert.equal(await readFile(join(edited.workspacePath, "draft.txt"), "utf8"), "mine\n", "the edits are back on disk");
    assert.match(jj(edited.workspacePath, ["diff", "--summary"]), /draft\.txt/, "and in the checkout's own change");
    assert.equal(jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", '"x"']), "", "the empty rebased twin is gone");
    const again = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(again.removed, [], "a later sweep still keeps the edits");
    assert.ok(existsSync(join(edited.workspacePath, "draft.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup updates a landed workspace whose working copy went stale, then releases it", async () => {
  const f = await project();
  try {
    const landed = await createWorkspace("landed", f.repo);
    await land(f, landed.workspacePath, "landed.txt", { keep: true });
    assert.ok(existsSync(landed.workspacePath), "held while it landed");
    await rewriteUnder(f.repo, landed.current.name);
    assert.deepEqual(await cleanupLandedWorkspace(landed.workspacePath), { cleaned: true });
    assert.equal(existsSync(landed.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a workspace with unique untracked files is kept by sweep and prune", async () => {
  const f = await project({ ignore: "notes/\n" });
  try {
    const kept = await createWorkspace("kept", f.repo);
    await mkdir(join(kept.workspacePath, "notes"));
    await writeFile(join(kept.workspacePath, "notes", "draft.md"), "mine\n");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(swept.removed, []);
    assert.match(swept.skipped[0]?.reason ?? "", /notes\/draft\.md/);
    assert.deepEqual((await pruneEmptyWorkspaces(f.repo)).removed, []);
    assert.ok(existsSync(join(kept.workspacePath, "notes", "draft.md")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a link into the primary checkout does not keep a workspace, but a link elsewhere does", async () => {
  const f = await project({ ignore: ".env\n" });
  try {
    await writeFile(join(f.repo, ".env"), "SECRET=1\n");
    const linked = await createWorkspace("linked", f.repo);
    await symlink(join(f.repo, ".env"), join(linked.workspacePath, ".env"));
    const elsewhere = await createWorkspace("elsewhere", f.repo);
    await symlink(join(f.repo, "..", "outside.env"), join(elsewhere.workspacePath, ".env"));
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later(), issueClosed: () => null });
    assert.deepEqual(swept.removed, [linked.current.name]);
    assert.match(swept.skipped.find(({ name }) => name === elsewhere.current.name)?.reason ?? "", /\.env/);
    assert.equal(await readFile(join(f.repo, ".env"), "utf8"), "SECRET=1\n", "the link's target is untouched");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("an explicit prune removes unused empty workspaces now but never an occupied one", async () => {
  const f = await project();
  let release = () => {};
  try {
    const unused = await createWorkspace("unused", f.repo);
    const busy = await createWorkspace("busy", f.repo);
    release = occupy(busy.workspacePath);
    const result = await pruneEmptyWorkspaces(f.repo);
    assert.deepEqual(result.removed, [unused.current.name]);
    assert.deepEqual(result.skipped.map(({ name }) => name), [busy.current.name]);
    assert.ok(existsSync(busy.workspacePath));
  } finally {
    release();
    await f.dispose();
  }
}, 120_000);

test("landing anywhere releases other delivered checkouts, but not one still in use", async () => {
  const f = await project();
  let release = () => {};
  try {
    // Held while it lands, so it outlives its own landing as a delivered checkout.
    const first = await createWorkspace("first", f.repo);
    await land(f, first.workspacePath, "first.txt", { keep: true });
    assert.ok(existsSync(first.workspacePath));
    const issue = await createWorkspace("issue", f.repo);
    await attachWorkspaceIssue(issue.workspacePath, 41);
    const landed = await land(f, issue.workspacePath, "issue.txt");
    assert.equal(landed.housekeeping?.started, true, "its housekeeping runs after the verdict, detached");
    assert.ok(landed.lines.includes(`Removed workspace: ${first.current.name}`), `the next landing releases the delivered checkout and reports it: ${landed.lines.join("\n")}`);
    assert.equal(existsSync(first.workspacePath), false);
    assert.equal(existsSync(issue.workspacePath), false, "the landing releases its own checkout");
    const busy = await createWorkspace("busy", f.repo);
    await land(f, busy.workspacePath, "busy.txt", { keep: true });
    release = occupy(busy.workspacePath);
    const last = await createWorkspace("last", f.repo);
    const kept = (await land(f, last.workspacePath, "last.txt")).lines.filter((line) => line.startsWith("Kept landed workspace"));
    assert.equal(kept.length, 1, kept.join("\n"));
    assert.match(kept[0]!, new RegExp(`^Kept landed workspace ${busy.current.name}: `), "the landing reports the delivered checkout it kept");
    assert.ok(existsSync(busy.workspacePath), "a delivered checkout with a live process is kept");
    assert.equal(f.remoteFile("last.txt"), "last.txt\n");
  } finally {
    release();
    await f.dispose();
  }
}, 180_000);

test("start with a flag prints usage and creates no workspace", async () => {
  const f = await project();
  try {
    for (const flag of ["--help", "-h"]) {
      const exit = await new Promise<{ code: number; stderr: string }>((resolveExit) => {
        execFile("bun", [cli, "start", flag], { cwd: f.repo }, (error, _stdout, stderr) =>
          resolveExit({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }));
      });
      assert.equal(exit.code, 2);
      assert.match(exit.stderr, /Usage: slipjay start/);
    }
    assert.deepEqual(names(f.repo), ["default"]);
    assert.equal(await readFile(join(f.repo, "README.md"), "utf8"), "fixture\n");
  } finally {
    await f.dispose();
  }
});
