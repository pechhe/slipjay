import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

vi.mock("../src/lib/workspace-transaction.mjs", () => ({
  withWorkspaceTransaction: async (_key: string, run: () => Promise<unknown>) => run(),
  writeWorkspaceJson: async () => {},
}));
import { integrateLandingCandidate } from "../src/lib/landing-candidate.mjs";

function fixture(direct = false, emptyChild = false) {
  const context = {
    current: { name: direct ? "default" : "task", root: "/task" },
    integration: { name: "default", root: "/repo" }, integrationBranch: "develop",
    configuration: { requiredLocalVerification: [], migrationFinalization: null },
  };
  const candidate = { changeId: "change", commitId: "semantic", empty: false, conflict: false, description: "Task" };
  let liveCandidate = candidate;
  let liveBase = "base";
  let primaryWriter: string | null = null;
  const steps: string[] = [];
  const state: Record<string, unknown> = {};
  const io = {
    landingPreview: async () => ({ context, target: candidate }),
    ensureLandingDescription: async () => candidate,
    assertNoForeignPrimaryWriter: async () => { if (primaryWriter) throw new Error(primaryWriter); },
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
    runVerification: async () => { throw new Error("host verifier should be used"); },
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
  return { io, options, steps, state, drift: () => { liveBase = "changed"; }, directWriter: (message: string) => { primaryWriter = message; } };
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

test("a live Direct writer defers the primary checkout move but never the integration", async () => {
  const f = fixture();
  f.directWriter("The primary checkout is being written by Direct Pi run");
  const result = await integrateLandingCandidate("/task", f.options, f.io);
  assert.deepEqual(f.steps, ["rebase", "deps", "generate", "verify", "bookmark"]);
  assert.equal(f.state.phase, "landed");
  assert.equal(result.primaryCheckout?.action, "deferred");
  // Housekeeping stays pending so a later cleanup moves the checkout once the writer ends.
  assert.equal(result.cleanupPending, true);
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
