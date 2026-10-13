import { access, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { EXECUTION_POLICY_PROBE_PATHS, parseExecutionPolicy, selectExecutionPolicyPath } from "./execution-policy.ts";
import { postIntegrationPolicy } from "./post-integration-policy.ts";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import type { ExecutionPolicy } from "./execution-policy.ts";
import type { PostIntegrationPolicy } from "./post-integration-policy.ts";

type Environment = () => NodeJS.ProcessEnv;

export async function finalizationGit(gitDirectory: string, args: string[], environment: Environment = sanitizedProcessEnv): Promise<string> {
  const result = await runBoundedProcess({
    executable: "git",
    args: ["--git-dir", gitDirectory, ...args],
    cwd: gitDirectory,
    env: environment(),
    timeoutMs: 30000,
    maxOutputBytes: 512 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut || result.error || result.signal || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("Exact-revision source operation failed");
  }
  return result.stdout;
}
/** Why an exact source view could not be prepared, naming the commit and cause. */
export class SourcePreparationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePreparationFailure";
  }
}

const isShallow = (gitDirectory: string): Promise<boolean> => access(path.join(gitDirectory, "shallow")).then(() => true, () => false);

/** The commit and repository named, with the shallow state that most often explains a missing object. */
async function missingCommit(gitDirectory: string, commit: string, detail?: string): Promise<SourcePreparationFailure> {
  const shallow = await isShallow(gitDirectory);
  return new SourcePreparationFailure(`Integrated commit ${commit} could not be read from ${gitDirectory}`
    + (shallow ? " (a shallow repository)" : "") + (detail ? `: ${detail}` : ""));
}

// An empty repository that borrows the source's object store through an explicit
// alternate. Unlike `git clone --shared`, which a shallow source silently degrades
// to a ref-reachable copy, every object in the store stays readable whether or not
// a Git ref reaches it. A detached checkout takes seconds on an idle machine; the
// bound guards a hung git, not a loaded one.
const SOURCE_VIEW_STEP_TIMEOUT_MS = 300000;
export function withFinalizationSource<T>(gitDirectory: string, commit: string, operation: (root: string) => Promise<T>, environment: Environment = sanitizedProcessEnv, abortSignal?: AbortSignal): Promise<T> {
  return Effect.runPromise(Effect.acquireUseRelease(Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "peach-post-integration-"))), (directory) => Effect.tryPromise({ try: async () => {
    const root = path.join(directory, "source");
    const objects = await realpath(path.resolve(gitDirectory, (await finalizationGit(gitDirectory, ["rev-parse", "--git-path", "objects"], environment)).trim()));
    const present = await runBoundedProcess({
      executable: "git", args: ["--git-dir", gitDirectory, "cat-file", "-e", `${commit}^{commit}`],
      cwd: directory, env: environment(), abortSignal, timeoutMs: 30000, maxOutputBytes: 16 * 1024
    });
    if (present.exitCode !== 0 || present.timedOut || present.error || present.signal)
      throw await missingCommit(gitDirectory, commit, "the object is not in its store");
    const init = await runBoundedProcess({
      executable: "git", args: ["init", "--quiet", "--template=", "--", root],
      cwd: directory, env: environment(), abortSignal, timeoutMs: 30000, maxOutputBytes: 16 * 1024
    });
    if (init.exitCode !== 0 || init.timedOut || init.error || init.signal)
      throw new SourcePreparationFailure(`Could not create a source view for integrated commit ${commit}`);
    await mkdir(path.join(root, ".git", "objects", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "objects", "info", "alternates"), `${objects}\n`);
    // The view shares the source's history boundary, so its own traversal stops where the source's does.
    if (await isShallow(gitDirectory)) await copyFile(path.join(gitDirectory, "shallow"), path.join(root, ".git", "shallow"));
    const checkout = await runBoundedProcess({
      executable: "git",
      args: ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit],
      cwd: root,
      env: environment(), abortSignal,
      timeoutMs: SOURCE_VIEW_STEP_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024
    });
    if (checkout.exitCode !== 0 || checkout.timedOut || checkout.error || checkout.signal)
      throw await missingCommit(gitDirectory, commit, checkout.timedOut ? "checkout timed out" : checkout.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300));
    const head = (await finalizationGit(path.join(root, ".git"), ["rev-parse", "HEAD"], environment)).trim();
    if (head !== commit)
      throw new SourcePreparationFailure(`Source view resolved ${head}, not integrated commit ${commit}`);
    return operation(root);
  }, catch: (cause) => cause instanceof Error ? cause : new Error("Exact-revision source view failed") }), (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))));
}

/** Read a policy from a proven object, never the caller's working files. No external effects. */
export async function readExactExecutionPolicy(selectedGitDirectory: string, commit: string, environment: Environment = sanitizedProcessEnv): Promise<{ gitDirectory: string; configuration: ExecutionPolicy | null }> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An exact commit is required");
  const selectedDirectory = await realpath(selectedGitDirectory);
  const commonDirectory = (await finalizationGit(selectedDirectory, ["rev-parse", "--git-common-dir"], environment)).trim();
  const gitDirectory = await realpath(path.resolve(selectedDirectory, commonDirectory));
  const resolved = (await finalizationGit(gitDirectory, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], environment)
    .catch(async () => { throw await missingCommit(gitDirectory, commit, "the object is not in its store"); })).trim();
  if (resolved !== commit) throw new Error("Commit identity changed");
  const listed = new Set((await finalizationGit(gitDirectory, ["ls-tree", "--name-only", commit, "--", ...EXECUTION_POLICY_PROBE_PATHS], environment))
    .split("\n").map((line) => line.trim()).filter(Boolean));
  const policyPath = await selectExecutionPolicyPath(async (candidate: string) => listed.has(candidate), gitDirectory);
  if (!policyPath) return { gitDirectory, configuration: null };
  // The same strict rules as landing, applied to the exact integrated object.
  const configuration = parseExecutionPolicy(await finalizationGit(gitDirectory, ["show", `${commit}:${policyPath}`], environment), policyPath);
  return { gitDirectory, configuration };
}

export async function readPostIntegrationPolicy(selectedGitDirectory: string, commit: string, environment: Environment = sanitizedProcessEnv): Promise<{ gitDirectory: string; policy: PostIntegrationPolicy | null }> {
  const { gitDirectory, configuration } = await readExactExecutionPolicy(selectedGitDirectory, commit, environment);
  return { gitDirectory, policy: postIntegrationPolicy(configuration?.postIntegration) };
}
