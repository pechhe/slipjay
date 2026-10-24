import { jj, project } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { occupy } from "./fixtures/workspace-housekeeping-fixture.ts";
import { landedState } from "./fixtures/landed-state.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));

const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);

type Fixture = Awaited<ReturnType<typeof project>>;

/** Seed a delivered checkout for the cleanup race. */
async function landedWorkspace(f: Fixture, task: string, file = `${task}.txt`) {
  // See landedState's coverage contract for the retained runner/CLI transitions.
  return landedState(f, task, file);
}

test("an edit made after cleanup's checks is kept, not orphaned by the forget", async () => {
  const f = await project();
  try {
    const workspace = await landedWorkspace(f, "race");
    const raced = await cleanupLandedWorkspace(workspace.workspacePath, {
      afterChecks: () => writeFile(join(workspace.workspacePath, "late.txt"), "late\n"),
    });
    assert.deepEqual(raced, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name), "the workspace is still registered");
    assert.equal(jj(workspace.workspacePath, ["diff", "-r", "@", "--summary"]), "A late.txt", "the edit sits in the workspace's own commit");
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: false, reason: "new-unlanded-work" });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("landing removes its own workspace, naming any other process that holds it", async () => {
  const f = await project();
  const holder = { dispose: () => {}, pid: 0 };
  try {
    const gone = await createWorkspace("alone", f.repo);
    await writeFile(join(gone.workspacePath, "alone.txt"), "alone\n");
    jj(gone.workspacePath, ["describe", "-m", "Add alone"]);
    await withTestRunner(f, async (runner) => {
      const alone = await landOnTestRunner(runner, gone.workspacePath);
      assert.equal(alone.ok, true, alone.lines.join("\n"));
      assert.ok(!alone.lines.some((line) => line.startsWith("Kept landed workspace")), alone.lines.join("\n"));
      assert.equal(existsSync(gone.workspacePath), false);
      assert.ok(!names(f.repo).includes(gone.current.name));

      const held = await createWorkspace("held", f.repo);
      Object.assign(holder, occupy(held.workspacePath));
      await writeFile(join(held.workspacePath, "held.txt"), "held\n");
      jj(held.workspacePath, ["describe", "-m", "Add held"]);
      const kept = await landOnTestRunner(runner, held.workspacePath);
      assert.equal(kept.ok, true, kept.lines.join("\n"));
      assert.match(kept.lines.join("\n"), new RegExp(`Kept landed workspace ${held.current.name}: .*pid ${holder.pid} \\(sleep\\)`));
      assert.ok(existsSync(held.workspacePath));
      holder.dispose();
      assert.equal((await cleanupLandedWorkspace(held.workspacePath)).cleaned, true, "slipjay cleanup still works as before");
    });
  } finally {
    holder.dispose();
    await f.dispose();
  }
}, 180_000);

test("the CLI's own working directory inside the workspace does not keep it after `slipjay land`", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("cli", f.repo);
    await writeFile(join(workspace.workspacePath, "cli.txt"), "cli\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add cli"]);
    const { stdout, stderr } = await withTestRunner(f, ({ env }) => new Promise<{ stdout: string; stderr: string }>((resolveRun, reject) => {
      execFile("bun", [cli, "land"], { cwd: workspace.workspacePath, env }, (error, out, err) => (error ? reject(Object.assign(error, { stderr: err })) : resolveRun({ stdout: out, stderr: err })));
    }));
    assert.equal(JSON.parse(stdout).ok, true, stderr);
    assert.match(stderr, /in the background/);
    // Released after the verdict by the detached housekeeping, which ignores the CLI's own processes.
    await vi.waitFor(() => assert.equal(existsSync(workspace.workspacePath), false), { timeout: 120_000, interval: 100 });
  } finally {
    await f.dispose();
  }
}, 180_000);
