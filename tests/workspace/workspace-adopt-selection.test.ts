import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { planDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { jj, project } from "../support/workspace-project.ts";
import { writtenLandingHandoff } from "../../src/lib/landing/submission-adoptions.ts";
import { helperScope, validSubmissionHandoff } from "../../src/lib/landing/submission-handoff.ts";
import { occupy } from "./fixtures/workspace-sweep-fixture.ts";
import { isolateAdoptionFixtures, runCli, handoffFor, freezeLead, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

test("undoing a second adoption keeps the first revision's evolution anchor", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    jj(helper.workspacePath, ["new"]);
    await writeFile(join(helper.workspacePath, "second.txt"), "second contribution\n");
    jj(helper.workspacePath, ["describe", "-m", "Second contribution"]);
    const second = (await revisionFacts(helper.workspacePath, "@")).commitId;
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    jj(lead.workspacePath, ["undo"]);
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const warnings: string[] = [];
    const handoff = await writtenLandingHandoff((await workspaceContext(lead.workspacePath))!, "undo-second", source, false,
      async () => handoffFor(source), (message) => warnings.push(message));
    assert.deepEqual(handoff!.helpers.map((entry) => entry.revision), [revision]);
    assert.match(warnings.join("\n"), new RegExp(`Dropped adoption ${second}`));
  } finally { await f.dispose(); }
});

test("large helper scope collapses directories and a large adoption still freezes a valid handoff", async () => {
  const paths = Array.from({ length: 80 }, (_, index) => `src/${index % 2 ? "one" : "two"}/${"x".repeat(40)}-${index}.ts`);
  assert.equal(helperScope(paths), "src/two\nsrc/one");
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper } = await contribution(f);
    jj(helper.workspacePath, ["new"]);
    await Promise.all(Array.from({ length: 50 }, (_, index) => writeFile(join(helper.workspacePath, `bulk-${index}-${"x".repeat(70)}.txt`), "helper\n")));
    jj(helper.workspacePath, ["describe", "-m", "Large helper"]);
    const revision = (await revisionFacts(helper.workspacePath, "@")).commitId;
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const handoff = await freezeLead(lead.workspacePath, source);
    assert.equal(handoff!.helpers.find((entry) => entry.revision === revision)!.scope, ".");
    assert.equal(validSubmissionHandoff(handoff), true);
  } finally { await f.dispose(); }
});

test("a conflict in a second revision abandons only its duplicates without divergent changes", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper } = await contribution(f);
    jj(helper.workspacePath, ["new"]);
    await writeFile(join(helper.workspacePath, "second.txt"), "helper version\n");
    jj(helper.workspacePath, ["describe", "-m", "Second helper revision"]);
    await writeFile(join(lead.workspacePath, "second.txt"), "lead version\n");
    const before = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const visible = jj(lead.workspacePath, ["log", "-r", "all()", "--no-graph", "-T", 'commit_id ++ "\\n"']);
    const metadata = await workspaceMetadata(lead.current.name);
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /conflicts.*second.txt/s);
    assert.equal((await revisionFacts(lead.workspacePath, "@")).commitId, before);
    assert.equal(jj(lead.workspacePath, ["log", "-r", "all()", "--no-graph", "-T", 'commit_id ++ "\\n"']), visible);
    assert.equal(jj(lead.workspacePath, ["log", "-r", "divergent()", "--no-graph", "-T", "commit_id"]), "");
    assert.deepEqual(await workspaceMetadata(lead.current.name), metadata);
    assert.equal(existsSync(join(lead.workspacePath, "helper.txt")), false);
    const operations = jj(lead.workspacePath, ["op", "log", "--no-graph", "-T", 'description ++ "\\n"']);
    assert.doesNotMatch(operations, /(?:restore|revert) (?:to |operation)|op (?:restore|revert)/);
  } finally { await f.dispose(); }
});

test("adoption selects only helper commits; pending coverage protects remove and prune", async () => {
  const f = await project({ policy: { spares: 0 } });
  let release = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    release = occupy(helper.workspacePath);
    const adopted = JSON.parse((await runCli(lead.workspacePath, "adopt", helper.workspacePath, "--json")).stdout);
    release();
    assert.deepEqual(adopted, { workspaceName: helper.current.name, base, revisions: [revision] });
    assert.equal(await readFile(join(lead.workspacePath, "helper.txt"), "utf8"), "helper\n");
    assert.equal(jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "description"]), "Adopt helper");
    await assert.rejects(removeWorkspace(f.repo, helper.current.name), /adopted, landing not published/);
    const planned = (await planDisposableWorkspaces(f.repo, { emptyIdleMs: 0 })).find((item) => item.name === helper.current.name)!;
    assert.equal(planned.reason, "adopted, landing not published");
  } finally { release(); await f.dispose(); }
});

test("conflict rollback preserves lead tree, description, ancestry and metadata; dirty described helper refuses", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper } = await contribution(f);
    await writeFile(join(lead.workspacePath, "helper.txt"), "conflicting lead\n");
    const before = jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const metadata = await workspaceMetadata(lead.current.name);
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /conflict.*helper.txt/s);
    assert.equal(jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), before);
    assert.deepEqual(await workspaceMetadata(lead.current.name), metadata);
    assert.equal(await readFile(join(lead.workspacePath, "helper.txt"), "utf8"), "conflicting lead\n");
    await writeFile(join(helper.workspacePath, "helper.txt"), "edited after description\n");
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /edited since its last snapshot/);
  } finally { await f.dispose(); }
});

test("adoption bounds refuse an unrelated base, over 32 revisions and a merge", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, base, revision } = await contribution(f);
    const helperMetadata = await workspaceMetadata(helper.current.name);
    await writeFile(metadataPath(helper.current.name), JSON.stringify({ ...helperMetadata, adoptionBase: revision }));
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /not an ancestor/);
    await writeFile(metadataPath(helper.current.name), JSON.stringify(helperMetadata));
    const leadMetadata = await workspaceMetadata(lead.current.name);
    await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...leadMetadata, adoptions: [{ workspaceName: "earlier", base,
      revisions: Array.from({ length: 32 }, (_, index) => (index + 1).toString(16).padStart(40, "0")) }] }));
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /at most 32/);
    await writeFile(metadataPath(lead.current.name), JSON.stringify(leadMetadata));
    jj(helper.workspacePath, ["new", base]);
    await writeFile(join(helper.workspacePath, "sibling.txt"), "sibling\n");
    jj(helper.workspacePath, ["describe", "-m", "Sibling"]);
    const sibling = jj(helper.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(helper.workspacePath, ["new", revision, sibling]);
    await writeFile(join(helper.workspacePath, "merge.txt"), "merge\n");
    jj(helper.workspacePath, ["describe", "-m", "Merge"]);
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), /merge commit/);
  } finally { await f.dispose(); }
});

test("legacy creation identity recovers the pinned base and multiple helper revisions stay ordered", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, base, revision } = await contribution(f);
    const { adoptionBase: _base, ...metadata } = (await workspaceMetadata(helper.current.name))!;
    await writeFile(metadataPath(helper.current.name), JSON.stringify(metadata));
    jj(helper.workspacePath, ["new"]);
    await writeFile(join(helper.workspacePath, "helper.txt"), "second helper revision\n");
    jj(helper.workspacePath, ["describe", "-m", "Second"]);
    const second = jj(helper.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(helper.workspacePath, ["new"]);
    const adopted = await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    assert.deepEqual(adopted, { workspaceName: helper.current.name, base, revisions: [revision, second] });
    assert.equal(await readFile(join(lead.workspacePath, "helper.txt"), "utf8"), "second helper revision\n");
    const before = jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    assert.equal(jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), before);
  } finally { await f.dispose(); }
});
