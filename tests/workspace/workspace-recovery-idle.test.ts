import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { holdWorkspace } from "../support/workspace-holder.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { abandonedCustodyNote, acquireWorkspaceClaim, STALE_CUSTODY_IDLE_MS, withUnclaimedWorkspace, workspaceClaimRefusal, workspaceClaimStatus } from "../../src/lib/workspace/workspace-claims.ts";
import type { ClaimView } from "../../src/lib/workspace/workspace-claims.ts";
import { recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";
import { claimController } from "../../src/lib/workspace/workspace-claim-identity.ts";

async function abandoned(root: string, path: string, name: string) {
  const controller = await claimController();
  assert.ok(controller);
  await acquireWorkspaceClaim(path, root, name, { requestId: "dead:acquire", ownerId: "dead", credential: "x".repeat(32), obligationRef: "dead:obligation", controller: { ...controller, pid: 2147483647 } });
}

const HOUR = 60 * 60_000;

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
