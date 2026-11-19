import assert from "node:assert/strict";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { holdWorkspace } from "../support/workspace-holder.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { abandonedCustodyNote, acquireWorkspaceClaim, releaseAbandonedRetirementFences, STALE_CUSTODY_IDLE_MS, withUnclaimedWorkspace, workspaceClaimRefusal, workspaceClaimStatus } from "../../src/lib/workspace/workspace-claims.ts";
import { goneController, writeRetirementFence } from "./fixtures/workspace-fence.ts";
import type { ClaimView } from "../../src/lib/workspace/workspace-claims.ts";
import { recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";
import { claimController } from "../../src/lib/workspace/workspace-claim-identity.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { writeWorkspaceJson } from "../../src/lib/infra/workspace-transaction.ts";

async function abandoned(root: string, path: string, name: string) {
  const controller = await claimController();
  assert.ok(controller);
  await acquireWorkspaceClaim(path, root, name, { requestId: "dead:acquire", ownerId: "dead", credential: "x".repeat(32), obligationRef: "dead:obligation", controller: { ...controller, pid: 2147483647 } });
}

const HOUR = 60 * 60_000;

/**
 * The metadata of an adopted checkout: kept under the workspace's name, which the Issue gave it, while the
 * directory keeps the spare's own name. Adoption moves the record rather than writing a second one.
 */
async function adoptMetadata(from: string, to: string, stamps: Record<string, unknown>) {
  const metadata = { ...await workspaceMetadata(from) };
  await writeWorkspaceJson(metadataPath(to), { ...metadata, workspaceName: to, ...stamps });
  await rm(metadataPath(from));
}

/** Metadata as a harness that never wrote an idle clock leaves it: the stamps it does carry, and nothing else. */
async function withoutIdleClock(name: string, stamps: Record<string, string>) {
  const existing = { ...await workspaceMetadata(name) };
  for (const key of ["lastActivityAt", "updatedAt", "claimedAt", "attachedAt"]) delete existing[key];
  await writeWorkspaceJson(metadataPath(name), { ...existing, ...stamps });
}

function claimView(over: Partial<ClaimView> = {}): ClaimView {
  return { claimId: "claim", ownerId: "custody:dead", generation: "generation", state: "recovery-required",
    reason: "controller identity unavailable or changed; settlement required", obligationRef: "t3:epoch", settlementRef: null,
    controller: { platform: "linux", pid: 2147483647, boot: "boot", start: "start" }, ...over };
}

test("a hold whose recorded controllers are gone names the wait that ends it", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("recovery-wait", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    await recordWorkspaceActivity(w.current.name, Date.now() - 3 * HOUR);
    const refusal = (await workspaceClaimRefusal(w.workspacePath))!;
    assert.match(refusal, /custody retained/);
    assert.match(refusal, /idle for 24h/, "the refusal names the host rule that settles it");
    assert.match(refusal, /2[01]h \d+m left/, "the refusal says how long the wait still is");
    assert.match(refusal, /claims release/, "the refusal names the owner's own settlement route");
  } finally { await f.dispose(); }
});

test("an abandoned note is only for custody that is actually abandoned", () => {
  const now = Date.now();
  const idle = { claims: [claimView()], controllersGone: true, lastActivityAt: now - 3 * HOUR, holders: null, now };
  assert.equal(abandonedCustodyNote({ ...idle, controllersGone: false }), "", "a live controller is not abandoned");
  assert.equal(abandonedCustodyNote({ ...idle, claims: [claimView({ state: "active" })] }), "", "an active claim is refused by its own state");
  assert.equal(abandonedCustodyNote({ ...idle, claims: [claimView({ controller: null })] }), "", "a missing identity proves nothing");
  assert.equal(abandonedCustodyNote({ ...idle, claims: [claimView({ state: "released" })] }), "", "an ended claim holds nothing");
  assert.match(abandonedCustodyNote({ ...idle, lastActivityAt: null }), /no activity time/);
  assert.match(abandonedCustodyNote({ ...idle, lastActivityAt: now - 25 * HOUR, holders: false }), /process is still using/);
  assert.match(abandonedCustodyNote({ ...idle, lastActivityAt: now - 25 * HOUR, holders: null }), /could not be read/);
  assert.equal(abandonedCustodyNote({ ...idle, lastActivityAt: now - 25 * HOUR, holders: true }), "", "nothing is left to explain");
});

test("confirmed-gone, 24h-idle custody settles only at the destructive fence", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("recovery-idle", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    assert.match((await workspaceClaimRefusal(w.workspacePath))!, /custody retained/);
    await recordWorkspaceActivity(w.current.name, Date.now() - STALE_CUSTODY_IDLE_MS - 60_000);
    assert.equal(await workspaceClaimRefusal(w.workspacePath), null);
    assert.equal((await workspaceClaimStatus(w.workspacePath)).claims[0]!.state, "recovery-required", "planning must not mutate custody");
    await withUnclaimedWorkspace(w.workspacePath, "test guarded destructive action", async (check) => { await check(); });
    const status = await workspaceClaimStatus(w.workspacePath);
    assert.equal(status.claims[0]!.state, "released");
    assert.equal(status.claims[0]!.settlementRef, "slipjay:confirmed-controller-gone-idle-24h");
  } finally { await f.dispose(); }
});

test("the hourly pass releases only a harmless fence whose controller is provably gone", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("fence-housekeeping", f.repo);
    await withUnclaimedWorkspace(w.workspacePath, "test guarded destructive action", async (check) => { await check(); });
    const fence = async (fence: Record<string, unknown> | null) => {
      await writeRetirementFence(w.workspacePath, fence);
      return (await workspaceClaimStatus(w.workspacePath)).retirement;
    };
    // A retirement whose process died before its point of no return: nothing was destroyed, so the
    // checkout admits work again instead of failing every claim on it for ever.
    await fence({ id: "abandoned", reason: "retire checkout", controller: goneController() });
    assert.deepEqual((await releaseAbandonedRetirementFences()).map((entry) => entry.reason), ["retire checkout"]);
    assert.equal((await workspaceClaimStatus(w.workspacePath)).retirement, null);
    assert.ok(await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, { requestId: "after:release", ownerId: "after", credential: "y".repeat(32), obligationRef: "after:obligation", controller: await claimController() }));

    const alive = await claimController();
    assert.ok(alive);
    assert.ok(await fence({ id: "live-owner", reason: "retire checkout", controller: alive }), "a live controller may still be destroying");
    assert.deepEqual(await releaseAbandonedRetirementFences(), [], "housekeeping needs proof the controller is gone");
    assert.ok((await workspaceClaimStatus(w.workspacePath)).retirement);

    assert.ok(await fence({ id: "uncertain", reason: "retire checkout", controller: goneController(), destructive: true }), "a destructive fence stays fenced, fail closed");
    assert.deepEqual(await releaseAbandonedRetirementFences(), [], "a fence past its point of no return is never released");
    assert.equal((await workspaceClaimStatus(w.workspacePath)).retirement?.destructive, true);

    const legacy = await fence({ id: "legacy", reason: "retire checkout" });
    assert.equal(legacy?.id, "legacy", "a legacy fence still loads and is reported");
    assert.equal((await workspaceClaimStatus(w.workspacePath)).reason, "retirement in progress or interrupted; recovery required");
    await assert.rejects(acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, { requestId: "during:legacy", ownerId: "during", credential: "z".repeat(32), obligationRef: "during:obligation", controller: await claimController() }), { code: "CLAIM_RETIRING" });
    assert.deepEqual(await releaseAbandonedRetirementFences(), [], "a fence that names no controller proves nothing");
    assert.equal((await workspaceClaimStatus(w.workspacePath)).retirement?.id, "legacy");
  } finally { await f.dispose(); }
});

test("a provider appearing after the read-only scan keeps stale custody at the fresh destructive check", async () => {
  const f = await project();
  let holder: ReturnType<typeof holdWorkspace> | undefined;
  try {
    const w = await createWorkspace("recovery-provider", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    await recordWorkspaceActivity(w.current.name, Date.now() - STALE_CUSTODY_IDLE_MS - 60_000);
    assert.equal(await workspaceClaimRefusal(w.workspacePath), null);
    holder = holdWorkspace(w.workspacePath); await once(holder, "spawn");
    await assert.rejects(withUnclaimedWorkspace(w.workspacePath, "test action", async () => { assert.fail("must not enter destructive operation"); }), { code: "CLAIM_RETAINED" });
    assert.equal((await workspaceClaimStatus(w.workspacePath)).claims[0]!.state, "recovery-required");
  } finally {
    if (holder) { const exited = once(holder, "exit"); holder.kill(); await exited; }
    await f.dispose();
  }
});

test("custody whose metadata carries an old creation time and no idle clock settles as abandoned", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("recovery-created-at", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    // Two landed, empty T3 Code workspaces sat like this on 16 Nov: custody recorded, the controllers
    // gone with the restarted server, and no idle clock ever written, so the hold could never settle.
    await withoutIdleClock(w.current.name, { createdAt: new Date(Date.now() - STALE_CUSTODY_IDLE_MS - 60_000).toISOString() });
    const refusal = await workspaceClaimRefusal(w.workspacePath);
    assert.equal(refusal, null, "the newest stamp the metadata carries is the age the idle rule reads");
    assert.equal((await workspaceClaimStatus(w.workspacePath)).claims[0]!.state, "recovery-required", "planning must not mutate custody");
    await withUnclaimedWorkspace(w.workspacePath, "test guarded destructive action", async (check) => { await check(); });
    const status = await workspaceClaimStatus(w.workspacePath);
    assert.equal(status.claims[0]!.state, "released");
    assert.equal(status.claims[0]!.settlementRef, "slipjay:confirmed-controller-gone-idle-24h");
  } finally { await f.dispose(); }
});

test("custody on an adopted spare reads the metadata under the workspace's own name", async () => {
  const f = await project();
  try {
    // An allocated spare is adopted for an Issue: the directory keeps `…-spare-…` and the record, the
    // workspace and the custody generation take the Issue's name, so the record is not named after the
    // directory at all. On 16 Nov this checkout could never be removed: custody's idle clock was looked
    // for under the directory's name, found nothing, and the hold never aged.
    const w = await createWorkspace("recovery-adopted", f.repo);
    const adopted = "recovery-adopted-7724";
    await adoptMetadata(w.current.name, adopted, { lastActivityAt: new Date(Date.now() - STALE_CUSTODY_IDLE_MS - 60_000).toISOString() });
    await abandoned(f.repo, w.workspacePath, adopted);
    assert.equal((await workspaceClaimStatus(w.workspacePath)).workspaceName, adopted, "custody names the workspace it holds");
    assert.equal(await workspaceClaimRefusal(w.workspacePath), null, "the idle clock is the one its own record carries");
    await withUnclaimedWorkspace(w.workspacePath, "test guarded destructive action", async (check) => { await check(); });
    const status = await workspaceClaimStatus(w.workspacePath);
    assert.equal(status.claims[0]!.state, "released");
    assert.equal(status.claims[0]!.settlementRef, "slipjay:confirmed-controller-gone-idle-24h");
  } finally { await f.dispose(); }
});

test("custody on a checkout with no metadata record at all refuses with the missing time", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("recovery-unrecorded", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    await rm(metadataPath(w.current.name));
    assert.match((await workspaceClaimRefusal(w.workspacePath))!, /no activity time/,
      "nothing recorded the checkout's age, so the refusal names it instead of settling on a guess");
  } finally { await f.dispose(); }
});

test("a creation stamp inside the idle window refuses with the wait it leaves, not with missing activity", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("recovery-created-recent", f.repo);
    await abandoned(f.repo, w.workspacePath, w.current.name);
    await withoutIdleClock(w.current.name, { createdAt: new Date(Date.now() - 3 * HOUR).toISOString() });
    const refusal = (await workspaceClaimRefusal(w.workspacePath))!;
    assert.match(refusal, /idle for 24h/);
    assert.match(refusal, /2[01]h \d+m left/);
    assert.doesNotMatch(refusal, /no activity time/, "the checkout's age is known from its creation stamp");
  } finally { await f.dispose(); }
});

