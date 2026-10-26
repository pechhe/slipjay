import assert from "node:assert/strict";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { integrateLandingCandidate, type LandingIO } from "../../src/lib/landing/landing-candidate.ts";
import { landingIO } from "../../src/lib/landing/landing-steps.ts";
import { classifyFailure } from "../../src/lib/runner/failure-classification.ts";
import { jj, project } from "../support/workspace-project.ts";

const commit = (cwd: string, revision = "@") => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);

async function fixture(kind: "rename" | "edited-rename" | "delete", concurrent: boolean, reverted = false, stack = false) {
  const f = await project();
  const oldPath = "old [literal] file.ts";
  const addedPath = "new file.ts";
  const content = Array.from({ length: 30 }, (_, n) => `export const value${n} = ${n};\n`).join("");
  jj(f.repo, ["new", "main", "-m", "Seed source"]);
  await writeFile(join(f.repo, oldPath), content);
  const base = commit(f.repo);
  jj(f.repo, ["bookmark", "set", "main", "-r", base]);
  jj(f.repo, ["new", base, "-m", "Move source"]);
  if (kind === "delete") await rm(join(f.repo, oldPath));
  else {
    await rename(join(f.repo, oldPath), join(f.repo, addedPath));
    if (kind === "edited-rename") await writeFile(join(f.repo, addedPath), content + "export const local = true;\n");
  }
  if (stack) jj(f.repo, ["new", "-m", "Follow-up"]);
  const source = commit(f.repo);
  jj(f.repo, ["new", base, "-m", "YS-407: keep integration plumbing"]);
  await writeFile(join(f.repo, concurrent ? oldPath : "unrelated.ts"), content + "export const integration = true;\n");
  const edit = commit(f.repo);
  if (reverted) {
    jj(f.repo, ["new", "-m", "Revert plumbing"]);
    await writeFile(join(f.repo, oldPath), content);
  }
  jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
  const tip = commit(f.repo);
  jj(f.repo, ["edit", source]);
  const context = { current: { name: "default", root: f.repo }, integration: { name: "default", root: f.repo }, integrationBranch: "main",
    configuration: { requiredLandingVerification: [], migrationFinalization: null } };
  let verified = false;
  const io: LandingIO = { ...landingIO,
    landingPreview: async () => ({ context, target: await landingIO.revisionFacts(f.repo, source) }),
    ensureLandingDescription: async (_cwd, _context, target) => target,
    prepareCandidateDependencies: async () => {},
  };
  const land = () => integrateLandingCandidate(f.repo, { pinnedSource: true, adapter: {
    verify: async () => { verified = true; return { status: "passed", passed: [], gaps: [], policyDigest: "fixture" }; },
  } }, io);
  return { ...f, source, tip, edit, oldPath, addedPath, land, verified: () => verified };
}

for (const scenario of ["rename", "edited-rename", "stack", "reverted"] as const)
  test(`runner candidate preparation refuses ${scenario} over integration path edits before verification`, async () => {
    const f = await fixture(scenario === "edited-rename" ? scenario : "rename", true, scenario === "reverted", scenario === "stack");
    try {
      let reason = "";
      await assert.rejects(f.land(), (error: Error) => {
        reason = error.message;
        assert.ok(reason.includes(f.oldPath));
        assert.ok(reason.includes(f.addedPath));
        assert.ok(reason.includes(f.edit));
        assert.match(reason, /YS-407: keep integration plumbing/);
        assert.match(reason, /Carry those integration edits/);
        return true;
      });
      assert.equal(f.verified(), false);
      assert.equal(commit(f.repo, "main"), f.tip);
      assert.equal(commit(f.repo), f.source, "refusal leaves source unre-based");
      assert.equal(classifyFailure({ type: "failed", stage: "rebasing", reason }, { paused: false, held: false }).cause, "conflict");
    } finally { await f.dispose(); }
  });

test("a rename over unrelated integration edits still verifies and integrates", async () => {
  const f = await fixture("rename", false);
  try {
    const result = await f.land();
    assert.equal(f.verified(), true);
    assert.equal(commit(f.repo, "main"), result.artifact.commitId);
    assert.equal(result.base, f.tip);
    assert.match(await readFile(join(f.repo, f.addedPath), "utf8"), /value29/);
    assert.match(await readFile(join(f.repo, "unrelated.ts"), "utf8"), /integration = true/);
  } finally { await f.dispose(); }
});

test("a delete without a similar add retains JJ's modify/delete conflict", async () => {
  const f = await fixture("delete", true);
  try {
    await assert.rejects(f.land(), /conflict/i);
    assert.equal(f.verified(), false);
    assert.equal(commit(f.repo, "main"), f.tip);
    assert.equal((await landingIO.revisionFacts(f.repo, "@")).conflict, true);
  } finally { await f.dispose(); }
});
