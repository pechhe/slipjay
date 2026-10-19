import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createWorkspace, unusedWorkspaceStartRefusal } from "../../src/lib/workspace/workspace-create.ts";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);

function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, _stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }));
  });
}

test("starting an Issue from a session's own unused workspace points to attach-issue and allocates nothing", async () => {
  const f = await project();
  try {
    const session = await createWorkspace("session", f.repo);
    const before = names(f.repo);

    const started = await runCli(session.workspacePath, ["start", "--integration", "--issue", "7", "Issue work"]);
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /slipjay attach-issue 7/);
    assert.deepEqual(names(f.repo), before, "no second workspace");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a workspace with work, an Issue's workspace, or an Issue that already has one may still start", async () => {
  const f = await project();
  try {
    const session = await createWorkspace("session", f.repo);
    const other = await createWorkspace("other", f.repo);
    await attachWorkspaceIssue(other.workspacePath, 8);
    assert.equal(await unusedWorkspaceStartRefusal(session.workspacePath, 8), null, "resuming Issue #8's workspace proceeds");

    // A surviving checkout JJ no longer lists is recovered by the start, never attached elsewhere.
    const survivor = await createWorkspace("survivor", f.repo, { issueNumber: 12 });
    jj(f.repo, ["workspace", "forget", survivor.current.name]);
    assert.equal(await unusedWorkspaceStartRefusal(session.workspacePath, 12), null, "recovering Issue #12's checkout proceeds");

    const issueBound = await createWorkspace("bound", f.repo);
    await attachWorkspaceIssue(issueBound.workspacePath, 9);
    assert.equal(await unusedWorkspaceStartRefusal(issueBound.workspacePath, 10), null, "an Issue's workspace may start another Issue's");

    await writeFile(join(session.workspacePath, "work.txt"), "work\n");
    assert.equal(await unusedWorkspaceStartRefusal(session.workspacePath, 11), null, "a workspace with work may start another");
    assert.equal(await unusedWorkspaceStartRefusal(f.repo, 11), null, "the integration checkout starts as before");
  } finally {
    await f.dispose();
  }
}, 120_000);
