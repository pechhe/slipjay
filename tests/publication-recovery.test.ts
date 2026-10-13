import { jj, project, recordCheckout } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, landWorkspace } from "../src/lib/slipjay.mjs";
import { readLandingState } from "../src/lib/workspace-state.mjs";

const land = (cwd: string) => landWorkspace(cwd, { onProgress: () => {}, sweepOtherWorkspaces: false, releaseLandedWorkspace: false });

async function divergedLanding(changePolicy = false, failRecoveryVerification = false) {
  const external = await mkdtemp(join(tmpdir(), "slipjay-publication-recovery-"));
  const marker = join(external, "failed-once");
  const failedCheck = join(external, "verification-failed-once");
  const f = await project({ verify: (verified) => `${recordCheckout(verified)};const cp=require("node:child_process");const revision=(r)=>cp.execFileSync("jj",["--ignore-working-copy","log","-r",r,"--no-graph","-T","commit_id"],{encoding:"utf8"}).trim();if(revision("parents(@)")!==revision("main"))process.exit(8);${failRecoveryVerification ? `const fs=require("node:fs");if(fs.readFileSync(${JSON.stringify(verified)},"utf8").trim().split("\\n").length===2&&!fs.existsSync(${JSON.stringify(failedCheck)})){fs.writeFileSync(${JSON.stringify(failedCheck)},"");process.exit(9)}` : ""}`, postIntegration: {
    version: 1, target: "fixture-development-db", idempotency: "artifact-key", approvalMode: "automatic-development", timeoutMs: 30_000,
    command: { executable: "node", args: ["-e", `const fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},"");process.exit(9)}`] },
    targetProbe: { executable: "node", args: ["-e", 'console.log(JSON.stringify({target:"fixture-development-db"}))'] },
  } });
  const workspace = await createWorkspace("preserved source", f.repo);
  await writeFile(join(workspace.workspacePath, "owned.txt"), "owned\n");
  const first = await land(workspace.workspacePath);
  assert.equal(first.ok, false);
  assert.equal(first.postIntegration.status, "failed");
  const clone = join(external, "publisher");
  const git = (args: string[]) => execFileSync("git", args, { cwd: clone, stdio: "pipe" });
  execFileSync("git", ["clone", "-q", f.remote, clone], { stdio: "pipe" });
  git(["config", "user.name", "Other publisher"]);
  git(["config", "user.email", "publisher@example.com"]);
  await writeFile(join(clone, "published.txt"), "published\n");
  if (changePolicy) {
    const policy = JSON.parse(await readFile(join(clone, "slipjay.json"), "utf8"));
    policy.requiredLocalVerification = [];
    await writeFile(join(clone, "slipjay.json"), JSON.stringify(policy));
  }
  git(["add", "."]);
  git(["commit", "-qm", "Concurrent published source"]);
  git(["push", "-q", "origin", "main"]);
  jj(workspace.workspacePath, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
  const heads = () => jj(workspace.workspacePath, ["--ignore-working-copy", "log", "-r", 'bookmarks(exact:"main")', "--no-graph", "-T", 'commit_id ++ "\\n"']);
  assert.equal(heads().split("\n").length, 2);
  return { f, workspace, first, heads, dispose: async () => { await f.dispose(); await rm(external, { recursive: true, force: true }); } };
}

test("native retry preserves both divergent sources and verifies the rebased artifact", async () => {
  const fixture = await divergedLanding();
  try {
    const retry = await land(fixture.workspace.workspacePath);
    assert.equal(retry.ok, true, JSON.stringify(retry.publication));
    assert.notEqual(retry.artifact.commitId, fixture.first.artifact.commitId);
    assert.equal(fixture.f.remoteFile("owned.txt"), "owned\n");
    assert.equal(fixture.f.remoteFile("published.txt"), "published\n");
    const checks = (await readFile(fixture.f.verified, "utf8")).trim().split("\n");
    assert.equal(checks.length, 2, "the changed candidate requires fresh verification");
    assert.ok(checks.every((path) => path === fixture.workspace.workspacePath));
    const state = await readLandingState(fixture.workspace.current.name, { readOnly: true });
    assert.equal(state?.publicationRecovery?.previousLanding.artifactCommitId, fixture.first.artifact.commitId);
  } finally { await fixture.dispose(); }
}, 180_000);

test("an interrupted recovery remains retryable and retains the earlier verification receipt", async () => {
  const fixture = await divergedLanding(false, true);
  try {
    await assert.rejects(land(fixture.workspace.workspacePath), /verification|exited|failed/i);
    const interrupted = await readLandingState(fixture.workspace.current.name, { readOnly: true });
    assert.equal(interrupted?.phase, "recovering");
    assert.equal(interrupted?.publicationRecovery?.previousLanding.artifactCommitId, fixture.first.artifact.commitId);
    const retry = await land(fixture.workspace.workspacePath);
    assert.equal(retry.ok, true, JSON.stringify(retry.publication));
    assert.equal(fixture.f.remoteFile("owned.txt"), "owned\n");
    assert.equal(fixture.f.remoteFile("published.txt"), "published\n");
    assert.equal((await readFile(fixture.f.verified, "utf8")).trim().split("\n").length, 3);
  } finally { await fixture.dispose(); }
}, 180_000);

test("native publication recovery refuses edits made after the recorded landing", async () => {
  const fixture = await divergedLanding();
  try {
    await writeFile(join(fixture.workspace.workspacePath, "later.txt"), "preserve this edit\n");
    const before = fixture.heads();
    await assert.rejects(land(fixture.workspace.workspacePath), /workspace differs from its recorded landing/);
    assert.equal(fixture.heads(), before);
    assert.equal(await readFile(join(fixture.workspace.workspacePath, "later.txt"), "utf8"), "preserve this edit\n");
  } finally { await fixture.dispose(); }
}, 180_000);

test("native publication recovery refuses conflicting committed policies", async () => {
  const fixture = await divergedLanding(true);
  try {
    const before = fixture.heads();
    await assert.rejects(land(fixture.workspace.workspacePath), /committed integration policies disagree/);
    assert.equal(fixture.heads(), before);
    assert.equal(fixture.f.remoteFile("published.txt"), "published\n");
  } finally { await fixture.dispose(); }
}, 180_000);
