import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { cleanupLandedWorkspace, forgetWorkspace, missingCheckoutRefusal, removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { attachWorkspaceIssue, metadataPath, statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { planDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../src/lib/workspace/workspace-finalization.ts";
import { pruneWorkspaceState } from "../../src/lib/workspace/workspace-state-prune.ts";
import { readLandingHandoff } from "../../src/lib/runner/runner-client.ts";
import { controlRunner, dropSupersededCandidate, LandingNotSubmitted, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { frozenAdoptions, workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { jj, project } from "../support/workspace-project.ts";
import { waitForExit, withTestRunner } from "../support/test-runner.ts";
import { bindLandingOperation, writtenLandingHandoff } from "../../src/lib/landing/submission-adoptions.ts";
import { helperScope, validSubmissionHandoff } from "../../src/lib/landing/submission-handoff.ts";
import type { SubmissionHandoff } from "../../src/lib/landing/submission-handoff.ts";
import type { Operation } from "../../src/lib/runner/runner-contract.ts";
import { land, occupy } from "./fixtures/workspace-sweep-fixture.ts";
import { landedHome, slipjayHome } from "../../src/lib/workspace/workspace-paths.ts";
import { emptyTrash } from "../../src/lib/workspace/workspace-trash.ts";
import { drainFixtureWorkers } from "../support/fixture-workers.ts";
import { workspaceTransactionLocks } from "../../src/lib/infra/workspace-transaction.ts";

beforeEach(async () => {
  assert.deepEqual(await readdir(slipjayHome()).catch(() => []), [], "each adoption fixture starts with its own SlipJay state");
});

afterEach(async () => {
  // Join the exact workers this fixture started, including workers started by
  // its CLI children and housekeeping, rather than probing host-wide processes.
  await drainFixtureWorkers();
  await emptyTrash();
  assert.deepEqual(await workspaceTransactionLocks(), [],
    "fixture workers must release their transactions before the next test");
  // project.dispose() deletes the repository, but intentionally retained helper
  // checkouts and sidecars live here. Leaving them in this file's shared HOME
  // makes later machine-wide sweeps probe every earlier, deleted repository.
  // All delivery/retention assertions above have finished; discard only this
  // hermetic file's state after its background workers have quiesced.
  await rm(slipjayHome(), { recursive: true, force: true, maxRetries: 3 });
});

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const runCli = (cwd: string, ...args: string[]) => promisify(execFile)("bun", [cli, ...args], { cwd, env: process.env, timeout: 60_000 });
const handoffFor = (source: string): SubmissionHandoff => ({ version: 1, source, intent: "Fixture", scope: [], spec: null, helpers: [], checks: [], reviews: [], toolchain: [], gaps: [] });

async function freezeLead(root: string, source: string, key = "fixture") {
  const context = (await workspaceContext(root))!;
  const handoff = await writtenLandingHandoff(context, key, source, false, async () => handoffFor(source));
  await bindLandingOperation(context, key, key);
  return handoff;
}

async function contribution(f: Awaited<ReturnType<typeof project>>) {
  const lead = await createWorkspace("adopting lead", f.repo);
  await writeFile(join(lead.workspacePath, "lead.txt"), "lead\n");
  jj(lead.workspacePath, ["describe", "-m", "Lead base"]);
  jj(lead.workspacePath, ["new"]);
  const base = jj(lead.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  const helper = await createWorkspace("helper", f.repo, { base });
  await writeFile(join(helper.workspacePath, "helper.txt"), "helper\n");
  jj(helper.workspacePath, ["describe", "-m", "Helper contribution"]);
  const revision = jj(helper.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  jj(lead.workspacePath, ["describe", "-m", "Adopt helper"]);
  return { lead, helper, revision, base };
}

async function publishSource(f: Awaited<ReturnType<typeof project>>, lead: Awaited<ReturnType<typeof createWorkspace>>, source: string, operationId: string) {
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["restore", "--from", source]);
  jj(f.repo, ["describe", "-m", "Published fixture"]);
  const published = await revisionFacts(f.repo, "@");
  jj(f.repo, ["bookmark", "set", "main", "-r", published.commitId]);
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["git", "push", "--bookmark", "main"]);
  return { version: 1, phase: "landed" as const, cleanupPending: false, workspaceName: lead.current.name,
    workspacePath: lead.workspacePath, integrationRoot: f.repo, integrationBranch: "main", operationId,
    artifactCommitId: published.commitId, artifactChangeId: published.changeId };
}

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

for (const outcome of ["running", "integrating", "finalizing", "publishing", "unknown-response"] as const) {
  test(`${outcome} adoption stays with its first submission when the lead relands`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      await writtenLandingHandoff(context, "first", source, false, async () => handoffFor(source));
      if (outcome !== "unknown-response") await bindLandingOperation(context, "first", "first");
      if (outcome === "running") {
        // The runner acknowledged the first request, but has not published it.
        // Later acknowledged submissions must not evict its live provenance.
        const metadata = (await workspaceMetadata(lead.current.name))!;
        const filler = Array.from({ length: 35 }, (_, index) => `acknowledged-${index}`);
        await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata, pendingLandingRequests: {},
          landingAdoptions: { ...metadata.landingAdoptions as object, ...Object.fromEntries(filler.map((key) => [key, { source, adoptions: [] }])) },
          landingHandoffs: { ...metadata.landingHandoffs as object, ...Object.fromEntries(filler.map((key) => [key, handoffFor(source)])) },
        }));
      }
      await writeFile(join(lead.workspacePath, "later.txt"), "reland while the first outcome is unresolved\n");
      const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const next = await writtenLandingHandoff(context, "next", later, false, async (hasAdoptions) => {
        assert.equal(hasAdoptions, false);
        return handoffFor(later);
      }, undefined, async (): Promise<Operation["result"]> =>
        outcome === "integrating" || outcome === "finalizing" || outcome === "publishing" ? { type: "failed", stage: outcome, reason: "unresolved publication" } : undefined);
      assert.deepEqual(next!.helpers, [], "unresolved helper evidence is not sent twice");
      const frozen = (await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: Array<{ revisions: string[] }> }>;
      assert.deepEqual(frozen.first!.adoptions.flatMap((record) => record.revisions), [revision]);
      assert.deepEqual(frozen.next!.adoptions, []);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    } finally { await f.dispose(); }
  });
}

for (const outcome of ["declined", "cancelled", "superseded", "never-submitted"] as const) {
  test(`${outcome} adoption can move to a replacement submission`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      await writtenLandingHandoff(context, "first", source, false, async () => handoffFor(source));
      if (outcome === "never-submitted") {
        const metadata = await workspaceMetadata(lead.current.name);
        await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata, pendingLandingRequests: {} }));
      } else await bindLandingOperation(context, "first", "first");
      await writeFile(join(lead.workspacePath, "fix.txt"), "replacement\n");
      const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const next = await writtenLandingHandoff(context, "next", later, false, async () => handoffFor(later), undefined,
        async (): Promise<Operation["result"]> => outcome === "declined" ? { type: "declined", reason: "declined", paths: [] }
          : outcome === "cancelled" ? { type: "cancelled", reason: "cancelled" }
            : outcome === "superseded" ? { type: "superseded", by: "another-submission" } : undefined);
      assert.deepEqual(next!.helpers.map((entry) => entry.revision), [revision]);
      assert.deepEqual(((await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: unknown[] }>).first!.adoptions, []);
      assert.equal(((await workspaceMetadata(lead.current.name))!.pendingLandingRequests as Record<string, string>).first, undefined);
    } finally { await f.dispose(); }
  });
}

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

for (const archival of ["cleanup", "prune"] as const) {
  test(`${archival} archives operation-bound adoption and source after publication without client follow-up`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, base, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      await freezeLead(lead.workspacePath, source);
      const review = await createWorkspace("review source", f.repo, { base: source });
      const state = await publishSource(f, lead, source, "fixture");
      await writeFile(statePath(lead.current.name), JSON.stringify(state));
      if (archival === "cleanup") assert.equal((await cleanupLandedWorkspace(lead.workspacePath)).cleaned, true,
        "published source ancestry must not keep the lead as new-unlanded-work");
      else await forgetWorkspace(f.repo, lead.current.name, lead.workspacePath);
      await pruneWorkspaceState();
      assert.equal(await workspaceMetadata(lead.current.name), null);
      const archives = await Promise.all((await readdir(landedHome())).filter((name) => name.startsWith("artifact-")).map(async (name) => JSON.parse(await readFile(join(landedHome(), name), "utf8"))));
      const archived = archives.find((record) => record.artifactCommitId === state.artifactCommitId);
      assert.equal(archived.publishedSource, source);
      assert.deepEqual(archived.adoptionCoverage, [{ workspaceName: helper.current.name, base, revisions: [revision] }]);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      assert.equal(await workspaceCoverage((await workspaceContext(review.workspacePath))!, review.current.name), "source-covered");
      await runCli(f.repo, "remove", helper.workspacePath);
      await sweepDisposableWorkspaces(f.repo, { emptyIdleMs: 0, pruneState: false });
      assert.equal(existsSync(review.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

test("allowWork preserves policy cleanup semantics; CLI discard still refuses a live holder", async () => {
  const f = await project({ ignore: "unique.txt\n", policy: { spares: 0 } });
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    const workspace = await createWorkspace("policy cleanup", f.repo);
    await writeFile(join(workspace.workspacePath, "work.txt"), "work\n");
    await writeFile(join(workspace.workspacePath, "unique.txt"), "material for explicit cleanup\n");
    jj(workspace.workspacePath, ["describe", "-m", "Work"]);
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: workspace.workspacePath, stdio: "ignore", detached: true });
    await assert.rejects(runCli(f.repo, "remove", "--discard", workspace.workspacePath), /live process/);
    holder.kill();
    await new Promise<void>((resolve) => holder!.once("exit", () => resolve()));
    holder = null;
    await removeWorkspace(f.repo, workspace.current.name, { allowWork: true, allowIssue: true });
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally { holder?.kill(); await f.dispose(); }
});

for (const resolution of ["closed", "discard", "unbound-cleanup"] as const) {
  test(`source-only coverage ${resolution === "unbound-cleanup" ? "delivers an unbound review workspace" : `preserves the open Issue guard until ${resolution}`}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const lead = await createWorkspace("source only", f.repo);
      await writeFile(join(lead.workspacePath, "source.txt"), "published source\n");
      jj(lead.workspacePath, ["describe", "-m", "Source only"]);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      assert.equal(await writtenLandingHandoff(context, "source-only", source, false, async () => undefined), undefined);
      await bindLandingOperation(context, "source-only", "source-only");
      const review = await createWorkspace("review only", f.repo, { base: source });
      if (resolution !== "unbound-cleanup") await attachWorkspaceIssue(review.workspacePath, 123);
      const state = await publishSource(f, lead, source, "source-only");
      await writeFile(statePath(lead.current.name), JSON.stringify(state));
      assert.equal((await cleanupLandedWorkspace(lead.workspacePath)).cleaned, true);
      assert.equal(await workspaceCoverage((await workspaceContext(review.workspacePath))!, review.current.name), "source-covered");
      if (resolution === "unbound-cleanup") {
        assert.equal((await cleanupLandedWorkspace(review.workspacePath)).cleaned, true);
        assert.equal(existsSync(review.workspacePath), false);
        return;
      }
      await assert.rejects(runCli(f.repo, "remove", review.workspacePath), /Issue|issue/);
      await sweepDisposableWorkspaces(f.repo, { pruneState: false, emptyIdleMs: 0, issueClosed: () => false });
      assert.equal(existsSync(review.workspacePath), true);
      if (resolution === "closed") await sweepDisposableWorkspaces(f.repo, { pruneState: false, emptyIdleMs: 0, issueClosed: () => true });
      else await runCli(f.repo, "remove", "--discard", review.workspacePath);
      assert.equal(existsSync(review.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

test("missing checkout removal ignores its own preparing pid and retains another live preparer", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const workspace = await createWorkspace("preparer", f.repo);
    const metadata = await workspaceMetadata(workspace.current.name);
    await rm(workspace.workspacePath, { recursive: true, force: true });
    const target = { ...workspace.current, root: workspace.workspacePath, metadata: { ...metadata, preparingPid: process.pid } };
    assert.equal(await missingCheckoutRefusal(f.repo, target), null);
    assert.match((await missingCheckoutRefusal(f.repo, { ...target, metadata: { ...target.metadata, preparingPid: process.ppid } }))!, /prepared by a live process/);
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

for (const path of ["remove", "prune", "sweep", "new-work"] as const) {
  test(`published adoption survives lead retirement: ${path}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    let release = () => {};
    try {
      const { lead, helper, revision, base } = await contribution(f);
      await attachWorkspaceIssue(helper.workspacePath, 123);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      await writeFile(join(lead.workspacePath, "helper.txt"), "helper reworked by lead\n");
      // A real helper process keeps it through the lead's post-publication sweep.
      release = occupy(helper.workspacePath);
      await withTestRunner(f, async ({ location, env }) => {
        const result = await landThroughRunner(lead.workspacePath, { location, env });
        assert.equal(result.ok, true);
        const handoff = await readLandingHandoff(location, result.operation!.id, env) as { handoff: { evidence: { helpers: unknown[] } } };
        assert.deepEqual(handoff.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
        if (result.housekeeping?.pid) await waitForExit(result.housekeeping.pid);
      });
      await cleanupLandedWorkspace(lead.workspacePath);
      assert.equal(existsSync(lead.workspacePath), false);
      release();
      if (path === "remove") await runCli(f.repo, "remove", helper.workspacePath);
      if (path === "prune") await runCli(f.repo, "prune", "--empty");
      if (path === "sweep") {
        const later = await createWorkspace("later landing", f.repo);
        await land(f, later.workspacePath, "later.txt");
      }
      if (path === "new-work") {
        jj(helper.workspacePath, ["workspace", "update-stale"]);
        jj(helper.workspacePath, ["new"]);
        await writeFile(join(helper.workspacePath, "new.txt"), "not adopted\n");
        jj(helper.workspacePath, ["describe", "-m", "New work"]);
        await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
        assert.equal((await planDisposableWorkspaces(f.repo, { emptyIdleMs: 0 })).find((item) => item.name === helper.current.name)!.action, "keep");
      } else assert.equal(existsSync(helper.workspacePath), false);
    } finally { release(); await f.dispose(); }
  }, 180_000);
}

test("a failed runner landing carries its adoption into the successful replacement", async () => {
  const f = await project({ policy: { spares: 0 }, verify: () => 'if (!require("node:fs").existsSync("fixed.txt")) process.exit(1)' });
  let release = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    release = occupy(helper.workspacePath);
    await withTestRunner(f, async ({ location, env }) => {
      const failed = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(failed.ok, false);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
      await writeFile(join(lead.workspacePath, "fixed.txt"), "verification fixed\n");
      const published = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(published.ok, true);
      assert.notEqual(published.operation!.id, failed.operation!.id);
      const retained = await readLandingHandoff(location, published.operation!.id, env) as { handoff: { evidence: { helpers: unknown[]; intent: string } } };
      assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
      assert.equal(retained.handoff.evidence.intent, "Adopt helper", "carried-only adoption uses the commit description");
      if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
    });
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
    release();
    await removeWorkspace(f.repo, helper.current.name);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); await f.dispose(); }
}, 180_000);

for (const lostResponse of [false, true]) {
  test(`a real queued landing is superseded by the reland that publishes its adoption${lostResponse ? " after a lost response" : ""}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    let release = () => {};
    try {
      const { lead, helper, revision, base } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      release = occupy(helper.workspacePath);
      await withTestRunner(f, async ({ location, env }) => {
        assert.equal((await controlRunner(location, "pause", env)).ok, true);
        const abort = new AbortController();
        let firstId = "";
        await assert.rejects(landThroughRunner(lead.workspacePath, { location, env, signal: abort.signal,
          onOperation: (id) => { firstId = id; abort.abort(); } }));
        assert.ok(firstId);
        await writeFile(join(lead.workspacePath, "later.txt"), "superseding candidate\n");
        let nextId = "";
        let observedFreeze = false;
        const fetch = globalThis.fetch;
        const observing = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          if (String(input) === `${location}/v1/operations` && init?.method === "POST") {
            const records = Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions));
            assert.equal(records.filter((record) => record.adoptions.length).length, 2, "both copies are durable before the superseding POST");
            observedFreeze = true;
          }
          const response = await fetch(input, init);
          if (lostResponse && String(input) === `${location}/v1/operations` && init?.method === "POST") {
            await response.arrayBuffer();
            return new Response("lost superseding response body");
          }
          return response;
        });
        let publishing: ReturnType<typeof landThroughRunner> | undefined;
        let published: Awaited<ReturnType<typeof landThroughRunner>> | undefined;
        try {
          if (lostResponse) {
            await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }), /outcome is unknown/);
            assert.equal(Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions))
              .filter((record) => record.adoptions.length).length, 2, "both copies survive a lost acknowledgement");
          }
          publishing = landThroughRunner(lead.workspacePath, { location, env, onOperation: (id) => { nextId = id; } });
          void publishing.catch(() => {});
          await vi.waitFor(() => assert.ok(nextId), { timeout: 30_000 });
          assert.equal(observedFreeze, true);
          const response = await fetch(`${location}/v1/operations/${firstId}`, { headers: { authorization: `Bearer ${env.SLIPJAY_RUNNER_TOKEN}` } });
          const old = await response.json() as { operation: Operation };
          assert.deepEqual(old.operation.result, { type: "superseded", by: nextId });
          const records = Object.values(frozenAdoptions((await workspaceMetadata(lead.current.name))!.landingAdoptions));
          assert.deepEqual(records.find((record) => record.operationId === firstId)!.adoptions, []);
          assert.deepEqual((await workspaceMetadata(lead.current.name))!.pendingLandingRequests, {});
        } finally {
          observing.mockRestore();
          await controlRunner(location, "resume", env);
          // Join the follower even when an assertion fails, before the runner
          // fixture drains workers and closes its service.
          if (publishing) published = await publishing;
        }
        assert.ok(published);
        assert.equal(published.ok, true);
        const retained = await readLandingHandoff(location, nextId, env) as { handoff: { evidence: { helpers: unknown[] } } };
        assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
        if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
      });
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      release();
      await removeWorkspace(f.repo, helper.current.name);
      assert.equal(existsSync(helper.workspacePath), false);
    } finally { release(); await f.dispose(); }
  }, 180_000);
}

test("a real 422 refusal releases its pending request and a new candidate publishes the adoption", async () => {
  const f = await project({ policy: { spares: 0 } });
  let release = () => {};
  let releaseLead = () => {};
  try {
    const { lead, helper, revision, base } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    release = occupy(helper.workspacePath);
    releaseLead = occupy(lead.workspacePath);
    await writeFile(join(lead.workspacePath, "README.md"), "lead version\n");
    // Publish a conflicting change without going through the runner being tested.
    await writeFile(join(f.repo, "README.md"), "upstream version\n");
    jj(f.repo, ["describe", "-m", "Upstream README"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    jj(f.repo, ["git", "push", "--bookmark", "main"]);
    jj(f.repo, ["new", "main"]);
    await withTestRunner(f, async ({ location, env }) => {
      await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }),
        (error) => error instanceof LandingNotSubmitted && /conflict/i.test(error.message));
      const refused = (await workspaceMetadata(lead.current.name))!;
      assert.deepEqual(refused.pendingLandingRequests, {});
      const firstKey = Object.keys(frozenAdoptions(refused.landingAdoptions))[0]!;
      assert.equal(frozenAdoptions(refused.landingAdoptions)[firstKey]!.adoptions.length, 1);
      // Back out only the conflicting lead edit; the helper stays in the candidate.
      await writeFile(join(lead.workspacePath, "README.md"), "fixture\n");
      const published = await landThroughRunner(lead.workspacePath, { location, env });
      assert.equal(published.ok, true);
      const retained = await readLandingHandoff(location, published.operation.id, env) as { handoff: { evidence: { helpers: unknown[] } } };
      assert.deepEqual(retained.handoff.evidence.helpers, [{ revision, base, scope: "helper.txt" }]);
      const after = (await workspaceMetadata(lead.current.name))!;
      assert.equal(Object.keys(frozenAdoptions(after.landingAdoptions)).length, 2, "reland used a new source key");
      assert.deepEqual(frozenAdoptions(after.landingAdoptions)[firstKey]!.adoptions, []);
      assert.deepEqual(after.pendingLandingRequests, {});
      if (published.housekeeping?.pid) await waitForExit(published.housekeeping.pid);
    });
    assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
    release();
    await removeWorkspace(f.repo, helper.current.name);
    assert.equal(existsSync(helper.workspacePath), false);
  } finally { release(); releaseLead(); await f.dispose(); }
}, 180_000);

test("a lost real submission response keeps its pending identity and adoption evidence", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, revision } = await contribution(f);
    await adoptWorkspace(lead.workspacePath, helper.workspacePath);
    await withTestRunner(f, async ({ location, env }) => {
      await controlRunner(location, "pause", env);
      const fetch = globalThis.fetch;
      const losing = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const response = await fetch(input, init);
        if (String(input) === `${location}/v1/operations` && init?.method === "POST") {
          assert.equal(response.ok, true, "runner accepted the real request before its response was lost");
          await response.arrayBuffer();
          return new Response("lost response body");
        }
        return response;
      });
      try { await assert.rejects(landThroughRunner(lead.workspacePath, { location, env }), /outcome is unknown/); }
      finally { losing.mockRestore(); }
      const metadata = (await workspaceMetadata(lead.current.name))!;
      assert.equal(Object.keys(metadata.pendingLandingRequests as object).length, 1);
      const records = Object.values(frozenAdoptions(metadata.landingAdoptions));
      assert.deepEqual(records.flatMap((record) => record.adoptions.flatMap((item) => item.revisions)), [revision]);
      assert.equal(records[0]!.operationId, undefined, "unacknowledged acceptance stays unresolved");
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    });
  } finally { await f.dispose(); }
}, 180_000);

test("explicit discard retains pending runner facts and unique files", async () => {
  const f = await project({ ignore: "unique.txt\n", policy: { spares: 0 } });
  try {
    const helper = await createWorkspace("unadopted", f.repo);
    await writeFile(join(helper.workspacePath, "work.txt"), "unlanded\n");
    jj(helper.workspacePath, ["describe", "-m", "Work"]);
    await attachWorkspaceIssue(helper.workspacePath, 123);
    await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
    await writeFile(join(helper.workspacePath, "unique.txt"), "only here\n");
    const discard = { allowWork: true, allowIssue: true, retainMaterial: true };
    await assert.rejects(removeWorkspace(f.repo, helper.current.name, discard), /unique|files cleanup/);
    await assert.rejects(runCli(f.repo, "remove", "--discard", helper.workspacePath), /unique|files cleanup/);
    const metadata = await workspaceMetadata(helper.current.name);
    await writeFile(metadataPath(helper.current.name), JSON.stringify({ ...metadata, pendingRunnerFacts: [{ id: "pending" }] }));
    await assert.rejects(removeWorkspace(f.repo, helper.current.name, discard), /pending runner facts/);
    await assert.rejects(runCli(f.repo, "remove", "--discard", helper.workspacePath), /pending runner facts/);
  } finally { await f.dispose(); }
});

for (const kind of ["unbound", "issue", "landed"] as const) {
  test(`remove --discard explicitly removes ${kind} unlanded work`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const workspace = await createWorkspace(`discard ${kind}`, f.repo);
      if (kind === "issue") await attachWorkspaceIssue(workspace.workspacePath, 123);
      if (kind === "landed") await land(f, workspace.workspacePath, "delivered.txt", { keep: true });
      await writeFile(join(workspace.workspacePath, "new.txt"), "unlanded\n");
      jj(workspace.workspacePath, ["describe", "-m", "Unlanded work"]);
      await assert.rejects(runCli(f.repo, "remove", workspace.workspacePath), /Kept/);
      await runCli(f.repo, "remove", "--discard", workspace.workspacePath);
      assert.equal(existsSync(workspace.workspacePath), false);
    } finally { await f.dispose(); }
  }, 180_000);
}

for (const path of ["remove", "prune", "cleanup", "new-work"] as const) {
  test(`archived coverage judges original helper revisions after author state is pruned: ${path}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper } = await contribution(f);
      await attachWorkspaceIssue(helper.workspacePath, 123);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      await writeFile(join(lead.workspacePath, "helper.txt"), "reworked\n");
      // Focused archive fixture: integration and the published archive are already established.
      // The tests above exercise their creation through the real publishing runner.
      const artifactCommitId = jj(lead.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      await freezeLead(lead.workspacePath, artifactCommitId);
      jj(f.repo, ["bookmark", "set", "main", "-r", artifactCommitId]);
      jj(f.repo, ["git", "push", "--bookmark", "main"]);
      await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), {
        version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath,
        integrationRoot: f.repo, integrationBranch: "main", artifactCommitId, operationId: "fixture",
      });
      await removeWorkspace(f.repo, lead.current.name, { retainMaterial: true });
      await pruneWorkspaceState();
      assert.equal(await workspaceMetadata(lead.current.name), null);
      if (path === "remove") await runCli(f.repo, "remove", helper.workspacePath);
      if (path === "prune") await sweepDisposableWorkspaces(f.repo, { emptyIdleMs: 0, issueClosed: () => false });
      if (path === "cleanup") assert.equal((await cleanupLandedWorkspace(helper.workspacePath)).cleaned, true);
      if (path === "new-work") {
        jj(helper.workspacePath, ["new"]);
        await writeFile(join(helper.workspacePath, "new.txt"), "unadopted\n");
        await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
      } else assert.equal(existsSync(helper.workspacePath), false);
    } finally { await f.dispose(); }
  });
}

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

test("historical handoff helpers without archived adoption coverage never authorise deletion", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, base, revision } = await contribution(f);
    const artifactCommitId = jj(lead.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", artifactCommitId]);
    const state = { version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath, integrationRoot: f.repo,
      integrationBranch: "main", artifactCommitId, helpers: [{ revision, base, scope: "helper.txt" }] };
    await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
    await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
  } finally { await f.dispose(); }
});

for (const path of ["remove", "prune", "sweep", "new-work", "continuation", "shared-source", "shared-review-sweep", "shared-continuation"] as const) {
  test(`publication cleanup preserves the helper's pinned identity and archived coverage: ${path}`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await attachWorkspaceIssue(helper.workspacePath, 123);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      await writeFile(join(lead.workspacePath, "helper.txt"), "reworked for publication\n");
      const source = await revisionFacts(lead.workspacePath, "@");
      await freezeLead(lead.workspacePath, source.commitId);
      if (path === "continuation" || path === "shared-continuation") {
        jj(lead.workspacePath, ["new"]);
        await writeFile(join(lead.workspacePath, "follow-up.txt"), "first follow-up\n");
        jj(lead.workspacePath, ["describe", "-m", "First follow-up"]);
        jj(lead.workspacePath, ["new"]);
        await writeFile(join(lead.workspacePath, "next.txt"), "second follow-up\n");
        jj(lead.workspacePath, ["describe", "-m", "Second follow-up"]);
      }
      const dependentBase = path === "shared-continuation" ? (await revisionFacts(lead.workspacePath, "@")).commitId : source.commitId;
      const dependent = path === "shared-source" || path === "shared-review-sweep" || path === "shared-continuation" ? await createWorkspace("based on published source", f.repo, { base: dependentBase }) : null;
      // The runner flattens the source onto integration, with different commit identities.
      // Reproduce the client's post-publication transition without needing a listening runner.
      jj(f.repo, ["new", "main"]);
      jj(f.repo, ["restore", "--from", source.commitId]);
      jj(f.repo, ["describe", "-m", "Published flattened artifact"]);
      const published = await revisionFacts(f.repo, "@");
      jj(f.repo, ["bookmark", "set", "main", "-r", published.commitId]);
      jj(f.repo, ["new", "main"]);
      jj(f.repo, ["git", "push", "--bookmark", "main"]);
      await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), {
        version: 1, workspaceName: lead.current.name, workspacePath: lead.workspacePath,
        integrationRoot: f.repo, integrationBranch: "main", artifactCommitId: published.commitId, operationId: "fixture",
      });
      const lines: string[] = [];
      await dropSupersededCandidate(lead.workspacePath, lead.workspacePath, source, published.commitId, (line) => lines.push(line));
      if (path === "shared-continuation") assert.match(lines.join("\n"), /follow-up work shared/);
      else assert.deepEqual(lines, []);
      assert.equal((await revisionFacts(helper.workspacePath, "@", { ignoreWorkingCopy: true })).commitId, revision,
        "post-publication cleanup must not rebase a helper off its original lead base");
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "covered");
      if (path === "shared-continuation") {
        assert.equal(jj(dependent!.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), dependentBase);
        assert.equal((await revisionFacts(lead.workspacePath, "@")).commitId, dependentBase, "shared follow-up work stays untouched");
        return;
      }
      if (path === "continuation") {
        assert.equal(await readFile(join(lead.workspacePath, "follow-up.txt"), "utf8"), "first follow-up\n");
        assert.equal(await readFile(join(lead.workspacePath, "next.txt"), "utf8"), "second follow-up\n");
        const parents = jj(lead.workspacePath, ["log", "-r", `::@ & ${published.commitId}`, "--no-graph", "-T", "commit_id"]);
        assert.equal(parents, published.commitId, "both follow-ups are now on the published artifact");
        return;
      }
      if (dependent) {
        assert.equal(jj(dependent.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), source.commitId);
        assert.equal(await workspaceCoverage((await workspaceContext(dependent.workspacePath))!, dependent.current.name), "source-covered");
        if (path === "shared-source") await runCli(f.repo, "remove", dependent.workspacePath);
      }
      await removeWorkspace(f.repo, lead.current.name, { retainMaterial: true });
      assert.equal((await planDisposableWorkspaces(f.repo, { emptyIdleMs: 0 })).find((item) => item.name === helper.current.name)!.action, "remove");
      if (path === "remove" || path === "shared-source") await runCli(f.repo, "remove", helper.workspacePath);
      if (path === "prune") await runCli(f.repo, "prune", "--empty");
      if (path === "sweep" || path === "shared-review-sweep") await sweepDisposableWorkspaces(f.repo, { pruneState: false, issueClosed: () => false });
      if (path === "shared-review-sweep") assert.equal(existsSync(dependent!.workspacePath), false);
      if (path === "new-work") {
        jj(helper.workspacePath, ["workspace", "update-stale"]);
        jj(helper.workspacePath, ["new"]);
        await writeFile(join(helper.workspacePath, "new.txt"), "unadopted follow-up\n");
        jj(helper.workspacePath, ["describe", "-m", "Helper follow-up"]);
        assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "uncovered");
        await assert.rejects(removeWorkspace(f.repo, helper.current.name), /unlanded work/);
      } else assert.equal(existsSync(helper.workspacePath), false);
    } finally { await f.dispose(); }
  });
}
