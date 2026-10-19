import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, findIssueWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { runCli, metadataFile } from "./fixtures/workspace-lifecycle-convergence-fixture.ts";

// Issue workspaces have a deterministic name and path, so each test uses its own Issue.
async function issueWorkspace(f: Awaited<ReturnType<typeof project>>, issueNumber: number, task: string) {
  const workspace = await createWorkspace(task, f.repo, { issueNumber });
  return { workspace, dispose: () => rm(workspace.workspacePath, { recursive: true, force: true }) };
}

const head = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", 'change_id ++ " " ++ commit_id']);

test("status reports the Issue attached to the workspace", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("status-issue", f.repo);
    const statusIssue = async () => JSON.parse((await runCli(workspace.workspacePath, ["status"])).stdout).workspace.issueNumber;
    assert.equal(await statusIssue(), undefined);
    assert.equal((await runCli(workspace.workspacePath, ["attach-issue", "77"])).code, 0);
    assert.equal(await statusIssue(), 77);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the CLI starts a workspace with the Git author and a creation record", async () => {
  const f = await project();
  try {
    execFileSync("git", ["config", "user.name", "Git Author"], { cwd: f.repo });
    execFileSync("git", ["config", "user.email", "git-author@example.com"], { cwd: f.repo });
    const started = await runCli(f.repo, ["start", "cli task"]);
    assert.equal(started.code, 0, started.stderr);
    const workspacePath = started.stdout.trim().split("\n").at(-1)!;
    // Read without the fixture's JJ_USER/JJ_EMAIL, which override every config file.
    const { JJ_USER: _user, JJ_EMAIL: _email, ...env } = process.env;
    const config = (key: string) => execFileSync("jj", ["config", "get", key], { cwd: workspacePath, env, encoding: "utf8" }).trim();
    assert.equal(config("user.name"), "Git Author");
    assert.equal(config("user.email"), "git-author@example.com");
    const metadata = await workspaceMetadata(basename(workspacePath));
    assert.equal(metadata?.task, "cli task");
    assert.equal(metadata?.workspaceCreationName, basename(workspacePath));
    assert.equal(metadata?.workspaceCreationPath, workspacePath);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("an Issue workspace is resumed, and refused once it has landed", async () => {
  const f = await project();
  const { workspace, dispose } = await issueWorkspace(f, 96501, "Issue work");
  try {
    assert.equal(workspace.created, true);
    const resumed = await createWorkspace("Issue work again", f.repo, { issueNumber: 96501 });
    assert.deepEqual([resumed.reused, resumed.workspacePath], [true, workspace.workspacePath]);
    assert.equal((await workspaceMetadata(workspace.current.name))?.task, "Issue work again");
    await writeFile(join(workspace.workspacePath, "issue.txt"), "issue\n");
    assert.equal((await landThroughTestRunner(f, workspace.workspacePath, { keep: true })).ok, true);
    await assert.rejects(createWorkspace("after landing", f.repo, { issueNumber: 96501 }), /has landed, so it is read-only/);
  } finally {
    await dispose();
    await f.dispose();
  }
}, 120_000);

test("a clean Issue workspace missing on disk is forgotten and recreated as a new generation", async () => {
  const f = await project();
  const { workspace, dispose } = await issueWorkspace(f, 96502, "Missing work");
  try {
    const before = await workspaceMetadata(workspace.current.name);
    await rm(workspace.workspacePath, { recursive: true, force: true });
    const recreated = await createWorkspace("Missing work again", f.repo, { issueNumber: 96502 });
    assert.deepEqual([recreated.created, recreated.current.name, recreated.workspacePath], [true, workspace.current.name, workspace.workspacePath]);
    const after = await workspaceMetadata(recreated.current.name);
    assert.equal(after?.implementationChangeId, recreated.current.changeId);
    assert.notEqual(after?.implementationChangeId, before?.implementationChangeId);
    assert.equal(after?.issueNumber, 96502);
  } finally {
    await dispose();
    await f.dispose();
  }
}, 120_000);

test("an Issue workspace missing on disk with unlanded work is preserved", async () => {
  const f = await project();
  const { workspace, dispose } = await issueWorkspace(f, 96503, "Unique work");
  try {
    await writeFile(join(workspace.workspacePath, "unique.txt"), "unique\n");
    jj(workspace.workspacePath, ["describe", "-m", "unique work"]);
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await assert.rejects(findIssueWorkspace(f.repo, 96503), /still contains unintegrated work; preserve it for explicit recovery/);
    assert.match(jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']), new RegExp(`^${workspace.current.name}$`, "m"));
  } finally {
    await dispose();
    await f.dispose();
  }
}, 120_000);

test("an orphaned Issue checkout is recovered in place with its work", async () => {
  const f = await project();
  const { workspace, dispose } = await issueWorkspace(f, 96504, "Orphan work");
  try {
    await writeFile(join(workspace.workspacePath, "orphan.txt"), "orphan\n");
    jj(workspace.workspacePath, ["describe", "-m", "orphan work"]);
    const identity = head(workspace.workspacePath);
    await rm(metadataFile(workspace.current.name));
    jj(f.repo, ["workspace", "forget", workspace.current.name]);
    const recovered = await createWorkspace("Orphan work resumed", f.repo, { issueNumber: 96504 });
    assert.deepEqual([recovered.created, recovered.reused, recovered.workspacePath], [false, true, workspace.workspacePath]);
    assert.equal(head(workspace.workspacePath), identity);
    assert.equal(await readFile(join(workspace.workspacePath, "orphan.txt"), "utf8"), "orphan\n");
    assert.equal((await findIssueWorkspace(f.repo, 96504))?.name, workspace.current.name);
  } finally {
    await dispose();
    await f.dispose();
  }
}, 120_000);
