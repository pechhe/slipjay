import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

vi.mock("../../src/lib/infra/workspace-transaction.ts", () => ({
  writeWorkspaceJson: async () => {},
}));
import { integrateLandingCandidate, integratePreparedCandidate, prepareLandingCandidate, verifyPreparedCandidate } from "../../src/lib/landing/landing-candidate.ts";

function fixture(direct = false, emptyChild = false) {
  const context = {
    current: { name: direct ? "default" : "task", root: "/task" },
    integration: { name: "default", root: "/repo" }, integrationBranch: "develop",
    configuration: { requiredLandingVerification: [], migrationFinalization: null },
  };
  const candidate = { changeId: "change", commitId: "semantic", empty: false, conflict: false, description: "Task" };
  let liveCandidate = candidate;
  let liveBase = "base";
  const steps: string[] = [];
  const state: Record<string, unknown> = {};
  const io = {
    landingPreview: async () => ({ context, target: candidate }),
    ensureLandingDescription: async () => candidate,
    assertStackConflictFree: async () => {},
    revisionFacts: async (cwd: string, revision: string) => revision === "develop"
      ? { ...candidate, commitId: liveBase }
      // The primary checkout is an empty `@` on the old integration tip.
      : cwd === "/repo" && revision === "@" ? { ...candidate, commitId: "primary", empty: true }
      : revision === "@" && emptyChild ? { ...liveCandidate, commitId: "empty-child", empty: true } : liveCandidate,
    jj: async (_cwd: string, args: string[]) => {
      if (args[0] === "diff" || args[0] === "log") return "";
      steps.push(args[0]!);
      if (args[0] === "edit") { assert.equal(args[1], liveCandidate.commitId); emptyChild = false; }
      return "";
    },
    writeLandingState: async (_ctx: unknown, artifact: typeof candidate, _verification: unknown, phase: string) => {
      Object.assign(state, { artifactCommitId: artifact.commitId, phase });
    },
    readJsonOptional: async () => state,
    statePath: () => "/state",
    prepareCandidateDependencies: async () => { steps.push("deps"); },
  };
  const options = {
    adapter: {
      finalizeCandidate: async () => {
        steps.push("generate");
        liveCandidate = { ...candidate, commitId: "generated" };
        return liveCandidate;
      },
      verify: async (identity: { base: string; candidate: string }) => {
        steps.push("verify");
        assert.deepEqual(identity, { base: "base", candidate: "generated" });
        return { status: "passed" as const, passed: [], gaps: [], policyDigest: "policy" };
      },
    },
  };
  return { io, options, steps, state, drift: () => { liveBase = "changed"; }, rewrite: () => { liveCandidate = { ...liveCandidate, commitId: "rewritten" }; } };
}

for (const direct of [false, true]) test(`shared candidate transition preserves ${direct ? "Direct" : "isolated"} landing order`, async () => {
  const f = fixture(direct);
  const result = await integrateLandingCandidate("/task", f.options, f.io);
  // Housekeeping moves the canonical checkout and the landed workspace onto the integration.
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "verify", "bookmark", "new", "new"]);
  assert.equal(result.artifact.commitId, "generated");
  assert.equal(result.cleanupPending, false);
  assert.deepEqual(result.primaryCheckout, { action: "moved" });
  assert.equal(f.state.phase, direct ? undefined : "landed");
});

test("a retry verifies the exact candidate rather than its empty continuation child", async () => {
  const f = fixture(false, true);
  const result = await integrateLandingCandidate("/task", f.options, f.io);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "edit", "verify", "bookmark", "new", "new"]);
  assert.equal(result.artifact.commitId, "generated");
  assert.equal(f.state.phase, "landed");
});

test("shared candidate transition refuses integration if verification moves the base", async () => {
  const f = fixture();
  const verify = f.options.adapter.verify;
  f.options.adapter.verify = async (identity) => {
    const result = await verify(identity);
    f.drift();
    return result;
  };
  await assert.rejects(integrateLandingCandidate("/task", f.options, f.io), /Integration bookmark moved/);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "verify"]);
  assert.equal(f.state.phase, undefined);
});


test("a prepared candidate moves no integration state; later publication uses the exact checked artifact without another gate", async () => {
  const f = fixture();
  const prepared = await prepareLandingCandidate("/task", f.options, f.io);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate"]);
  assert.deepEqual(f.state, {});
  assert.equal(prepared.base, "base");
  assert.equal(prepared.artifact.commitId, "generated");
  const verified = await verifyPreparedCandidate("/task", prepared, f.options, f.io);
  const landed = await integratePreparedCandidate("/task", verified, f.options, f.io);
  assert.equal(landed.artifact.commitId, prepared.artifact.commitId);
  assert.equal(landed.base, prepared.base);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "verify", "bookmark", "new", "new"]);
  assert.equal(f.state.phase, "landed");
});

for (const changed of ["parent", "candidate", "working-tree"] as const) test(`prepared evidence refuses a changed ${changed} at the publication boundary`, async () => {
  const f = fixture();
  const prepared = await verifyPreparedCandidate("/task", await prepareLandingCandidate("/task", f.options, f.io), f.options, f.io);
  if (changed === "parent") f.drift();
  else if (changed === "candidate") f.rewrite();
  else {
    const jj = f.io.jj;
    f.io.jj = async (cwd, args) => args[0] === "diff" ? "M dirty.ts" : jj(cwd, args);
  }
  await assert.rejects(integratePreparedCandidate("/task", prepared, f.options, f.io), changed === "parent" ? /Integration bookmark moved/ : /Verification checkout differs/);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "verify"]);
  assert.deepEqual(f.state, {});
});


test("source rewritten between preparation and verification starts no gate and moves no bookmark", async () => {
  const f = fixture();
  const prepared = await prepareLandingCandidate("/task", f.options, f.io);
  f.rewrite();
  await assert.rejects(verifyPreparedCandidate("/task", prepared, f.options, f.io), /Verification checkout differs/);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate"]);
  assert.deepEqual(f.state, {});
});
