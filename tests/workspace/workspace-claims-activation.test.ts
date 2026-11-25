import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { activateWorkspaceClaims, requireWorkspaceClaimActivation, workspaceClaimCapability, managedCleanupInventory } from "../../src/lib/workspace/workspace-claim-activation.ts";
import { stateHome } from "../../src/lib/workspace/workspace-paths.ts";
import { claimController } from "../../src/lib/workspace/workspace-claim-identity.ts";
import { workspaceClaimStatus } from "../../src/lib/workspace/workspace-claims.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
// No settling: an unannounced live worker refuses at once, as a sampled old worker always would.
const immediate = { windowMs: 0, pollMs: 1 };

test("activation refuses old and unknown managed workers, then succeeds after their owned process drains", async () => {
  const f = await project();
  const oldEntry = join(f.root, "src/launcher/workspace.ts");
  await mkdir(dirname(oldEntry), { recursive: true });
  await writeFile(oldEntry, "setInterval(() => {}, 1000);\n");
  const old = spawn("bun", [oldEntry], { cwd: f.root, stdio: "ignore" }); await once(old, "spawn");
  const foreign = spawn("bun", [oldEntry], { cwd: f.root, env: { ...process.env, HOME: join(f.root, "other-authority") }, stdio: "ignore" });
  await once(foreign, "spawn");
  try {
    const inventory = await managedCleanupInventory();
    assert.ok(inventory.complete && inventory.pids.includes(old.pid!));
    assert.ok(!inventory.pids.includes(foreign.pid!), "another authority HOME does not block this activation");
    await assert.rejects(activateWorkspaceClaims(async () => ({ complete: false, pids: [] })), { code: "CLAIM_ACTIVATION_UNKNOWN" });
    // The default settle window still refuses a worker that never announces.
    await assert.rejects(activateWorkspaceClaims(), { code: "CLAIM_ACTIVATION_DRAIN_REQUIRED" });
    let sampledBeforeExit = inventory;
    const ready = await activateWorkspaceClaims(async () => {
      sampledBeforeExit = await managedCleanupInventory();
      assert.ok(sampledBeforeExit.complete && sampledBeforeExit.pids.includes(old.pid!));
      const done = once(old, "exit"); old.kill(); await done;
      return sampledBeforeExit;
    });
    await requireWorkspaceClaimActivation(ready.activationId, async () => sampledBeforeExit);
    await assert.rejects(requireWorkspaceClaimActivation(ready.activationId, async () => ({ complete: true, pids: [foreign.pid!] }), immediate), { code: "CLAIM_ACTIVATION_DRAIN_REQUIRED" });
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(activateWorkspaceClaims(async () => ({ complete: true, pids: [pid] }), immediate), { code: "CLAIM_ACTIVATION_DRAIN_REQUIRED" });
    }
    const kill = process.kill.bind(process);
    for (const failure of [Object.assign(new Error("Permission denied"), { code: "EPERM" }), Object.assign(new Error("Unknown failure"), { code: "EIO" }), new Error("Unproved process absence"), undefined, null]) {
      const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === old.pid && signal === 0) throw failure;
        return kill(pid, signal);
      });
      try {
        await assert.rejects(activateWorkspaceClaims(async () => sampledBeforeExit, immediate), { code: "CLAIM_ACTIVATION_DRAIN_REQUIRED" });
        await assert.rejects(requireWorkspaceClaimActivation(ready.activationId, async () => sampledBeforeExit, immediate), { code: "CLAIM_ACTIVATION_DRAIN_REQUIRED" });
      } finally { probe.mockRestore(); }
    }
    assert.deepEqual(await activateWorkspaceClaims(async () => ({ complete: true, pids: [] })), ready, "activation replay doesn't strand prior consumers");
    await requireWorkspaceClaimActivation(ready.activationId, async () => ({ complete: true, pids: [] }));
    await assert.rejects(requireWorkspaceClaimActivation("old-capability", async () => ({ complete: true, pids: [] })), { code: "CLAIM_CAPABILITY_REQUIRED" });
  } finally { old.kill(); const exited = once(foreign, "exit"); foreign.kill(); await exited; await f.dispose(); }
});

test("activation ignores a cleanup worker's unfinished temp file but still refuses a corrupt record", async () => {
  const f = await project();
  try {
    const workers = join(stateHome(), "managed-cleanup-workers");
    await mkdir(workers, { recursive: true });
    const tmp = join(workers, "e8fef072-0000-4000-8000-000000000000.json.b8a87fa1-0000-4000-8000-000000000000.tmp");
    await writeFile(tmp, "");
    const none = async () => ({ complete: true, pids: [] });
    await activateWorkspaceClaims(none, immediate);
    const corrupt = join(workers, "corrupt.json");
    await writeFile(corrupt, "");
    await assert.rejects(activateWorkspaceClaims(none, immediate), { code: "CLAIM_ACTIVATION_UNKNOWN" });
    await rm(corrupt);
    await activateWorkspaceClaims(none, immediate);
  } finally { await f.dispose(); }
});

test("custody operations let a concurrently starting slipjay command announce instead of refusing it", async () => {
  const f = await project();
  try {
    const activation = await activateWorkspaceClaims();
    for (let round = 0; round < 3; round += 1) {
      // Sampled the moment it is spawned: a participating CLI that has not yet written its record.
      const child = spawn("bun", [cli, "claims", "status", f.repo], { cwd: f.repo, stdio: "ignore" });
      await once(child, "spawn");
      const exited = once(child, "exit");
      try {
        await requireWorkspaceClaimActivation(activation.activationId, async () => ({ complete: true, pids: [child.pid!] }));
      } finally { await exited; }
    }
  } finally { await f.dispose(); }
});

test("managed allocation claims before preparation/publication, including resume", async () => {
  const f = await project();
  try {
    const activation = await activateWorkspaceClaims();
    const make = async (id: string) => ({ ...activation, requestId: `start:${id}`, ownerId: id, credential: `${id}-${"c".repeat(40)}`, controller: await claimController(), obligationRef: `t3:${id}:epoch1` });
    let prepared = false;
    const first = await createWorkspace("managed-start", f.repo, { claim: await make("first"), hooks: { prepare: async (_repo, path) => {
      const status = await workspaceClaimStatus(path);
      assert.equal(status.claims.filter((c) => c.state === "active").length, 1);
      prepared = true; return {};
    } } });
    assert.ok(prepared && first.claim);
    const resumed = await createWorkspace("bound-again", first.workspacePath, { claim: await make("second"), hooks: { prepare: async (_repo, path) => {
      assert.equal((await workspaceClaimStatus(path)).claims.length, 2); return {};
    } } });
    assert.equal(resumed.claim?.generation, first.claim?.generation);
    const refused = await createWorkspace("bad-capability", f.repo, { claim: { ...await make("bad"), activationId: "absent" } }).then(() => null, (error: unknown) => error);
    assert.equal((refused as { code: string }).code, "CLAIM_CAPABILITY_REQUIRED");
  } finally { await f.dispose(); }
});

test("CLI returns versioned capability/status, credentials travel only on stdin", async () => {
  const f = await project();
  try {
    const capability = JSON.parse((await exec("bun", [cli, "claims", "capability"], { cwd: f.repo })).stdout);
    assert.equal(capability.ok, true); assert.equal(capability.protocol, 1);
    assert.equal(capability.credentialTransport, "stdin-json");
    assert.equal(workspaceClaimCapability().settlementAuthority, "publisher-closed-obligation-set");
    const activation = JSON.parse((await exec("bun", [cli, "claims", "activate"], { cwd: f.repo })).stdout);
    assert.ok(activation.activationId);
    const w = await createWorkspace("cli-custody", f.repo);
    const input = { activationId: activation.activationId, requestId: "cli:acquire", ownerId: "cli-owner",
      credential: "never-echo-this-credential-xxxxxxxxxxxxxxxxxxxxxxxx", controller: await claimController(), obligationRef: "cli:epoch1" };
    const invoke = (args: string[], payload: unknown) => JSON.parse(execFileSync("bun", [cli, ...args], { cwd: w.workspacePath, input: JSON.stringify(payload), encoding: "utf8" }));
    const acquired = invoke(["claims", "acquire", w.workspacePath], input);
    assert.equal(acquired.ok, true); assert.ok(acquired.claimId && acquired.generation);
    const auth = { activationId: activation.activationId, generation: acquired.generation, claimId: acquired.claimId, credential: input.credential };
    const recovery = invoke(["claims", "recover", w.workspacePath], { ...auth, requestId: "cli:unknown", reason: "adapter-unavailable" });
    assert.equal(recovery.recoveryRequired, true);
    const status = JSON.parse((await exec("bun", [cli, "claims", "status", w.workspacePath], { cwd: f.repo })).stdout);
    assert.equal(status.claims[0].state, "recovery-required"); assert.equal(status.claims[0].reason, "adapter-unavailable");
    assert.ok(!JSON.stringify(status).includes(input.credential));
    const released = invoke(["claims", "release", w.workspacePath], { ...auth, requestId: "cli:release", settlementRef: "t3:closed-and-acknowledged" });
    assert.equal(released.released, true);
    const { stdout } = await exec("bun", [cli, "claims", "status", join(f.root, "missing")], { cwd: f.repo });
    assert.deepEqual(JSON.parse(stdout).claims, []);
  } finally { await f.dispose(); }
});
