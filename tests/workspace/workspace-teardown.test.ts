import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { landedState } from "./fixtures/landed-state.ts";
import { cleanupLandedWorkspace, removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { runWorkspaceTeardown } from "../../src/lib/workspace/workspace-teardown.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";

/** A teardown that records the cwd it ran in and whether the checkout still had its files. */
const recording = (log: string) => ({
  workspaceTeardown: {
    executable: "node",
    args: ["-e", `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(log)},process.cwd()+" "+fs.existsSync("README.md")+"\\n")`],
  },
});

test("pending transport facts keep a workspace until delivery is acknowledged", async () => {
  const f = await project();
  try {
    const ws = await createWorkspace("pending facts", f.repo);
    const metadata = await workspaceMetadata(ws.current.name);
    await writeFile(metadataPath(ws.current.name), JSON.stringify({ ...metadata, pendingRunnerFacts: [{ id: "pending" }] }));
    await assert.rejects(removeWorkspace(f.repo, ws.current.name), /pending runner facts/);
    assert.equal(existsSync(ws.workspacePath), true);
    assert.deepEqual((await workspaceMetadata(ws.current.name))?.pendingRunnerFacts, [{ id: "pending" }]);
    await writeFile(metadataPath(ws.current.name), JSON.stringify({ ...metadata, pendingRunnerFacts: [] }));
    await removeWorkspace(f.repo, ws.current.name);
    assert.equal(existsSync(ws.workspacePath), false);
  } finally { await f.dispose(); }
}, 120_000);

test("cleanup runs the declared teardown in the workspace before deleting it", async () => {
  const f = await project();
  const log = join(f.root, "teardown.log");
  try {
    // See landedState's coverage contract: cleanup is the subject here; the retained
    // runner/CLI cleanup tests cover the landing that produces this state.
    const ws = await landedState(f, "landed");
    // After the seed: its restore rewrites the integration checkout's working copy.
    await writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ ...JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8")), ...recording(log) }));
    const result = await cleanupLandedWorkspace(ws.workspacePath);
    assert.equal(result.cleaned, true);
    assert.equal(await readFile(log, "utf8"), `${ws.workspacePath} true\n`);
    assert.equal(existsSync(ws.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("remove, prune and sweep each run the teardown; a failing or missing one never blocks", async () => {
  const f = await project();
  const log = join(f.root, "teardown.log");
  const policy = async (workspaceTeardown: unknown) =>
    writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ ...JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8")), workspaceTeardown }));
  try {
    await policy(recording(log).workspaceTeardown);
    const removed = await createWorkspace("removed", f.repo);
    await removeWorkspace(f.repo, removed.current.name);
    const pruned = await createWorkspace("pruned", f.repo);
    assert.deepEqual((await pruneEmptyWorkspaces(f.repo)).removed, [pruned.current.name]);
    const swept = await createWorkspace("swept", f.repo);
    assert.deepEqual((await sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000 })).removed, [swept.current.name]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"),
      [removed, pruned, swept].map((ws) => `${ws.workspacePath} true`));

    await policy({ executable: "node", args: ["-e", "process.exit(3)"] });
    const failing = await createWorkspace("failing", f.repo);
    await removeWorkspace(f.repo, failing.current.name);
    assert.equal(existsSync(failing.workspacePath), false, "a non-zero exit does not block removal");

    await policy({ executable: "slipjay-no-such-teardown", args: [] });
    const missing = await createWorkspace("missing", f.repo);
    await removeWorkspace(f.repo, missing.current.name);
    assert.equal(existsSync(missing.workspacePath), false, "a missing executable does not block removal");
    assert.ok(!jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).includes(missing.current.name));
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a teardown that hangs is killed at its timeout and reported as failed", async () => {
  const f = await project({ policy: { workspaceTeardown: { executable: "node", args: ["-e", "setTimeout(()=>{},60000)"] } } });
  try {
    const started = Date.now();
    const result = await runWorkspaceTeardown(f.repo, { name: "hung", root: f.repo }, { timeoutMs: 500 });
    assert.deepEqual(result, { ran: true, ok: false });
    assert.ok(Date.now() - started < 20_000);
  } finally {
    await f.dispose();
  }
});

test("workspaceTeardown is validated with the other slipjay.json keys", () => {
  const parse = (workspaceTeardown: unknown) => parseExecutionPolicy(JSON.stringify({ version: 1, workspaceTeardown }));
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1 })).workspaceTeardown, undefined);
  assert.deepEqual(parse({ executable: "ys-preview", args: ["stop"] }).workspaceTeardown, { executable: "ys-preview", args: ["stop"] });
  assert.deepEqual(parse({ executable: "ys-preview" }).workspaceTeardown, { executable: "ys-preview", args: [] });
  for (const bad of ["ys-preview", [], { args: [] }, { executable: "bin/stop", args: [] }, { executable: "x", args: "stop" }, { executable: "x", args: [1] }])
    assert.throws(() => parse(bad), /workspaceTeardown/);
});
