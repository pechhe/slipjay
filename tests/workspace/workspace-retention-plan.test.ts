import { jj, landThroughTestRunner, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { attachWorkspaceIssue, createWorkspace, planDisposableWorkspaces, provisionSpare, sweepDisposableWorkspaces } from "../../src/lib/slipjay.ts";
import type { PlannedWorkspace } from "../../src/lib/slipjay.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../src/lib/workspace/workspace-finalization.ts";
import { stateHome } from "../../src/lib/workspace/workspace-paths.ts";
import { lockPath, metadataPath, statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

/** A process working inside `cwd` until disposed, as a live session would be. */
function occupy(cwd: string) {
  const child = spawn("sleep", ["60"], { cwd, stdio: "ignore" });
  return () => child.kill();
}

/** Every file under `root` with its size and modification time, so any write shows. */
async function fingerprint(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await stat(path).catch(() => null);
        found.push(`${path}\t${info?.size}\t${info?.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return found.sort();
}

const byName = (plan: PlannedWorkspace[]) => Object.fromEntries(plan.map((entry) => [entry.name, entry]));

async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Held while it lands, so the landing keeps it for the test.
  const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(result.ok, true, result.lines.join("\n"));
  return workspace;
}

test("the plan explains every workspace, changes nothing, and the sweep then does what it planned", async () => {
  const f = await project({ ignore: "notes/\n" });
  const release: Array<() => void> = [];
  try {
    const delivered = await landed(f, "delivered.txt");
    const idle = await createWorkspace("idle", f.repo);
    const occupied = await createWorkspace("occupied", f.repo);
    const owned = await createWorkspace("owned", f.repo);
    const notes = await createWorkspace("notes", f.repo);
    const open = await createWorkspace("open", f.repo);
    const unknown = await createWorkspace("unknown", f.repo);
    const edited = await createWorkspace("edited", f.repo);
    const corrupt = await createWorkspace("corrupt", f.repo);
    const owing = await createWorkspace("owing", f.repo);
    await attachWorkspaceIssue(open.workspacePath, 41);
    await attachWorkspaceIssue(unknown.workspacePath, 42);
    await provisionSpare(f.repo);
    release.push(occupy(occupied.workspacePath));
    await mkdir(join(lockPath(owned.current.name), ".."), { recursive: true });
    await writeFile(lockPath(owned.current.name), JSON.stringify({ version: 1, pid: process.pid }));
    await mkdir(join(notes.workspacePath, "notes"));
    await writeFile(join(notes.workspacePath, "notes", "draft.md"), "mine\n");
    await writeFile(metadataPath(corrupt.current.name), "{ not json");
    await writeFile(metadataPath(owing.current.name), JSON.stringify({ ...await workspaceMetadata(owing.current.name), pendingRunnerFacts: [{ id: "pending" }] }));
    // An edit JJ has not snapshotted yet: only a snapshot would show it as work.
    await writeFile(join(edited.workspacePath, "README.md"), "edited\n");

    // Issue #42's tracker read fails outright: its state is unknown, not a sweep failure.
    const options = { now: later(), issueClosed: (_root: string, issue: number) => { if (issue === 41) return false; throw new Error("tracker down"); } };
    const roots = [stateHome(), join(f.repo, ".jj"), ...[delivered, idle, edited, notes].map((workspace) => join(workspace.workspacePath, ".jj"))];
    const before = await Promise.all(roots.map(fingerprint));
    const plan = await planDisposableWorkspaces(f.repo, options);
    assert.deepEqual(await Promise.all(roots.map(fingerprint)), before, "the plan writes no state, operation or working copy");

    const entries = byName(plan);
    const reason = (workspace: { current: { name: string } }) => entries[workspace.current.name]?.reason ?? "";
    assert.equal(entries.default?.action, "keep");
    assert.equal(entries.default?.state, "integration");
    assert.match(reason(occupied), /live process: pid \d+/);
    assert.ok(entries[occupied.current.name]?.holders?.length, "the plan names the live process");
    assert.match(reason(owned), /live process/);
    assert.match(reason(notes), /notes\/draft\.md/);
    assert.deepEqual(entries[notes.current.name]?.uniqueFiles, ["notes/draft.md"]);
    assert.match(reason(open), /issue #41 open/);
    assert.match(reason(unknown), /issue #42 state unknown/, "an unreadable Issue state is unknown, never a pass");
    assert.match(reason(edited), /edited since its last snapshot: README\.md/);
    assert.equal(reason(corrupt), "metadata unreadable", "unreadable metadata is unknown, never a pass");
    assert.match(reason(owing), /pending runner facts/, "the plan applies removal's own refusals");
    const spare = plan.find((entry) => entry.state === "spare");
    assert.equal(spare?.action, "keep");
    assert.equal(spare?.reason, "prepared spare");
    assert.equal(entries[idle.current.name]?.action, "remove");
    assert.equal(entries[delivered.current.name]?.action, "remove");
    assert.equal(entries[delivered.current.name]?.state, "landed");
    assert.deepEqual(entries[delivered.current.name]?.landing, { phase: "landed", published: true });
    assert.equal(entries[idle.current.name]?.landing, null);
    for (const entry of plan) {
      assert.equal(entry.repository, f.repo);
      assert.ok(entry.sizeBytes && entry.sizeBytes > 0, `${entry.name} has a size`);
    }

    const removals = plan.filter((entry) => entry.action === "remove").map((entry) => entry.name).sort();
    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.deepEqual([...swept.removed].sort(), removals, "the sweep removes exactly what the plan said it would");
    for (const kept of [occupied, owned, notes, open, unknown, edited, corrupt, owing]) assert.ok(existsSync(kept.workspacePath), kept.current.name);
  } finally {
    for (const dispose of release) dispose();
    await f.dispose();
  }
}, 240_000);

test("a landed workspace with pending housekeeping is planned as kept, without finishing it", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "pending.txt");
    const path = statePath(workspace.current.name);
    const state = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...state, cleanupPending: true, cleanupError: "interrupted" }));
    const before = await readFile(path, "utf8");
    const plan = byName(await planDisposableWorkspaces(f.repo));
    assert.equal(plan[workspace.current.name]?.action, "keep");
    assert.equal(plan[workspace.current.name]?.reason, "housekeeping-pending");
    assert.equal(await readFile(path, "utf8"), before, "the plan leaves the landing's housekeeping to cleanup");
    assert.ok(existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a landing record naming another delivery's archived artifact is kept, with the same reason by plan and sweep", async () => {
  const f = await project({ ignore: "*.local\n" });
  try {
    const workspace = await landed(f, "copied.txt");
    const state = JSON.parse(await readFile(statePath(workspace.current.name), "utf8"));
    // The artifact was already retained as another workspace's landing.
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), { ...state, workspaceName: "earlier-delivery" });
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    assert.match(planned?.reason ?? "", /already archived as workspace earlier-delivery's landing.*slipjay remove /);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name));
    assert.equal(swept.skipped.find((entry) => entry.name === workspace.current.name)?.reason, planned?.reason);
    assert.ok(existsSync(workspace.workspacePath));
    // The removal the reason suggests works: the checkout is judged as one that never landed,
    // so a file no history holds still keeps it.
    const remove = () => new Promise<{ code: number; stderr: string }>((resolveRun) => {
      execFile("bun", [cli, "remove", workspace.workspacePath], { cwd: f.repo }, (error, _stdout, stderr) =>
        resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }));
    });
    const notes = join(workspace.workspacePath, "notes.local");
    await writeFile(notes, "only here\n");
    const kept = await remove();
    assert.equal(kept.code, 1);
    assert.match(kept.stderr, /holds files cleanup will not delete: notes\.local/);
    assert.ok(existsSync(notes));
    await rm(notes);
    const removed = await remove();
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(!existsSync(workspace.workspacePath));
    assert.ok(!jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).includes(workspace.current.name));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("prune --plan --json prints the plan, and prune refuses unknown flags", async () => {
  const f = await project();
  try {
    const idle = await createWorkspace("idle", f.repo);
    const runCli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
      execFile("bun", [cli, ...args], { cwd: f.repo }, (error, stdout, stderr) =>
        resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
    });
    const automatic = await runCli(["prune", "--plan", "--json"]);
    assert.equal(automatic.code, 0, automatic.stderr);
    assert.equal(byName(JSON.parse(automatic.stdout))[idle.current.name]?.reason, "assigned within the idle period");
    const explicit = await runCli(["prune", "--empty", "--plan", "--json"]);
    assert.equal(byName(JSON.parse(explicit.stdout))[idle.current.name]?.action, "remove", "with --empty the plan is the explicit prune's");
    assert.ok(existsSync(idle.workspacePath), "planning removes nothing");
    assert.notEqual((await runCli(["prune", "--json"])).code, 0);
    assert.ok(jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).includes(idle.current.name));
  } finally {
    await f.dispose();
  }
}, 120_000);
