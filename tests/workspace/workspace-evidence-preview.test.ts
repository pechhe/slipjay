import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { holdWorkspace } from "../support/workspace-holder.ts";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { statePath } from "../../src/lib/workspace/workspace-state.ts";
import { later, declared, landedWorkspace } from "./fixtures/workspace-evidence-fixture.ts";

test("a preview running inside a landed checkout keeps it until it stops, and a queued landing keeps its checkout", async () => {
  const f = await project(declared);
  const preview = { stop: () => {} };
  try {
    const previewed = await landedWorkspace(f, "previewed");
    await mkdir(join(previewed.workspacePath, "apps", "web"), { recursive: true });
    const server = holdWorkspace(join(previewed.workspacePath, "apps", "web"));
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
