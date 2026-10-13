import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { finalizePostIntegration } from "../src/lib/post-integration-finalization.mjs";
import { postIntegrationPolicyDigest } from "../src/lib/post-integration-policy.mjs";
import { readPostIntegrationPolicy } from "../src/lib/post-integration-source.mjs";
import { cleanupLandedWorkspace, createWorkspace, landWorkspace } from "../src/lib/slipjay.mjs";

// An Isolated landing that leaves a dirty primary checkout in place still exports
// its integration and finalizes from a shallow primary `.git` before it publishes.

type Fixture = Awaited<ReturnType<typeof project>>;

/** A development-only step recording the exact source it ran from; `failFirst` fails its first run. */
function finalization(ledger: string, failFirst = false) {
  const marker = `${ledger}.failed-once`;
  const source = `const fs=require("node:fs");
if (${failFirst} && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); process.exit(9); }
const e = process.env;
// Only the slipjay names are set; the retired PEACH_FINALIZATION_* names are not.
const both = (name) => e["PEACH_FINALIZATION_" + name] === undefined ? e["SLIPJAY_FINALIZATION_" + name] : "retired-name-set";
if (!both("KEY") || both("TARGET") !== "fixture-development-db") process.exit(8);
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ commit: both("COMMIT"), landed: fs.existsSync("landed.txt") }) + "\\n");`;
  return {
    version: 1, target: "fixture-development-db", idempotency: "artifact-key", approvalMode: "automatic-development", timeoutMs: 30_000,
    command: { executable: "node", args: ["-e", source] },
    targetProbe: { executable: "node", args: ["-e", "console.log(JSON.stringify({ target: \"fixture-development-db\" }))"] },
  };
}

const primaryRef = (f: Fixture) => execFileSync("git", ["--git-dir", join(f.repo, ".git"), "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
const ledgerEntries = async (ledger: string) => (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

async function shallowProject(failFirst = false) {
  // Outside the project, so the policy can name it before the project exists.
  const external = await mkdtemp(join(tmpdir(), "peach-finalization-target-"));
  const ledger = join(external, "ledger.jsonl");
  const created = await project({ shallow: true, postIntegration: finalization(ledger, failFirst) });
  const f = { ...created, dispose: async () => { await Promise.all([created.dispose(), rm(external, { recursive: true, force: true })]); } };
  await access(join(f.repo, ".git", "shallow"));
  await writeFile(join(f.repo, "local.txt"), "unlanded\n");
  const workspace = await createWorkspace("landed.txt", f.repo);
  await writeFile(join(workspace.workspacePath, "landed.txt"), "landed\n");
  return { f, ledger, workspace };
}

const land = (path: string) => landWorkspace(path, { onProgress: () => {}, sweepOtherWorkspaces: false, releaseLandedWorkspace: false });

test("a shallow primary with uncommitted edits finalizes and publishes an Isolated landing", async () => {
  const { f, ledger, workspace } = await shallowProject();
  try {
    const result = await land(workspace.workspacePath);
    assert.equal(result.ok, true, JSON.stringify({ postIntegration: result.postIntegration, publication: result.publication }));
    assert.equal(result.postIntegration.status, "complete");
    assert.equal(result.publication.status, "pushed");
    assert.deepEqual(result.primaryCheckout, { action: "left", reason: "unlanded-changes" });
    assert.deepEqual(await ledgerEntries(ledger), [{ commit: result.artifact.commitId, landed: true }]);
    assert.equal(primaryRef(f), result.artifact.commitId);
    assert.equal(f.remoteFile("landed.txt"), "landed\n");
    assert.equal(await readFile(join(f.repo, "local.txt"), "utf8"), "unlanded\n");
  } finally {
    await f.dispose();
  }
}, 180_000);

test("rerunning an integrated but unpublished landing finalizes and publishes without ref edits", async () => {
  const { f, ledger, workspace } = await shallowProject(true);
  try {
    const first = await land(workspace.workspacePath);
    assert.equal(first.ok, false);
    assert.equal(first.postIntegration.status, "failed");
    assert.equal(first.publication.status, "blocked");
    assert.equal(jj(f.repo, ["--ignore-working-copy", "log", "-r", "main", "--no-graph", "-T", "commit_id"]), first.artifact.commitId);

    const retry = await land(workspace.workspacePath);
    assert.equal(retry.ok, true, JSON.stringify({ postIntegration: retry.postIntegration, publication: retry.publication }));
    assert.equal(retry.artifact.commitId, first.artifact.commitId);
    assert.equal(retry.postIntegration.status, "complete");
    assert.equal(retry.publication.status, "pushed");
    assert.deepEqual(await ledgerEntries(ledger), [{ commit: first.artifact.commitId, landed: true }]);
    assert.equal(primaryRef(f), first.artifact.commitId);
    assert.equal(f.remoteFile("landed.txt"), "landed\n");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("a repository governed only by the retired slipway.json is refused, naming slipjay.json", async () => {
  const f = await project({ policyPath: "slipway.json" });
  try {
    const workspace = await createWorkspace("retired policy", f.repo).catch((error: Error) => error);
    const outcome = workspace instanceof Error ? workspace
      : await writeFile(join(workspace.workspacePath, "task.txt"), "task\n").then(() => land(workspace.workspacePath)).catch((error: Error) => error);
    assert.ok(outcome instanceof Error, JSON.stringify(outcome));
    assert.match(outcome.message, /slipway\.json is no longer read .* rename it to slipjay\.json/);
    assert.equal(jj(f.repo, ["log", "--no-graph", "-r", "main", "-T", "description"]), "Initial", "nothing was integrated");
  } finally {
    await f.dispose();
  }
}, 120_000);

// YardSmith yardsmith-t-f13816: a failed step stays failed on retry once the tip moved,
// but a later landing published the artifact after its own step, so cleanup releases it.
test("cleanup releases a failed landing only once a later landing has published its artifact", async () => {
  const { f, ledger, workspace } = await shallowProject(true);
  try {
    const first = await land(workspace.workspacePath);
    assert.equal(first.postIntegration.status, "failed");
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: false, reason: "post-integration-failed" });

    const later = await createWorkspace("later.txt", f.repo);
    await writeFile(join(later.workspacePath, "later.txt"), "later\n");
    const published = await land(later.workspacePath);
    assert.equal(published.ok, true, JSON.stringify({ postIntegration: published.postIntegration, publication: published.publication }));
    assert.equal(f.remoteFile("landed.txt"), "landed\n");

    const retry = await land(workspace.workspacePath);
    assert.equal(retry.ok, false);
    assert.equal(retry.postIntegration.reason, "Historical migration policy changed or is not recoverable");
    assert.match(retry.publication.reason ?? "", /already published .* run `slipjay cleanup`/);

    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true,
      supersededPostIntegration: { status: "failed", attempt: 2, reason: "Historical migration policy changed or is not recoverable" } });
    assert.equal(existsSync(workspace.workspacePath), false);
    assert.deepEqual((await ledgerEntries(ledger)).map((entry) => entry.commit), [published.artifact.commitId]);
  } finally {
    await f.dispose();
  }
}, 300_000);

// YardSmith ys-skip-optimiser / ys-1269: a completed receipt whose commit still carries the
// retired slipway.json cannot cover an older artifact, and must not crash the scan.
test("a completed receipt on a retired-policy commit is skipped, not thrown, by descendant recovery", async () => {
  const external = await mkdtemp(join(tmpdir(), "peach-finalization-target-"));
  const f = await project({ postIntegration: finalization(join(external, "ledger.jsonl")) });
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
    const older = git("rev-parse", "HEAD");
    git("mv", "slipjay.json", "slipway.json");
    git("commit", "-qm", "Retired policy path");
    const newer = git("rev-parse", "HEAD");
    const gitDirectory = join(f.repo, ".git");
    const { policy } = await readPostIntegrationPolicy(gitDirectory, older);
    assert.ok(policy);
    const policyDigest = postIntegrationPolicyDigest(policy);
    // The receipt and idempotency-key hashes finalization uses to find a descendant receipt.
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const stateDirectory = join(external, "state");
    await mkdir(stateDirectory);
    await writeFile(join(stateDirectory, `${digest([gitDirectory, newer])}.json`), JSON.stringify({
      ok: true, status: "complete", sourceIntegrated: true, approved: true, attempt: 1, integratedCommitSha: newer,
      policyDigest, target: policy.target, idempotencyKey: digest([gitDirectory, newer, policyDigest, policy.target]) }));
    const outcome = await finalizePostIntegration({ gitDirectory, integratedCommitSha: older, stateDirectory,
      recoverDescendant: true, readIntegrationTip: async () => newer });
    // Not covered, so finalization proceeds to its own tip check instead of throwing from the scan.
    assert.equal(outcome.reason, "Integration tip changed before finalization", JSON.stringify(outcome));
  } finally {
    await Promise.all([f.dispose(), rm(external, { recursive: true, force: true })]);
  }
}, 120_000);
