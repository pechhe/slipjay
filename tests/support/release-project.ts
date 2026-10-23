import { jj, project, recordCheckout } from "./workspace-project.ts";
import { landThroughTestRunner } from "./test-runner.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";

/**
 * A project whose `main` is promoted to `release`, which starts at the initial
 * commit on origin. Its release check records the checkout it verified in
 * `verifiedRelease`, unless `checks` declares others.
 */
export async function releaseProject(options: {
  checks?: (verified: string) => unknown[]; migrations?: boolean; shallow?: boolean;
  /** Declare a production deployment, so a release is a promotion from a commit staging is green on. */
  promotes?: boolean;
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
  if (options.promotes) policy.deployments = { version: 1, environments: { production: { timeoutMs: 30_000,
    projects: [{ name: "app", command: { executable: "node", args: ["-e", ""] }, activate: { executable: "node", args: ["-e", ""] } }] } } };
  await writeFile(policyPath, JSON.stringify(policy));
  const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
  git(["commit", "-qam", "Declare the release policy"]);
  git(["push", "-q", "origin", "main"]);
  git(["push", "-q", "origin", "HEAD~1:refs/heads/release"]);
  jj(f.repo, ["git", "import"]);
  /** Commit `files` straight to `main` on origin, the history a chain of landings would leave. */
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(f.repo, file, ".."), { recursive: true });
      await writeFile(join(f.repo, file), content);
    }
    git(["add", "-A"]); git(["commit", "-qm", message]); git(["push", "-q", "origin", "main"]);
    jj(f.repo, ["git", "import"]);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
  };
  return { ...f, verifiedRelease, commit };
}

export type ReleaseFixture = Awaited<ReturnType<typeof releaseProject>>;

export async function landFile(f: ReleaseFixture, file: string, content = `${file}\n`) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), content);
  const result = await landThroughTestRunner(f, workspace.workspacePath);
  assert.equal(result.ok, true, result.lines.join("\n"));
  assert.equal(result.operation.result?.type, "landed");
  return (result.operation.result as { commitId: string }).commitId;
}

export const remoteRef = (f: ReleaseFixture, branch: string) =>
  execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
export const remoteParents = (f: ReleaseFixture, commit: string) =>
  execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%P", commit], { encoding: "utf8" }).trim().split(" ");
export const remoteTree = (f: ReleaseFixture, commit: string) =>
  execFileSync("git", ["--git-dir", f.remote, "rev-parse", `${commit}^{tree}`], { encoding: "utf8" }).trim();
