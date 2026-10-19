import { jj, landThroughTestRunner, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace, createWorkspace, findIssueWorkspace, removeWorkspace, renameWorkspace } from "../../src/lib/slipjay.ts";
import { statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { withinWorkspaceStorage } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { landedHome, metadataHome, workspaceHome } from "../../src/lib/workspace/workspace-paths.ts";

const landedPath = (name: string) => join(landedHome(), `${name}.json`);
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));

function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Held while it lands, so the landing keeps it for the test.
  const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(result.ok, true, result.lines.join("\n"));
  return workspace;
}

test("attaching an Issue to a landed workspace is refused", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "attach.txt");
    const result = await runCli(workspace.workspacePath, ["attach-issue", "77"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /has landed, so it is read-only/);
    assert.equal((await workspaceMetadata(workspace.current.name))?.issueNumber, undefined);
  } finally {
    await f.dispose();
  }
}, 120_000);

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

test("rename preserves landing state in both locations with its history", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "rename.txt");
    const oldName = workspace.current.name;
    // A legacy landing record lives under landed/ beside the current top-level one.
    await mkdir(join(landedPath(oldName), ".."), { recursive: true });
    await copyFile(statePath(oldName), landedPath(oldName));

    const { name } = await renameWorkspace(workspace.workspacePath, "renamed task");
    assert.equal(name, "renamed-task");
    for (const path of [statePath(name), landedPath(name)]) {
      const state = await readJson(path);
      assert.equal(state.workspaceName, name);
      assert.deepEqual(state.previousWorkspaceNames, [oldName]);
    }
    assert.equal(existsSync(statePath(oldName)), false);
    assert.equal(existsSync(landedPath(oldName)), false);
    const metadata = await workspaceMetadata(name);
    assert.deepEqual(metadata?.previousWorkspaceNames, [oldName]);
    assert.equal((metadata?.workspaceRenameEpochs as Array<{ toName: string }> | undefined)?.at(-1)?.toName, name);
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup retries pending housekeeping before releasing a landed workspace", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "pending.txt");
    const state = await readJson(statePath(workspace.current.name));
    await writeFile(statePath(workspace.current.name), JSON.stringify({ ...state, cleanupPending: true, cleanupError: "interrupted" }));
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup refuses a checkout outside workspace storage", async () => {
  const f = await project();
  try {
    const outside = join(f.root, "outside");
    jj(f.repo, ["workspace", "add", "--name", "outside", outside]);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    jj(outside, ["describe", "-m", "Add outside"]);
    assert.equal((await landThroughTestRunner(f, outside)).ok, true);
    assert.equal(await withinWorkspaceStorage(outside), false);
    assert.deepEqual(await cleanupLandedWorkspace(outside), { cleaned: false, reason: "outside-workspace-storage" });
    assert.ok(existsSync(join(outside, "outside.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

// Issue workspaces have a deterministic name and path, so each test uses its own Issue.
async function issueWorkspace(f: Awaited<ReturnType<typeof project>>, issueNumber: number, task: string) {
  const workspace = await createWorkspace(task, f.repo, { issueNumber });
  return { workspace, dispose: () => rm(workspace.workspacePath, { recursive: true, force: true }) };
}
const head = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", 'change_id ++ " " ++ commit_id']);
const metadataFile = (name: string) => join(metadataHome(), `${name}.json`);

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

for (const [historicalHome, issueNumber] of [[".pi", 96505], [".slipway", 96506]] as const) {
  test(`a missing empty Issue checkout under ${historicalHome} is safely recovered`, async () => {
    const f = await project();
    const name = `historical-${issueNumber}`;
    const storage = join(homedir(), historicalHome, "workspaces");
    const oldPath = join(storage, name);
    try {
      await mkdir(storage, { recursive: true });
      await mkdir(metadataHome(), { recursive: true });
      jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", oldPath]);
      await writeFile(metadataFile(name), JSON.stringify({ version: 1, workspaceName: name, workspacePath: oldPath,
        integrationRoot: f.repo, issueNumber, task: "Historical Issue work" }));
      await rm(oldPath, { recursive: true });
      assert.equal(await findIssueWorkspace(f.repo, issueNumber), null);
      const recreated = await createWorkspace("Recovered historical work", f.repo, { issueNumber });
      assert.equal(recreated.created, true);
      assert.ok(recreated.workspacePath.startsWith(workspaceHome() + "/"));
      assert.equal((await workspaceMetadata(recreated.current.name))?.issueNumber, issueNumber);
      assert.equal(existsSync(metadataFile(name)), false, "the safe stale generation was retired");
    } finally {
      await rm(metadataFile(name), { force: true });
      await f.dispose();
    }
  }, 120_000);

  test(`an empty retained checkout under ${historicalHome} can be removed`, async () => {
    const f = await project();
    const name = `removable-${issueNumber}`;
    const storage = join(homedir(), historicalHome, "workspaces");
    const path = join(storage, name);
    try {
      await mkdir(storage, { recursive: true });
      jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", path]);
      await removeWorkspace(f.repo, name);
      assert.equal(existsSync(path), false);
    } finally {
      await rm(path, { recursive: true, force: true });
      await f.dispose();
    }
  }, 120_000);
}

test("missing Issue recovery still refuses paths outside every workspace storage root", async () => {
  const f = await project();
  const name = "outside-storage";
  const outside = join(f.root, name);
  try {
    await mkdir(metadataHome(), { recursive: true });
    jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", outside]);
    await writeFile(metadataFile(name), JSON.stringify({ version: 1, workspaceName: name, workspacePath: outside,
      integrationRoot: f.repo, issueNumber: 96507, task: "Unsafe stale path" }));
    await rm(outside, { recursive: true });
    await assert.rejects(findIssueWorkspace(f.repo, 96507), /unsafe stale path; preserve it for explicit recovery/);
    assert.equal(existsSync(metadataFile(name)), true);
  } finally {
    await rm(metadataFile(name), { force: true });
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
