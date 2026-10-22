import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../src/lib/workspace/workspace-finalization.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { frozenAdoptions, workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { bindLandingOperation, writtenLandingHandoff } from "../../src/lib/landing/submission-adoptions.ts";
import { isolateAdoptionFixtures, handoffFor, freezeLead, contribution, publishSource } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

for (const removal of ["undo", "back-out"] as const) {
  test(`freeze drops an adoption removed by ${removal} and publication never covers its helper`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, base, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      if (removal === "undo") jj(lead.workspacePath, ["undo"]);
      else jj(lead.workspacePath, ["restore", "--from", base, "helper.txt"]);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      const warnings: string[] = [];
      const frozen = await writtenLandingHandoff(context, "dropped", source, false, async () => ({ ...handoffFor(source),
        helpers: [{ revision, base, scope: "helper.txt" }] }), (line) => warnings.push(line));
      assert.deepEqual(frozen!.helpers, []);
      assert.match(warnings.join("\n"), /Dropped adoption.*no longer present/);
      assert.deepEqual((await workspaceMetadata(lead.current.name))!.adoptions, []);
      await bindLandingOperation(context, "dropped", "dropped");
      const state = await publishSource(f, lead, source, "dropped");
      await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "uncovered");
      await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
    } finally { await f.dispose(); }
  });
}

test("freeze consumes pending adoption once, replays it on retry, and does not resend it after publication", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    await writeFile(join(lead.workspacePath, "helper.txt"), "reworked after adoption\n");
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const context = (await workspaceContext(lead.workspacePath))!;
    const first = await writtenLandingHandoff(context, "first", source, false, async () => handoffFor(source));
    assert.equal(first!.helpers[0]!.revision, revision);
    assert.deepEqual((await workspaceMetadata(lead.current.name))!.adoptions, []);
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    const replay = await writtenLandingHandoff(context, "first", source, false, async () => { throw new Error("must replay"); });
    assert.deepEqual(replay, first);
    await bindLandingOperation(context, "first", "first");
    const state = await publishSource(f, lead, source, "first");
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
    jj(lead.workspacePath, ["new"]);
    await writeFile(join(lead.workspacePath, "later.txt"), "later landing\n");
    const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const next = await writtenLandingHandoff(context, "next", later, false, async () => handoffFor(later));
    assert.deepEqual(next!.helpers, []);
    assert.equal(((await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: unknown[] }>).first!.adoptions.length, 1);
  } finally { await f.dispose(); }
});

test("a replacement freeze carries unpublished adoptions and removes stale pending ownership", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    const firstSource = (await revisionFacts(lead.workspacePath, "@")).commitId;
    await freezeLead(lead.workspacePath, firstSource, "failed");
    await writeFile(join(lead.workspacePath, "fix.txt"), "fix failed verification\n");
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    // Untracked landings have no automatic handoff once pending adoptions were consumed.
    const context = (await workspaceContext(lead.workspacePath))!;
    const next = await writtenLandingHandoff(context, "replacement", source, false, async (hasAdoptions) => {
      assert.equal(hasAdoptions, true, "carried-only helpers use the caller's default handoff");
      return { ...handoffFor(source), intent: "Real repaired contribution" };
    }, undefined, async () => ({ type: "failed", stage: "verifying", reason: "Fixture verification failed" }));
    assert.equal(next!.intent, "Real repaired contribution");
    assert.deepEqual(next!.helpers.map((entry) => entry.revision), [revision]);
    await bindLandingOperation(context, "replacement", "replacement");
    const records = (await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: unknown[] }>;
    assert.deepEqual(records.failed!.adoptions, []);
    const state = await publishSource(f, lead, source, "replacement");
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
    await removeWorkspace(f.repo, helper.current.name);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { await f.dispose(); }
});

test("a queued replacement freezes both copies before submission and consumes the old one only on confirmed supersession", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const context = (await workspaceContext(lead.workspacePath))!;
    await freezeLead(lead.workspacePath, source, "first");
    await writeFile(join(lead.workspacePath, "later.txt"), "replacement\n");
    const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const handoff = await writtenLandingHandoff(context, "next", later, false, async (hasAdoptions) => {
      assert.equal(hasAdoptions, true);
      return handoffFor(later);
    }, undefined, undefined, [{ id: "first", commitId: source }]);
    assert.deepEqual(handoff!.helpers.map((entry) => entry.revision), [revision]);
    const before = (await workspaceMetadata(lead.current.name))!;
    const records = frozenAdoptions(before.landingAdoptions);
    assert.deepEqual(records.first!.adoptions, records.next!.adoptions, "a crash before POST leaves both freezes recoverable");
    assert.equal(records.first!.adoptions.length, 1);
    const replay = await writtenLandingHandoff(context, "next", later, false, async () => { throw new Error("must replay"); });
    assert.deepEqual(replay, handoff);
    await bindLandingOperation(context, "next", "replacement", "first");
    const after = (await workspaceMetadata(lead.current.name))!;
    assert.deepEqual(frozenAdoptions(after.landingAdoptions).first!.adoptions, []);
    assert.equal(frozenAdoptions(after.landingAdoptions).next!.adoptions.length, 1);
    assert.equal((after.pendingLandingRequests as Record<string, string>).first, undefined);
    // Simulate losing the POST response: the runner knows the replacement, but
    // local state still holds both copies from immediately before that POST.
    await writeFile(metadataPath(lead.current.name), JSON.stringify(before));
    await writeFile(join(lead.workspacePath, "last.txt"), "retry after a lost response\n");
    const last = (await revisionFacts(lead.workspacePath, "@")).commitId;
    await writtenLandingHandoff(context, "last", last, false, async () => handoffFor(last), undefined,
      async () => ({ type: "superseded", by: "replacement" }), [{ id: "replacement", commitId: later }]);
    const recovered = frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions);
    assert.deepEqual(recovered.first!.adoptions, []);
    assert.equal(recovered.next!.adoptions.length, 1);
    assert.deepEqual(recovered.last!.adoptions.flatMap((item) => item.revisions), [revision], "copied and carried evidence is deduplicated");
    await bindLandingOperation(context, "last", "last-operation", "replacement");
    assert.deepEqual(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions).next!.adoptions, []);
  } finally { await f.dispose(); }
});

test("an unaccepted replacement cannot resend a live or published predecessor's copied adoption", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const context = (await workspaceContext(lead.workspacePath))!;
    await freezeLead(lead.workspacePath, source, "first");
    await writeFile(join(lead.workspacePath, "next.txt"), "replacement\n");
    const next = (await revisionFacts(lead.workspacePath, "@")).commitId;
    await writtenLandingHandoff(context, "refused", next, false, async () => handoffFor(next), undefined, undefined, [{ id: "first", commitId: source }]);
    const metadata = (await workspaceMetadata(lead.current.name))!;
    const copied = frozenAdoptions(metadata.landingAdoptions).refused!;
    // A definite refusal releases the request; it does not prove that the first
    // operation (which might now be running) cannot still publish.
    await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata, pendingLandingRequests: {} }));
    const waiting = await writtenLandingHandoff(context, "while-running", next, false, async () => handoffFor(next));
    assert.deepEqual(waiting!.helpers, []);
    assert.equal(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions).first!.adoptions.length, 1);
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    const state = await publishSource(f, lead, source, "first");
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
    const published = (await workspaceMetadata(lead.current.name))!;
    await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...published,
      landingAdoptions: { ...published.landingAdoptions as object, "unsubmitted-copy": copied } }));
    const after = await writtenLandingHandoff(context, "after-publication", next, false, async () => handoffFor(next));
    assert.deepEqual(after!.helpers, [], "archived adoption coverage spends an unsubmitted copy too");
    const records = frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions);
    assert.deepEqual(records.first!.adoptions.flatMap((record) => record.revisions), [revision], "published provenance stays with its original operation");
    assert.deepEqual(records["after-publication"]!.adoptions, []);
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
  } finally { await f.dispose(); }
});

test("frozen adoption records and handoffs share retention while unresolved submissions survive", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead } = await contribution(f);
    const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
    const keys = Array.from({ length: 40 }, (_, index) => `old-${index}`);
    const metadata = await workspaceMetadata(lead.current.name);
    await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata,
      pendingLandingRequests: { "old-0": "unresolved" },
      landingAdoptions: Object.fromEntries(keys.map((key) => [key, { source, adoptions: [] }])),
      landingHandoffs: Object.fromEntries(keys.map((key) => [key, handoffFor(source)])),
    }));
    await freezeLead(lead.workspacePath, source, "new");
    const result = (await workspaceMetadata(lead.current.name))!;
    const frozen = result.landingAdoptions as Record<string, unknown>;
    assert.deepEqual(Object.keys(frozen), Object.keys(result.landingHandoffs as object));
    assert.ok(frozen["old-0"]);
    assert.equal(frozen["old-1"], undefined);
    const pending = result.pendingLandingRequests as Record<string, unknown>;
    assert.equal(Object.keys(frozen).filter((key) => !pending[key]).length, 32);
  } finally { await f.dispose(); }
});
