import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { pruneWorkspaceState } from "../../src/lib/workspace/workspace-state-prune.ts";
import { landedHome, lockHome, metadataHome, stateHome, workspaceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { occupy } from "./fixtures/workspace-housekeeping-fixture.ts";

/** A pid that has exited. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  return child.pid!;
}

test("state of vanished workspaces and all retired local-landing state is pruned; undeterminable or in-flight workspace records are kept", async () => {
  const f = await project();
  const holder = occupy(f.root);
  try {
    const live = await createWorkspace("live", f.repo);
    const dead = await deadPid();
    const integrated = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
    for (const dir of [metadataHome(), lockHome(), landedHome()]) await mkdir(dir, { recursive: true });
    const record = (name: string, extra = {}) => ({ version: 1, workspaceName: name, workspacePath: join(workspaceHome(), name), integrationRoot: f.repo, ...extra });
    const landing = (name: string, extra = {}) => ({ ...record(name), integrationBranch: "main", artifactCommitId: integrated, artifactChangeId: "x", ...extra });

    await write(join(metadataHome(), "ghost.json"), record("ghost", { issueNumber: 9 }));
    await write(join(lockHome(), "ghost.json"), { version: 1, workspaceName: "ghost", pid: dead });
    await write(join(stateHome(), "ghost.json"), landing("ghost", { phase: "landed" }));
    // A repository that no longer exists registers nothing.
    await write(join(metadataHome(), "vanished-repo.json"), record("vanished-repo", { integrationRoot: join(f.root, "no-such-repo") }));
    // Kept: in flight, undeterminable or evidence.
    await write(join(metadataHome(), "ghost-spare.json"), record("ghost-spare", { spare: true, prepared: false, preparingPid: process.pid }));
    await write(join(stateHome(), "ghost-prepared.json"), landing("ghost-prepared", { phase: "prepared" }));
    await write(join(stateHome(), "ghost-unproven.json"), landing("ghost-unproven", { phase: "landed", artifactCommitId: "f".repeat(40) }));
    await write(join(metadataHome(), "elsewhere.json"), record("elsewhere", { integrationRoot: f.root }));
    await write(join(lockHome(), "ghost-live.json"), { version: 1, workspaceName: "ghost-live", pid: process.pid });
    await write(join(landedHome(), "artifact-abc.json"), landing("ghost", { phase: "landed" }));
    // What local landings left behind goes whatever it holds: slot locks, waiters and post-land runs.
    const retired = [join(stateHome(), "verification-slot-feedface"), join(stateHome(), "verification-slot-feedface.waiting"), join(stateHome(), "post-land")];
    for (const path of retired) await mkdir(path, { recursive: true });
    await write(join(stateHome(), "verification-slot-feedface.waiting", "y.json"), { id: "y", pid: holder.pid });
    await write(join(stateHome(), "post-land", "abc.json"), { version: 1, commit: "abc", status: "running" });
    const removed = await pruneWorkspaceState();
    assert.ok(removed.includes("workspaces/ghost.json") || removed.some((path) => path.endsWith("ghost.json")), JSON.stringify(removed));
    for (const gone of [join(metadataHome(), "ghost.json"), join(metadataHome(), "vanished-repo.json"), join(lockHome(), "ghost.json"), join(stateHome(), "ghost.json"), ...retired]) {
      assert.equal(existsSync(gone), false, gone);
    }
    for (const kept of [join(metadataHome(), "ghost-spare.json"), join(stateHome(), "ghost-prepared.json"), join(stateHome(), "ghost-unproven.json"),
      join(metadataHome(), "elsewhere.json"), join(lockHome(), "ghost-live.json"), join(landedHome(), "artifact-abc.json"),
      join(metadataHome(), `${live.current.name}.json`)]) {
      assert.equal(existsSync(kept), true, kept);
    }
    assert.ok((await readdir(landedHome())).some((file) => file.startsWith("artifact-") && file !== "artifact-abc.json"), "the ghost's integrated delivery was archived before its sidecar went");
  } finally {
    holder.dispose();
    await f.dispose();
  }
}, 120_000);
