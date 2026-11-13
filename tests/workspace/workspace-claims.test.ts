import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activateWorkspaceClaims } from "../../src/lib/workspace/workspace-claim-activation.ts";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { acquireWorkspaceClaim, releaseWorkspaceClaim, transferWorkspaceClaim, workspaceClaimStatus, withUnclaimedWorkspace, resetWorkspaceClaimGeneration } from "../../src/lib/workspace/workspace-claims.ts";
import { claimController } from "../../src/lib/workspace/workspace-claim-identity.ts";
import { sweepDisposableWorkspaces, EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";
import { findOrphanedCheckouts, retireOrphanedCheckouts } from "../../src/lib/workspace/workspace-orphans.ts";
import { stateHome } from "../../src/lib/workspace/workspace-paths.ts";
import { metadataPath } from "../../src/lib/workspace/workspace-state.ts";
import { evictIdleWorkspaces, recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";
import { holdWorkspace } from "../support/workspace-holder.ts";
import { retireWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";

const acquisition = async (ownerId: string) => ({ requestId: `acquire:${ownerId}`, ownerId, credential: `secret-${ownerId}-${"x".repeat(32)}`, controller: await claimController(), obligationRef: `closed-epoch:${ownerId}:1` });
const release = (claim: Awaited<ReturnType<typeof acquireWorkspaceClaim>>, credential: string, requestId = `release:${claim.claimId}`) => ({ requestId, generation: claim.generation, claimId: claim.claimId, credential, settlementRef: "t3:closed-set:acknowledged" });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("claims are independent, alias-safe, credential-private, replay-safe and generation-bound", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("multi", f.repo);
    const alias = join(f.root, "alias"); await symlink(w.workspacePath, alias);
    const a = await acquisition("one"); const b = await acquisition("two");
    const one = await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, a);
    assert.deepEqual(await acquireWorkspaceClaim(alias, f.repo, w.current.name, a), one);
    const two = await acquireWorkspaceClaim(alias, f.repo, w.current.name, b);
    assert.equal(two.generation, one.generation);
    await assert.rejects(acquireWorkspaceClaim(alias, f.repo, w.current.name, { ...a, obligationRef: "different" }), { code: "CLAIM_REPLAY_CONFLICT" });
    const publicStatus = JSON.stringify(await workspaceClaimStatus(alias));
    assert.ok(!publicStatus.includes(a.credential) && !publicStatus.includes("credentialHash"));
    await assert.rejects(releaseWorkspaceClaim(alias, release(one, b.credential)), { code: "CLAIM_UNAUTHORIZED" });
    await releaseWorkspaceClaim(alias, release(one, a.credential));
    const kept = await sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000, pruneState: false });
    assert.ok(!kept.removed.includes(w.current.name));
    assert.match(kept.skipped.find((item) => item.name === w.current.name)?.reason ?? "", /two/);
    const next = await acquisition("successor");
    const transferred = await transferWorkspaceClaim(alias, release(two, b.credential, "transfer:two"), next);
    assert.deepEqual(await transferWorkspaceClaim(alias, release(two, b.credential, "transfer:two"), next), transferred);
    await assert.rejects(releaseWorkspaceClaim(alias, release(transferred, b.credential)), { code: "CLAIM_UNAUTHORIZED" });
    const ended = await releaseWorkspaceClaim(alias, release(transferred, next.credential));
    assert.deepEqual(await releaseWorkspaceClaim(alias, release(transferred, next.credential)), ended);
    await resetWorkspaceClaimGeneration(w.workspacePath);
    const fresh = await acquireWorkspaceClaim(alias, f.repo, w.current.name, await acquisition("new-allocation"));
    assert.notEqual(fresh.generation, one.generation);
    await assert.rejects(releaseWorkspaceClaim(alias, release(one, a.credential, "stale:new-request")), { code: "CLAIM_GENERATION_MISMATCH" });
  } finally { await f.dispose(); }
});

test("controller death retains orphan custody without JJ or sidecars, until evidence-backed settlement", async () => {
  const f = await project(); let child: ReturnType<typeof holdWorkspace> | undefined;
  try {
    const w = await createWorkspace("orphan-custody", f.repo);
    child = holdWorkspace(f.root); await once(child, "spawn");
    const input = { ...await acquisition("audit"), controller: await claimController(child.pid!) };
    const claim = await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, input);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal((await workspaceClaimStatus(w.workspacePath)).claims[0]?.state, "recovery-required");
    jj(f.repo, ["workspace", "forget", w.current.name]);
    await rm(metadataPath(w.current.name), { force: true });
    for (const file of ["README.md", "slipjay.json", ".jj", ".git"]) await rm(join(w.workspacePath, file), { recursive: true, force: true });
    await mkdir(join(w.workspacePath, "node_modules"));
    const now = Date.now() + 2 * 60 * 60_000;
    const orphan = (await findOrphanedCheckouts({ now })).find((item) => item.root === w.workspacePath);
    assert.equal(orphan?.action, "keep"); assert.match(orphan?.reason ?? "", /recovery-required/);
    assert.ok(!(await retireOrphanedCheckouts({ now })).includes(w.workspacePath));
    await releaseWorkspaceClaim(w.workspacePath, release(claim, input.credential));
    assert.ok((await retireOrphanedCheckouts({ now })).includes(w.workspacePath));
    assert.equal(existsSync(w.workspacePath), false);
  } finally { child?.kill(); await f.dispose(); }
});

test("active custody protects dependency and generated output from eviction, then normal eviction converges", async () => {
  const f = await project({ generatedPaths: ["build"], ignore: "node_modules/\nbuild/\n" });
  try {
    const w = await createWorkspace("eviction-custody", f.repo);
    await writeFile(join(w.workspacePath, "package.json"), '{"name":"fixture"}');
    for (const directory of ["node_modules/dep", "build"]) await mkdir(join(w.workspacePath, directory), { recursive: true });
    await writeFile(join(w.workspacePath, "build/out.js"), "generated");
    await recordWorkspaceActivity(w.current.name, Date.now() - 30 * 60 * 60_000);
    const input = await acquisition("eviction"); const claim = await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, input);
    const protectedResult = await evictIdleWorkspaces(f.repo);
    assert.equal(protectedResult.plans.find((plan) => plan.name === w.current.name)?.action, "keep");
    assert.ok(existsSync(join(w.workspacePath, "node_modules/dep")) && existsSync(join(w.workspacePath, "build/out.js")));
    await releaseWorkspaceClaim(w.workspacePath, release(claim, input.credential));
    const ended = await evictIdleWorkspaces(f.repo);
    assert.equal(ended.outcome.results.find((item) => item.name === w.current.name)?.evicted, true);
    assert.equal(existsSync(join(w.workspacePath, "build")), false);
  } finally { await f.dispose(); }
});

test("acquisition defeats a stale sweep decision before teardown; retirement winning refuses admission", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("race-custody", f.repo);
    const scanned = deferred(); const resume = deferred();
    const sweeping = sweepDisposableWorkspaces(f.repo, { now: Date.now() + EMPTY_IDLE_MS + 60_000, pruneState: false,
      beforeRemove: async (path) => { if (path === w.workspacePath) { scanned.resolve(); await resume.promise; } } });
    await scanned.promise;
    const input = await acquisition("wins-after-scan");
    const claim = await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, input);
    resume.resolve(); const result = await sweeping;
    assert.ok(!result.removed.includes(w.current.name)); assert.ok(existsSync(w.workspacePath));
    await releaseWorkspaceClaim(w.workspacePath, release(claim, input.credential));
    const fenced = deferred(); const finish = deferred();
    const retiring = retireWorkspace(f.repo, { name: w.current.name, root: w.workspacePath }, { afterEvidence: async () => { fenced.resolve(); await finish.promise; } });
    await fenced.promise;
    try {
      await assert.rejects(acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, await acquisition("too-late")), { code: "CLAIM_RETIRING" });
    } finally { finish.resolve(); await retiring; }
    assert.equal(existsSync(w.workspacePath), false);
  } finally { await f.dispose(); }
});

test("a destructive fence blocks admission without holding its writer across slow work", async () => {
  const f = await project();
  try {
    const w = await createWorkspace("short-fence", f.repo); const entered = deferred(); const finish = deferred();
    const operation = withUnclaimedWorkspace(w.workspacePath, "fixture", async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    // Status and rejected acquisition finish while the slow operation is deliberately blocked.
    assert.ok((await workspaceClaimStatus(w.workspacePath)).retirement);
    await assert.rejects(acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, await acquisition("during-fence")), { code: "CLAIM_RETIRING" });
    finish.resolve(); await operation;
    assert.equal((await workspaceClaimStatus(w.workspacePath)).retirement, null);
  } finally { await f.dispose(); }
});


test("held and unreadable claims stop declared preview teardown, and settled custody permits it", async () => {
  const f = await project({ policy: { workspaceTeardown: { executable: "node", args: ["-e", "require('node:fs').appendFileSync(require('node:path').join(process.cwd(),'..','claim-teardown.log'),'teardown\\n')"] } } });
  try {
    const w = await createWorkspace("preview-custody", f.repo);
    const input = await acquisition("preview"); const claim = await acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, input);
    const options = { now: Date.now() + EMPTY_IDLE_MS + 60_000, pruneState: false };
    const receipt = join(dirname(w.workspacePath), "claim-teardown.log");
    await sweepDisposableWorkspaces(f.repo, options); assert.equal(existsSync(receipt), false);
    const custodyFile = join(stateHome(), "custody", createHash("sha256").update(w.workspacePath).digest("hex") + ".json");
    const valid = await readFile(custodyFile, "utf8"); await writeFile(custodyFile, "unreadable");
    const unknown = await sweepDisposableWorkspaces(f.repo, options);
    assert.match(unknown.skipped.find((item) => item.name === w.current.name)?.reason ?? "", /unreadable/);
    assert.equal(existsSync(receipt), false);
    await writeFile(custodyFile, valid);
    await releaseWorkspaceClaim(w.workspacePath, release(claim, input.credential));
    const ended = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(ended.removed.includes(w.current.name));
    assert.equal(await readFile(receipt, "utf8"), "teardown\n");
  } finally { await f.dispose(); }
});


test("public retirement identity and fabricated proof cannot clear running or uncertain teardown", async () => {
  const f = await project();
  const entered = deferred(); const resume = deferred();
  let teardown: Promise<void> | undefined;
  try {
    const activation = await activateWorkspaceClaims();
    const w = await createWorkspace("uncertain-retirement", f.repo);
    teardown = withUnclaimedWorkspace(w.workspacePath, "fixture incomplete teardown", async () => {
      entered.resolve(); await resume.promise; throw new Error("unknown destructive outcome");
    });
    await entered.promise;
    const status = await workspaceClaimStatus(w.workspacePath);
    assert.ok(status.retirement && status.generation);
    const fabricated = { ...activation, generation: status.generation, retirementId: status.retirement.id, settlementRef: "fabricated:destructive-worker-stop" };
    const rejectFabrication = async () => {
      const result = spawnSync("bun", [fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url)), "claims", "settle-retirement", w.workspacePath], {
        cwd: f.repo, input: JSON.stringify(fabricated), encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).code, "CLAIM_REQUEST_INVALID");
      assert.deepEqual((await workspaceClaimStatus(w.workspacePath)).retirement, status.retirement);
      await assert.rejects(acquireWorkspaceClaim(w.workspacePath, f.repo, w.current.name, await acquisition("cannot-use")), { code: "CLAIM_RETIRING" });
    };
    await rejectFabrication();
    resume.resolve();
    await assert.rejects(teardown, /unknown destructive outcome/);
    await rejectFabrication();
    const completed = await createWorkspace("completed-retirement", f.repo);
    await withUnclaimedWorkspace(completed.workspacePath, "fixture completed teardown", async (check) => { await check(); });
    assert.equal((await workspaceClaimStatus(completed.workspacePath)).retirement, null);
    assert.ok(await acquireWorkspaceClaim(completed.workspacePath, f.repo, completed.current.name, await acquisition("completed")));
  } finally { resume.resolve(); await teardown?.catch(() => {}); await f.dispose(); }
});
