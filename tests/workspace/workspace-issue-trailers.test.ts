import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { attachWorkspaceIssue, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import * as commands from "../../src/lib/infra/workspace-jj.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { releaseWorkspace } from "../../src/lib/workspace/workspace-release.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { jj, project } from "../support/workspace-project.ts";
import { fixtureJjSetting, setFixtureJjSetting } from "../support/jj-user-config.ts";

test.each(["attach", "bind"] as const)("an unclaimed spare refuses an item via %s without writing config or leaking a trailer", async (method) => {
  const f = await project({ policy: { tracker: "forge", spares: 1 } });
  try {
    const spare = await provisionSpare(f.repo);
    assert.ok(spare.provisioned);
    assert.ok("workspacePath" in spare);
    assert.ok(spare.workspacePath);
    assert.ok(spare.name);
    const item = method === "attach" ? 6191 : 6192;
    const before = await workspaceMetadata(spare.name);
    const config = jj(spare.workspacePath, ["config", "list", "--workspace", KEY, "-T", "name"]);
    const sparePath = spare.workspacePath;
    const attach = () => method === "attach"
      ? attachWorkspaceIssue(sparePath, item)
      : createWorkspace("Item inside spare", sparePath, { issueNumber: item });
    await assert.rejects(attach, new RegExp(`unclaimed pool spare.*slipjay start --integration --issue ${item}`));
    assert.deepEqual(await workspaceMetadata(spare.name), before);
    assert.equal(jj(spare.workspacePath, ["config", "list", "--workspace", KEY, "-T", "name"]), config);
    assert.equal(config, "");
    jj(spare.workspacePath, ["describe", "-m", "Still a spare"]);
    assert.equal(description(spare.workspacePath), "Still a spare");
    const claimed = await createWorkspace(`no-item-after-${method}`, f.repo);
    assert.equal(claimed.workspacePath, spare.workspacePath);
    jj(claimed.workspacePath, ["describe", "-m", "Unbound claim"]);
    assert.equal(description(claimed.workspacePath), "Unbound claim");
    // The refusal is for an unclaimed spare only: a start that claims one for an item still gets its trailer.
    await provisionSpare(f.repo);
    const forItem = await createWorkspace(`item-claims-spare-${method}`, f.repo, { issueNumber: item });
    assert.equal(forItem.pooled, true);
    jj(forItem.workspacePath, ["describe", "-m", "Item claim"]);
    assert.equal(description(forItem.workspacePath), `Item claim\n\nForge: #${item}`);
  } finally { await f.dispose(); }
}, 120_000);

const KEY = "templates.commit_trailers";
const description = (cwd: string, revision = "@") => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "description"]);

test("attachment is workspace-only, repeatable, and refused reassignment changes neither config nor description", async () => {
  const f = await project({ policy: { tracker: "forge" } });
  try {
    const a = await createWorkspace("attached-trailers", f.repo);
    const b = await createWorkspace("unbound-trailers", f.repo);
    await attachWorkspaceIssue(a.workspacePath, 6111);
    const template = jj(a.workspacePath, ["config", "get", KEY]);
    await attachWorkspaceIssue(a.workspacePath, 6111);
    assert.equal(jj(a.workspacePath, ["config", "get", KEY]), template);
    jj(a.workspacePath, ["describe", "-m", "Subject"]);
    const before = description(a.workspacePath);
    await assert.rejects(attachWorkspaceIssue(a.workspacePath, 6112), /already belongs/);
    assert.equal(jj(a.workspacePath, ["config", "get", KEY]), template);
    jj(a.workspacePath, ["describe", "-m", "Subject"]);
    assert.equal(description(a.workspacePath), before);
    assert.equal(before, "Subject\n\nForge: #6111");
    for (const cwd of [b.workspacePath, f.repo]) {
      jj(cwd, ["describe", "-m", "Unbound"]);
      assert.equal(description(cwd), "Unbound");
    }
  } finally { await f.dispose(); }
}, 120_000);

test.each(["user", "repo", "workspace"] as const)("%s trailer templates compose with the item without duplicates", async (scope) => {
  const f = await project({ policy: { tracker: "build" } });
  const prior = fixtureJjSetting(KEY) ?? "";
  try {
    const a = await createWorkspace(`compose-${scope}`, f.repo);
    const base = '"Signed-off-by: Fixture <fixture@example.com>\\nChange-Id: I123\\n"';
    if (scope === "user") setFixtureJjSetting(KEY, base);
    else jj(a.workspacePath, ["config", "set", `--${scope}`, KEY, JSON.stringify(base)]);
    await attachWorkspaceIssue(a.workspacePath, { user: 6120, repo: 6121, workspace: 6122 }[scope]);
    jj(a.workspacePath, ["describe", "-m", "Subject"]);
    const item = { user: 6120, repo: 6121, workspace: 6122 }[scope];
    assert.equal(description(a.workspacePath), `Subject\n\nSigned-off-by: Fixture <fixture@example.com>\nChange-Id: I123\nBuild: #${item}`);
    jj(a.workspacePath, ["describe", "-m", description(a.workspacePath)]);
    assert.equal(description(a.workspacePath).match(/Build: /g)?.length, 1);

  } finally {
    if (scope === "user") setFixtureJjSetting(KEY, prior);
    await f.dispose();
  }
}, 120_000);

test("resuming an older attached workspace installs its missing trailer template", async () => {
  const f = await project({ policy: { tracker: "forge" } });
  try {
    const a = await createWorkspace("resume-trailers", f.repo, { issueNumber: 6123 });
    jj(a.workspacePath, ["config", "unset", "--workspace", KEY]);
    const resumed = await createWorkspace("resume-trailers", f.repo, { issueNumber: 6123 });
    assert.equal(resumed.workspacePath, a.workspacePath);
    jj(resumed.workspacePath, ["describe", "-m", "Resumed"]);
    assert.equal(description(resumed.workspacePath), "Resumed\n\nForge: #6123");
  } finally { await f.dispose(); }
}, 120_000);

test("describe and commit add the item with both messages and an editor", async () => {
  const f = await project({ policy: { tracker: "forge" } });
  try {
    const a = await createWorkspace("editor-trailers", f.repo, { issueNumber: 6131 });
    const editor = join(f.root, "editor.cjs");
    await writeFile(editor, 'const fs = require("node:fs"); const path = process.argv[2]; fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace(/^[^\\n]*/, "Edited subject"));');
    const edit = ["--config", `ui.editor=${JSON.stringify(["node", editor])}`];
    jj(a.workspacePath, [...edit, "describe"]);
    assert.equal(description(a.workspacePath), "Edited subject\n\nForge: #6131");
    for (const args of [["commit", "-m", "Commit subject"], [...edit, "commit"]]) {
      await writeFile(join(a.workspacePath, "work.txt"), JSON.stringify(args));
      jj(a.workspacePath, args);
      assert.ok(description(a.workspacePath, "@-").endsWith("Forge: #6131"));
      assert.equal(description(a.workspacePath, "@-").match(/Forge: /g)?.length, 1);
    }
  } finally { await f.dispose(); }
}, 120_000);

test.each(["release", "cleanup"] as const)("%s discards the item checkout: its name can start without a trailer and restart for the same item", async (method) => {
  const f = await project({ policy: { tracker: "forge", spares: 0 } });
  try {
    const item = method === "release" ? 6141 : 6142;
    const a = await createWorkspace(`retire-${method}`, f.repo, { issueNumber: item });
    if (method === "release") {
      const result = await releaseWorkspace(a.workspacePath, { operationId: `trailer-${method}`, processes: [] });
      assert.equal(result.state, "retired", JSON.stringify(result));
    } else {
      await removeWorkspace(f.repo, a.current.name, { allowWork: true, allowIssue: true });
    }
    const unbound = await createWorkspace(String(item), f.repo);
    assert.equal(unbound.current.name, a.current.name);
    assert.equal(unbound.workspacePath, a.workspacePath);
    jj(unbound.workspacePath, ["describe", "-m", "Unbound"]);
    assert.equal(description(unbound.workspacePath), "Unbound");
    await removeWorkspace(f.repo, unbound.current.name, { allowWork: true });
    const b = await createWorkspace(`retire-${method}`, f.repo, { issueNumber: item });
    assert.equal(b.current.name, a.current.name);
    jj(b.workspacePath, ["describe", "-m", "New work"]);
    assert.equal(description(b.workspacePath), `New work\n\nForge: #${item}`);

  } finally { await f.dispose(); }
}, 120_000);

test.each(["scope", "write"] as const)("refused workspace config %s never blocks start or attachment", async (failure) => {
  const f = await project({ policy: { tracker: "build" } });
  const original = commands.jj;
  const spy = vi.spyOn(commands, "jj").mockImplementation(async (cwd, args, ...rest) => {
    if (args.includes("--workspace") && (failure === "scope" || args.includes("set"))) throw new Error("workspace config unavailable");
    return original(cwd, args, ...rest);
  });
  try {
    const item = failure === "scope" ? 6161 : 6171;
    const started = await createWorkspace(`config-refused-${failure}`, f.repo, { issueNumber: item });
    jj(started.workspacePath, ["describe", "-m", "Still works"]);
    assert.equal(description(started.workspacePath), "Still works");
    const attached = await createWorkspace(`attach-config-refused-${failure}`, f.repo);
    await attachWorkspaceIssue(attached.workspacePath, item + 1);
    jj(attached.workspacePath, ["describe", "-m", "Still attaches"]);
    assert.equal(description(attached.workspacePath), "Still attaches");
  } finally { spy.mockRestore(); await f.dispose(); }
}, 120_000);
