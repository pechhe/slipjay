import { jj, project, recordCheckout } from "./workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace, landWorkspace } from "../../src/lib/slipjay.mjs";

/**
 * A project whose `main` is promoted to `release`, which starts at the initial
 * commit on origin. Its release check records the checkout it verified in
 * `verifiedRelease`, unless `checks` declares others. `postRelease` adds that step.
 */
export async function releaseProject(options: {
  checks?: (verified: string) => unknown[]; migrations?: boolean; shallow?: boolean;
  /** The `postRelease` declaration, given the fixture's root and remote. */
  postRelease?: (root: string, remote: string) => unknown;
} = {}) {
  const f = await project({
    shallow: options.shallow,
    policy: {
      releaseBranch: "release",
      // Filled below once the fixture's root is known.
      requiredReleaseVerification: [],
      ...(options.migrations ? { migrationFinalization: {
        mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
        generate: { executable: "node", args: ["-e", ""] }, verify: { executable: "node", args: ["-e", ""] } } } : {}),
    },
  });
  const verifiedRelease = join(f.root, "release-verified.log");
  const policyPath = join(f.repo, "slipjay.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.requiredReleaseVerification = options.checks?.(verifiedRelease)
    ?? [{ executable: "node", args: ["-e", recordCheckout(verifiedRelease)] }];
  if (options.postRelease) policy.postRelease = options.postRelease(f.root, f.remote);
  await writeFile(policyPath, JSON.stringify(policy));
  const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
  git(["commit", "-qam", "Declare the release policy"]);
  git(["push", "-q", "origin", "main"]);
  git(["push", "-q", "origin", "HEAD~1:refs/heads/release"]);
  jj(f.repo, ["git", "import"]);
  return { ...f, verifiedRelease };
}

export type ReleaseFixture = Awaited<ReturnType<typeof releaseProject>>;

/**
 * A release check that records the checkout it verifies in `verified`, then holds
 * until `${verified}.go` exists (and, for a candidate carrying `slow.txt`, also
 * `${verified}.slow`), and fails a candidate carrying `broken.txt`.
 */
export const gatedReleaseCheck = (verified: string) => {
  const until = (gate: string) => `{const end=Date.now()+600000;while(!fs.existsSync(${JSON.stringify(gate)})&&Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}}`;
  return [{ executable: "node", args: ["-e", `${recordCheckout(verified)};const fs=require("fs");${until(`${verified}.go`)}`
    + `if(fs.existsSync("slow.txt"))${until(`${verified}.slow`)}if(fs.existsSync("broken.txt"))process.exit(3)`] }];
};

/** Let every gated release check through, now and later; `slow` also opens the gate for `slow.txt` candidates. */
export const openReleaseGate = async (f: ReleaseFixture, { slow = false } = {}) => {
  await writeFile(`${f.verifiedRelease}.go`, "");
  if (slow) await writeFile(`${f.verifiedRelease}.slow`, "");
};

/** The checkouts release checks verified so far, by candidate prefix, in order. */
export const verifiedCandidates = async (f: ReleaseFixture) =>
  (await readFile(f.verifiedRelease, "utf8").catch(() => "")).split("\n").filter(Boolean)
    .map((line) => line.match(/releases\/checkouts\/([a-f0-9]{12})/)?.[1] ?? line);

export async function landFile(f: ReleaseFixture, file: string, content = `${file}\n`) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), content);
  const result = await landWorkspace(workspace.workspacePath, { onProgress: () => {}, sweepOtherWorkspaces: false });
  assert.equal(result.ok, true, JSON.stringify(result.publication));
  return result.artifact.commitId as string;
}

/**
 * Commit `file` straight onto the published integration branch, as a landing
 * would but without its gate, so a test can publish several candidates quickly.
 */
export async function publishFile(f: ReleaseFixture, file: string) {
  await writeFile(join(f.repo, file), `${file}\n`);
  const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8", stdio: "pipe" }).trim();
  git(["add", file]);
  git(["commit", "-qm", `Add ${file}`]);
  git(["push", "-q", "origin", "main"]);
  jj(f.repo, ["git", "import"]);
  return git(["rev-parse", "HEAD"]);
}

export const remoteRef = (f: ReleaseFixture, branch: string) =>
  execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
export const remoteParents = (f: ReleaseFixture, commit: string) =>
  execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%P", commit], { encoding: "utf8" }).trim().split(" ");
export const remoteTree = (f: ReleaseFixture, commit: string) =>
  execFileSync("git", ["--git-dir", f.remote, "rev-parse", `${commit}^{tree}`], { encoding: "utf8" }).trim();

/** Resolves once `condition` holds, polling; fails after `timeoutMs`. */
export async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
