/**
 * A repository's declared `postRelease` step. Once `slipjay promote` has published,
 * it runs the step the released candidate declares, after its target probe. The
 * runner's queue runs it alone, so no landing finalizes against that target
 * meanwhile. The target follows the integration branch (landing finalizes each
 * integrated commit against it), so the step runs in an exact source view of the
 * local integration branch, not of the candidate: the newest commit any landing
 * has finalized.
 *
 * Its failure never undoes the release. The target's latest outcome is kept on the
 * runner, and a later `slipjay promote --confirm` reruns it (on its own when the
 * candidate is already released) instead of skipping it.
 */
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { checkoutCwd } from "./checkout-cwd.ts";
import { postReleasePolicy } from "./post-integration-policy.ts";
import { readExactExecutionPolicy, withFinalizationSource } from "./post-integration-source.ts";
import { stateHome } from "./workspace-paths.ts";
import { run } from "./workspace-jj.ts";
import { writeWorkspaceJson } from "./workspace-transaction.ts";
import type { PostReleaseOutcome } from "./release.ts";

/** The outcome record this module keeps per target; `status` is the step's latest state. */
type StoredOutcome = {
  version?: number;
  target: string;
  candidate: string;
  merge: string | null;
  source?: string;
  attempt?: number;
  status: "running" | "failed" | "complete";
  reason?: string;
};

// Outcomes are named by the external target alone, so they survive the runner moving to a
// checkout at another path.
const outcomeKeyOf = (target: string): string => createHash("sha256").update(JSON.stringify(["post-release", target])).digest("hex");
const outcomePath = (targetKey: string): string => path.join(stateHome(), "post-release", `${targetKey}.json`);
// The step's output can echo the secrets it was given, so it stays in an owner-only log, never in a result.
const outputPath = (targetKey: string): string => path.join(stateHome(), "post-release", `${targetKey}.log`);
// The step may write one short line here naming why it failed; it is data, bounded to one line, never its raw output.
const reasonPath = (targetKey: string): string => path.join(stateHome(), "post-release", `${targetKey}.reason`);
const MAX_REASON_CHARACTERS = 300;
export const postReleaseRetry = (candidate: string): string => `slipjay promote --confirm ${candidate.slice(0, 12)}`;

/** The first line the step wrote to its reason file, stripped of control characters and bounded; null when none. */
async function readStepReason(file: string): Promise<string | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const line = text.slice(0, 4 * MAX_REASON_CHARACTERS).split(/\r?\n/).find((candidate) => candidate.trim())
    ?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!line) return null;
  return line.length > MAX_REASON_CHARACTERS ? `${line.slice(0, MAX_REASON_CHARACTERS - 1)}…` : line;
}

async function readOutcome(file: string): Promise<StoredOutcome | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as StoredOutcome | null;
    return value && ["running", "failed", "complete"].includes(value.status) ? value : null;
  } catch {
    return null;
  }
}

/** The candidate's declared step, its target key and the target's latest outcome; null when none is declared. */
async function declaredStep(root: string, candidate: string) {
  const gitRoot = await run("jj", ["--color=never", "--ignore-working-copy", "git", "root"], { cwd: root });
  if (gitRoot.code !== 0) throw new Error(`jj git root failed: ${(gitRoot.stderr || gitRoot.stdout).trim()}`);
  const { gitDirectory, configuration } = await readExactExecutionPolicy(gitRoot.stdout.trim(), candidate);
  const policy = postReleasePolicy(configuration?.postRelease);
  if (!policy) return null;
  const targetKey = outcomeKeyOf(policy.target);
  await adoptLegacyOutcome(policy.target, targetKey);
  return { gitDirectory, policy, targetKey, latest: await readOutcome(outcomePath(targetKey)) };
}

/**
 * Rename an outcome SlipJay 3.6 and earlier wrote under a checkout-and-target key to its
 * target key. That checkout may be on the host this state was copied from, so the legacy
 * record is found by the target it names, not by recomputing its key.
 */
async function adoptLegacyOutcome(target: string, targetKey: string): Promise<void> {
  const directory = path.dirname(outcomePath(targetKey));
  if (await access(outcomePath(targetKey)).then(() => true, () => false)) return;
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const legacy: string[] = [];
  for (const name of names) if ((await readOutcome(path.join(directory, name)))?.target === target) legacy.push(name.slice(0, -".json".length));
  if (legacy.length > 1) throw new Error(`Several post-release outcomes name ${target} (${legacy.join(", ")} in ${directory}); keep the newest and delete the others`);
  const [key] = legacy;
  if (!key) return;
  for (const file of [outputPath, reasonPath]) await rename(file(key), file(targetKey)).catch(() => {});
  await rename(outcomePath(key), outcomePath(targetKey));
}

/**
 * Run the step declared at `candidate` for the release `merge`. With `onlyIfPending`,
 * run it only when the target's latest outcome did not complete. Resolves to null
 * when no step is declared or none is pending; never rejects for the step's own failure.
 */
export async function runPostRelease({ root, integrationBranch, candidate, merge, onlyIfPending = false, onProgress = () => {}, environment: readEnvironment = () => process.env }: {
  root: string;
  /** The step runs in the exact source of this local branch. */
  integrationBranch: string;
  candidate: string;
  merge: string;
  onlyIfPending?: boolean;
  onProgress?: (line: string) => void;
  /** Where the declared `environmentKeys` are read from. */
  environment?: () => NodeJS.ProcessEnv;
}): Promise<PostReleaseOutcome | null> {
  const step = await declaredStep(root, candidate);
  if (!step || onlyIfPending && (!step.latest || step.latest.status === "complete")) return null;
  const { gitDirectory, policy, targetKey } = step;
  const file = outcomePath(targetKey);
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const attempt = (step.latest?.status === "complete" ? 0 : step.latest?.attempt ?? 0) + 1;
  // A step that could not start (the integration branch) is recorded too, so a retry finds it pending.
  const notStarted = async (error: unknown): Promise<PostReleaseOutcome> => {
    const failed: StoredOutcome = { version: 1, target: policy.target, candidate, merge, attempt, status: "failed",
      reason: `The post-release step could not start: ${error instanceof Error ? error.message : String(error)}` };
    await writeWorkspaceJson(file, failed);
    return { ok: false, ...failed, retry: postReleaseRetry(candidate) };
  };
  const runStep = async (): Promise<PostReleaseOutcome | null> => {
    const tip = await run("jj", ["--color=never", "--ignore-working-copy", "log", "--no-graph", "-r", JSON.stringify(integrationBranch),
      "-T", "commit_id"], { cwd: root });
    const source = tip.stdout.trim();
    if (tip.code !== 0 || !/^[a-f0-9]{40,64}$/.test(source)) throw new Error(`Could not resolve ${integrationBranch}: ${(tip.stderr || tip.stdout).trim()}`);
    const evidence = { version: 1, target: policy.target, candidate, merge, source, attempt };
    await writeWorkspaceJson(file, { ...evidence, status: "running" });
    onProgress(`[release] post-release: running against ${policy.target}`);
    let reason = "Exact source preparation failed";
    try {
      await withFinalizationSource(gitDirectory, source, async (view) => {
        const environment = sanitizedProcessEnv();
        const declared = readEnvironment();
        for (const key of policy.environmentKeys) {
          if (declared[key] !== undefined) environment[key] = declared[key];
        }
        await rm(reasonPath(targetKey), { force: true });
        Object.assign(environment, { SLIPJAY_RELEASE_CANDIDATE: candidate, SLIPJAY_RELEASE_MERGE: merge,
          SLIPJAY_RELEASE_SOURCE: source, SLIPJAY_RELEASE_TARGET: policy.target,
          SLIPJAY_RELEASE_REASON_FILE: reasonPath(targetKey) });
        reason = "External target could not be verified";
        const probe = await runBoundedProcess({
          executable: policy.targetProbe.executable, args: policy.targetProbe.args,
          cwd: await checkoutCwd(view, policy.targetProbe.cwd, "Post-release target probe"),
          env: environment, timeoutMs: 30000, maxOutputBytes: 16 * 1024,
        });
        if (probe.exitCode !== 0 || probe.timedOut || probe.error || probe.signal || probe.stdoutTruncated || probe.stderrTruncated)
          throw new Error(reason);
        const target = JSON.parse(probe.stdout) as { target?: string } | null;
        if (!target || target.target !== policy.target) throw new Error(reason);
        reason = "Post-release command failed or timed out";
        const result = await runBoundedProcess({
          executable: policy.command.executable, args: policy.command.args,
          cwd: await checkoutCwd(view, policy.command.cwd, "Post-release command"),
          env: environment, timeoutMs: policy.timeoutMs, maxOutputBytes: 64 * 1024,
        });
        await writeFile(outputPath(targetKey), `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
        if (result.exitCode !== 0 || result.timedOut || result.error || result.signal) {
          const stepReason = await readStepReason(reasonPath(targetKey));
          reason = `Post-release command ${result.timedOut ? "timed out" : "failed"}${stepReason ? `: ${stepReason}` : ""}`;
          throw new Error(reason = `${reason}; its output is in ${outputPath(targetKey)}`);
        }
      }, sanitizedProcessEnv);
      const complete: StoredOutcome = { ...evidence, status: "complete" };
      await writeWorkspaceJson(file, complete);
      return { ok: true, ...complete };
    } catch {
      const failed: StoredOutcome = { ...evidence, status: "failed", reason };
      await writeWorkspaceJson(file, failed);
      return { ok: false, ...failed, retry: postReleaseRetry(candidate) };
    }
  };
  return runStep().catch(notStarted);
}
