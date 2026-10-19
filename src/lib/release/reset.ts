/**
 * A repository's declared `reset` step: rebuild an external target (YardSmith: the
 * Development database, from a scrubbed copy of Production). The runner runs it every
 * `intervalMs` and on demand, alone in its serial queue, so no landing finalizes
 * against that target meanwhile. The target follows the integration branch (landing
 * finalizes each integrated commit against it), so the step runs in an exact source
 * view of the integration tip the runner just fetched. The runner's operation log is
 * its only record.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { checkoutCwd } from "../infra/checkout-cwd.ts";
import { withFinalizationSource } from "./post-integration-source.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { ResetPolicy } from "../policy/post-integration-policy.ts";

const MAX_REASON_CHARACTERS = 300;

/** The first line the step wrote to its reason file, stripped of control characters and bounded; null when none. */
async function readStepReason(file: string): Promise<string | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const line = text.slice(0, 4 * MAX_REASON_CHARACTERS).split(/\r?\n/).find((candidate) => candidate.trim())
    ?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!line) return null;
  return line.length > MAX_REASON_CHARACTERS ? `${line.slice(0, MAX_REASON_CHARACTERS - 1)}…` : line;
}

const finished = (result: BoundedProcessResult): boolean =>
  result.exitCode === 0 && !result.timedOut && !result.error && !result.signal;

/**
 * Run `policy`'s probe, then its command, in an exact source view of `source`. Each
 * goes through `run`, so the caller records it and can abort it. The command's output
 * can echo the secrets it was given, so it goes only to the owner-only `outputPath`;
 * the step may write one short line naming why it failed to `reasonPath`, which is
 * data, bounded to one line. Resolves to null on success, otherwise the failure's reason.
 */
export async function runReset({ gitDirectory, source, policy, outputPath, reasonPath, run, readEnvironment, abortSignal }: {
  gitDirectory: string;
  /** The integration commit whose exact source the step runs in. */
  source: string;
  policy: ResetPolicy;
  outputPath: string;
  reasonPath: string;
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
  /** Where the declared `environmentKeys` are read from. */
  readEnvironment: () => NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  return withFinalizationSource(gitDirectory, source, async (view) => {
    const environment = sanitizedProcessEnv();
    const declared = readEnvironment();
    for (const key of policy.environmentKeys) {
      if (declared[key] !== undefined) environment[key] = declared[key];
    }
    await rm(reasonPath, { force: true });
    Object.assign(environment, { SLIPJAY_RESET_TARGET: policy.target, SLIPJAY_RESET_SOURCE: source, SLIPJAY_RESET_REASON_FILE: reasonPath });
    const probe = await run({
      executable: policy.targetProbe.executable, args: policy.targetProbe.args,
      cwd: await checkoutCwd(view, policy.targetProbe.cwd, "Reset target probe"),
      env: environment, timeoutMs: 30000, maxOutputBytes: 16 * 1024,
    });
    const probed = (() => { try { return (JSON.parse(probe.stdout) as { target?: unknown } | null)?.target; } catch { return undefined; } })();
    if (!finished(probe) || probe.stdoutTruncated || probe.stderrTruncated || probed !== policy.target)
      return `The reset target probe did not confirm ${policy.target}; the reset command did not run`;
    const result = await run({
      executable: policy.command.executable, args: policy.command.args,
      cwd: await checkoutCwd(view, policy.command.cwd, "Reset command"),
      env: environment, timeoutMs: policy.timeoutMs, maxOutputBytes: 64 * 1024,
    });
    await writeFile(outputPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
    if (finished(result)) return null;
    const stepReason = await readStepReason(reasonPath);
    return `Reset command ${result.timedOut ? "timed out" : "failed"}${stepReason ? `: ${stepReason}` : ""}; its output is in ${outputPath}`;
  }, sanitizedProcessEnv, abortSignal);
}
