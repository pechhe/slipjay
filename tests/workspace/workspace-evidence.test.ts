import { jj, landThroughTestRunner, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace, createWorkspace, planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/slipjay.ts";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { MAX_EVIDENCE_BYTES } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { evidenceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { statePath } from "../../src/lib/workspace/workspace-state.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";

type Fixture = Awaited<ReturnType<typeof project>>;

const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n");
/** Local runtime and review output of a preview, as T3's worktree-local `.t3` home holds. */
const declared = { ignore: ".t3/\nnotes/\n", generatedPaths: [".t3/userdata"], policy: { evidencePaths: [".t3/review"] } };

async function landedWorkspace(f: Fixture, task: string) {
  const workspace = await createWorkspace(task, f.repo);
  await writeFile(join(workspace.workspacePath, `${task}.txt`), `${task}\n`);
  jj(workspace.workspacePath, ["describe", "-m", `Add ${task}`]);
  const landed = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(landed.ok, true, landed.lines.join("\n"));
  return workspace;
}

async function previewOutput(root: string) {
  await mkdir(join(root, ".t3", "userdata", "secrets"), { recursive: true });
  await writeFile(join(root, ".t3", "userdata", "secrets", "signing-key.bin"), "secret");
  await mkdir(join(root, ".t3", "review"), { recursive: true });
  await writeFile(join(root, ".t3", "review", "issue-7-review.md"), "Approved.\n");
}

async function preserved() {
  return (await readdir(evidenceHome()).catch(() => [])).filter((name) => !name.endsWith(".partial"));
}

test("a landed workspace retires with its runtime output discarded and its evidence preserved with provenance", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "evidence");
    await previewOutput(workspace.workspacePath);
    const before = await preserved();

    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.ok(!existsSync(workspace.workspacePath));
    assert.ok(!names(f.repo).includes(workspace.current.name));

    const added = (await preserved()).filter((name) => !before.includes(name));
    assert.equal(added.length, 1);
    assert.ok(added[0]!.startsWith(`${workspace.current.name}-`));
    const directory = join(evidenceHome(), added[0]!);
    const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"));
    assert.equal(provenance.workspaceName, workspace.current.name);
    assert.equal(provenance.repository, f.repo);
    assert.equal(provenance.task, "evidence");
    assert.match(provenance.landing?.artifactCommitId ?? "", /^[0-9a-f]{40}$/);
    assert.equal(jj(f.repo, ["log", "-r", `${provenance.landing.artifactCommitId} & ::main`, "--no-graph", "-T", "'x'"]), "x", "the provenance names the integrated artifact");
    assert.deepEqual(provenance.files, [{
      path: ".t3/review/issue-7-review.md", bytes: 10, sha256: createHash("sha256").update("Approved.\n").digest("hex"),
    }]);
    assert.equal(await readFile(join(directory, "files", ".t3", "review", "issue-7-review.md"), "utf8"), "Approved.\n");
    assert.ok(!existsSync(join(directory, "files", ".t3", "userdata")), "runtime output is not evidence");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("undeclared local runtime output keeps a landed workspace: nothing under .t3 is disposable by default", async () => {
  const f = await project({ ignore: ".t3/\n" });
  try {
    const workspace = await landedWorkspace(f, "undeclared");
    await previewOutput(workspace.workspacePath);
    const result = await cleanupLandedWorkspace(workspace.workspacePath);
    assert.equal(result.cleaned, false);
    assert.equal(result.reason, "unique-files");
    assert.ok(result.paths?.some((path) => path.startsWith(".t3/")), JSON.stringify(result));
    assert.ok(existsSync(join(workspace.workspacePath, ".t3", "review", "issue-7-review.md")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("evidence too large to preserve keeps the workspace with what to do", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "oversized");
    await mkdir(join(workspace.workspacePath, ".t3", "review"), { recursive: true });
    const large = join(workspace.workspacePath, ".t3", "review", "capture.bin");
    await writeFile(large, "");
    await truncate(large, MAX_EVIDENCE_BYTES + 1);
    const before = await preserved();

    await assert.rejects(cleanupLandedWorkspace(workspace.workspacePath), /MiB of evidence under evidencePaths.*move what is needed elsewhere/);
    assert.ok(existsSync(large));
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.deepEqual(await preserved(), before);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a file no history holds, written during retirement, keeps the workspace", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "late notes");
    const result = await cleanupLandedWorkspace(workspace.workspacePath, {
      afterChecks: async () => {
        await mkdir(join(workspace.workspacePath, "notes"), { recursive: true });
        await writeFile(join(workspace.workspacePath, "notes", "late.md"), "mine\n");
      },
    });
    assert.deepEqual(result, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.equal(await readFile(join(workspace.workspacePath, "notes", "late.md"), "utf8"), "mine\n");
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: false, reason: "unique-files", paths: ["notes/late.md"] });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the plan does not mistake a file rewritten with its snapshot's bytes for an edit, and still reports a real one", async () => {
  const f = await project();
  try {
    const rewritten = await createWorkspace("rewritten", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    const future = new Date(Date.now() + 60_000);
    for (const workspace of [rewritten, edited]) await utimes(join(workspace.workspacePath, "README.md"), future, future);
    await writeFile(join(edited.workspacePath, "README.md"), "changed\n");
    await utimes(join(edited.workspacePath, "README.md"), future, future);

    const options = { now: later() };
    const plan = Object.fromEntries((await planDisposableWorkspaces(f.repo, options)).map((entry) => [entry.name, entry]));
    assert.equal(plan[rewritten.current.name]?.action, "remove", plan[rewritten.current.name]?.reason ?? "");
    assert.equal(plan[edited.current.name]?.action, "keep");
    assert.match(plan[edited.current.name]?.reason ?? "", /edited since its last snapshot: README\.md/);

    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(swept.removed.includes(rewritten.current.name), "the sweep agrees with the plan");
    assert.ok(names(f.repo).includes(edited.current.name), "the edit snapshots into unlanded work and is kept");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("evidencePaths is validated with the other slipjay.json keys", () => {
  const policy = (evidencePaths: unknown) => JSON.stringify({ version: 1, integrationBranch: "main", evidencePaths });
  assert.deepEqual(parseExecutionPolicy(policy([".t3/review"])).evidencePaths, [".t3/review"]);
  assert.throws(() => parseExecutionPolicy(policy("review")), /evidencePaths must be an array/);
  assert.throws(() => parseExecutionPolicy(policy(["../outside"])), /evidencePaths entry "\.\.\/outside"/);
  assert.throws(() => parseExecutionPolicy(policy(["**"])), /evidencePaths entry/);
});

test("evidence that changes while it is copied keeps the workspace, removes the copy, and the next retirement preserves it afresh", async () => {
  const f = await project(declared);
  try {
    const workspace = await landedWorkspace(f, "changing evidence");
    await previewOutput(workspace.workspacePath);
    const review = join(workspace.workspacePath, ".t3", "review", "issue-7-review.md");
    const interrupted = join(evidenceHome(), `${workspace.current.name}-2026-01-01T00-00-00-000Z.partial`);
    await mkdir(interrupted, { recursive: true });
    // A copy in flight for a sibling workspace whose name extends this one's.
    const sibling = join(evidenceHome(), `${workspace.current.name}-2-2026-01-01T00-00-00-000Z.partial`);
    await mkdir(sibling, { recursive: true });
    const before = await preserved();

    const raced = await cleanupLandedWorkspace(workspace.workspacePath, { afterEvidence: () => writeFile(review, "Approved, with a follow-up.\n") });
    assert.deepEqual(raced, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name));
    assert.deepEqual(await preserved(), before, "the stale copy is removed");
    assert.ok(!existsSync(interrupted), "an interrupted copy of the workspace is removed");
    assert.ok(existsSync(sibling), "another workspace's copy is not");

    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    const [added] = (await preserved()).filter((name) => !before.includes(name));
    await rm(sibling, { recursive: true, force: true });
    assert.equal(await readFile(join(evidenceHome(), added!, "files", ".t3", "review", "issue-7-review.md"), "utf8"), "Approved, with a follow-up.\n");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("declared paths come from the policy committed on the integration branch, never the primary checkout's working files", async () => {
  const f = await project({ ignore: ".t3/\n" });
  try {
    const workspace = await landedWorkspace(f, "uncommitted policy");
    await previewOutput(workspace.workspacePath);
    // A stale or unlanded local edit on one host must not change what retirement may delete there.
    const policyPath = join(f.repo, "slipjay.json");
    await writeFile(policyPath, JSON.stringify({ ...JSON.parse(await readFile(policyPath, "utf8")), generatedPaths: [".t3"] }));
    const result = await cleanupLandedWorkspace(workspace.workspacePath);
    assert.equal(result.reason, "unique-files", JSON.stringify(result));
    assert.ok(existsSync(join(workspace.workspacePath, ".t3", "review", "issue-7-review.md")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a preview running inside a landed checkout keeps it until it stops, and a queued landing keeps its checkout", async () => {
  const f = await project(declared);
  const preview = { stop: () => {} };
  try {
    const previewed = await landedWorkspace(f, "previewed");
    await mkdir(join(previewed.workspacePath, "apps", "web"), { recursive: true });
    const server = spawn("sleep", ["60"], { cwd: join(previewed.workspacePath, "apps", "web"), stdio: "ignore" });
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit));
    preview.stop = () => server.kill();

    // A checkout with no work of its own whose recorded landing is queued: its artifact (made in
    // another checkout) is not on main yet, so only the queued-landing guard can keep it.
    const queued = await createWorkspace("queued", f.repo);
    const source = await createWorkspace("queued source", f.repo);
    await writeFile(join(source.workspacePath, "queued.txt"), "queued\n");
    jj(source.workspacePath, ["describe", "-m", "Queued"]);
    const artifact = jj(source.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    await writeFile(statePath(queued.current.name), JSON.stringify({
      version: 1, workspaceName: queued.current.name, workspacePath: queued.workspacePath, integrationRoot: f.repo,
      integrationBranch: "main", artifactCommitId: artifact, artifactChangeId: "queued", phase: "prepared",
    }));

    const options = { now: later() };
    const plan = Object.fromEntries((await planDisposableWorkspaces(f.repo, options)).map((entry) => [entry.name, entry]));
    assert.equal(plan[previewed.current.name]?.action, "keep");
    assert.match(plan[previewed.current.name]?.reason ?? "", /live process: pid \d+/);
    assert.equal(plan[queued.current.name]?.state, "landed");
    assert.equal(plan[queued.current.name]?.action, "keep");
    assert.equal(plan[queued.current.name]?.reason, "landing-queued");
    let swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(!swept.removed.includes(previewed.current.name) && !swept.removed.includes(queued.current.name));
    assert.ok(existsSync(previewed.workspacePath) && existsSync(queued.workspacePath));

    preview.stop();
    await exited;
    swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(swept.removed.includes(previewed.current.name), "once the preview stops, the landed checkout retires");
    assert.ok(existsSync(queued.workspacePath), "the queued landing's checkout is still kept");
  } finally {
    preview.stop();
    await f.dispose();
  }
}, 120_000);
