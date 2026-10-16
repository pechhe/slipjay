import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, provisionSpare, resolveStartBase } from "../src/lib/slipjay.ts";
import { startFetchHome } from "../src/lib/workspace-paths.ts";

/** Land a commit on `origin/main` from another clone, as another machine would. */
function landElsewhere(f: { root: string; remote: string }, file: string) {
  const other = join(f.root, "other");
  const git = (args: string[], cwd = other) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["clone", "-q", f.remote, other], f.root);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  execFileSync("node", ["-e", `require("node:fs").writeFileSync(${JSON.stringify(join(other, file))}, "elsewhere\\n")`]);
  git(["add", "."]);
  git(["commit", "-qm", "Landed elsewhere"]);
  git(["push", "-q", "origin", "main"]);
  return git(["rev-parse", "HEAD"]).toString().trim();
}

const parentOf = (workspacePath: string) => jj(workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);

test("a new workspace starts from the integration branch as published on the remote", async () => {
  const f = await project();
  try {
    const landed = landElsewhere(f, "elsewhere.txt");
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, false);
    assert.equal(parentOf(created.workspacePath), landed);
    assert.equal(await readFile(join(created.workspacePath, "elsewhere.txt"), "utf8"), "elsewhere\n");
  } finally { await f.dispose(); }
});

test("a claimed spare starts from the integration branch as published on the remote", async () => {
  const f = await project();
  try {
    await provisionSpare(f.repo);
    const landed = landElsewhere(f, "elsewhere.txt");
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true);
    assert.equal(parentOf(created.workspacePath), landed);
  } finally { await f.dispose(); }
});

test("an unreachable remote still starts the workspace from the local integration branch", async () => {
  const f = await project();
  try {
    const local = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    await rm(f.remote, { recursive: true, force: true });
    await writeFile(f.remote, "");
    const created = await createWorkspace("task", f.repo);
    assert.equal(parentOf(created.workspacePath), local);
  } finally { await f.dispose(); }
});

test("starts within the reuse window share one fetch, and a later start fetches again", async () => {
  const f = await project();
  try {
    const before = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    await createWorkspace("first", f.repo);
    const landed = landElsewhere(f, "elsewhere.txt");
    const second = await createWorkspace("second", f.repo);
    assert.equal(parentOf(second.workspacePath), before, "a start right after a fetch reuses it");

    // Age every marker past the reuse window, as if the burst had ended.
    const old = new Date(Date.now() - 60_000);
    for (const name of await readdir(startFetchHome())) await utimes(join(startFetchHome(), name), old, old);
    const third = await createWorkspace("third", f.repo);
    assert.equal(parentOf(third.workspacePath), landed);
  } finally { await f.dispose(); }
});

/** A lead's checkout holding one committed, unlanded change, and that change's commit id. */
async function leadWithUnlandedWork(f: { repo: string }) {
  const lead = await createWorkspace("lead", f.repo);
  await writeFile(join(lead.workspacePath, "lead.txt"), "lead\n");
  jj(lead.workspacePath, ["new"]);
  return { lead: lead.workspacePath, base: parentOf(lead.workspacePath) };
}

test("a claimed spare started on a lead's revision holds the lead's unlanded work", async () => {
  const f = await project();
  try {
    const { lead, base } = await leadWithUnlandedWork(f);
    await provisionSpare(f.repo);
    const helper = await createWorkspace("helper", f.repo, { base: await resolveStartBase(lead, "@-") });
    assert.equal(helper.pooled, true);
    assert.equal(parentOf(helper.workspacePath), base);
    assert.equal(await readFile(join(helper.workspacePath, "lead.txt"), "utf8"), "lead\n");
  } finally { await f.dispose(); }
});

test("a fresh workspace started on a lead's revision holds the lead's unlanded work", async () => {
  const f = await project();
  try {
    const { lead, base } = await leadWithUnlandedWork(f);
    const helper = await createWorkspace("helper", f.repo, { base: await resolveStartBase(lead, "@-") });
    assert.equal(helper.pooled, false);
    assert.equal(parentOf(helper.workspacePath), base);
  } finally { await f.dispose(); }
});

test("a start on a pinned base claims its spare without fetching the remote", async () => {
  const f = await project();
  try {
    const { lead, base } = await leadWithUnlandedWork(f);
    await provisionSpare(f.repo);
    landElsewhere(f, "elsewhere.txt");
    const old = new Date(Date.now() - 60_000);
    for (const name of await readdir(startFetchHome())) await utimes(join(startFetchHome(), name), old, old);
    const before = jj(f.repo, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);
    const helper = await createWorkspace("helper", f.repo, { base: await resolveStartBase(lead, "@-") });
    assert.equal(helper.pooled, true);
    assert.equal(parentOf(helper.workspacePath), base);
    assert.equal(jj(f.repo, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]), before, "no fetch ran");
  } finally { await f.dispose(); }
});

test("a start base is refused when it is the caller's working copy or names several commits", async () => {
  const f = await project();
  try {
    const { lead } = await leadWithUnlandedWork(f);
    await assert.rejects(resolveStartBase(lead, "@"), /working copy/);
    await assert.rejects(resolveStartBase(lead, "@ | @-"), /exactly one commit/);
    await assert.rejects(createWorkspace("helper", f.repo, { base: parentOf(lead), issueNumber: 7 }), /new workspace/);
  } finally { await f.dispose(); }
});
