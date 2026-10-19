import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jj, revisionFacts, workspaceContext } from "../infra/workspace-jj.ts";
import { repositoryKey } from "../runner/runner-contract.ts";
import type { SubmitRequest } from "../runner/runner-contract.ts";
import { duplicateLandingSource } from "./landing-artifact.ts";
import { rebaseOntoIntegration } from "./landing-candidate.ts";
import { conflictedPaths } from "./landing-steps.ts";
import { importSubmissionSource } from "./submission-source.ts";
import type { RetainedSubmission } from "./submission-source.ts";

/** A landing queued ahead of a submission in its repository, with the source the runner retained for it. */
export type QueuedLanding = { operationId: string; changeId: string; commitId: string; retained: RetainedSubmission };
/** What a submission's dry-run rebase found: the paths, and the queued landing it clashes with (null for the integration head). */
export type SubmissionConflict = { paths: string[]; conflictsWith: { operationId: string; changeId: string } | null };

/**
 * Dry-run the rebases the queue will make, before a submission queues: every landing ahead of it in
 * order, then the candidate, onto the integration head, as the runner rebases a retained submission
 * (`duplicateLandingSource`, then `rebaseOntoIntegration`). It verifies nothing. A landing ahead that conflicts on its own fails
 * on its own, so it is left out of the stack. The candidate is tried after each step, so the first
 * conflict names the change that causes it.
 *
 * It runs in a checkout of its own, never one a lane holds; the caller serializes submissions
 * (see `submissionProbe`).
 */
export async function probeSubmission(input: { home: string; url: string; jjConfig: Readonly<Record<string, string>>; request: SubmitRequest; ahead: readonly QueuedLanding[] }): Promise<SubmissionConflict | null> {
  const { home, request } = input;
  const checkout = probeCheckout(home, request.repo);
  if (!await stat(checkout).then(() => true, () => false)) {
    await mkdir(dirname(checkout), { recursive: true });
    // Cloned aside and renamed into place, so an interrupted clone never becomes the checkout.
    const partial = `${checkout}.${randomUUID()}`;
    try {
      await jj(dirname(checkout), ["git", "clone", input.url, partial]);
      await rename(partial, checkout);
    } finally { await rm(partial, { recursive: true, force: true }); }
  }
  // The runner's jj settings, as in its warm checkouts, so the probe rebases as `rebasing` does.
  for (const [key, value] of Object.entries(input.jjConfig)) await jj(checkout, ["config", "set", "--repo", key, value]);
  const context = await workspaceContext(checkout, undefined, { fetchMissingBookmarks: true });
  if (!context) throw new Error("Probe checkout context is unavailable");
  const remote = context.configuration.remote ?? "origin";
  const head = `${context.integrationBranch}@${remote}`;
  await jj(checkout, ["git", "fetch", "--remote", remote, "--branch", context.integrationBranch, "--branch", request.bookmark], { timeoutMs: 60_000 });
  // Each probe starts from the head: the last probe's copies and imported sources are dropped.
  await jj(checkout, ["new", head]);
  await jj(checkout, ["abandon", "-r", "mutable() ~ @"]);
  if ((await revisionFacts(checkout, `${request.bookmark}@${remote}`)).commitId !== request.commitId)
    throw new Error("Candidate bookmark differs from the submitted commit");
  // The runner's own transition for a retained source: copy it, then move it onto the base (a merge keeps its parents until then).
  const conflicts = async (source: string, base: string) => {
    await rebaseOntoIntegration(checkout, await duplicateLandingSource(checkout, source, base), base, jj);
    const copy = (await revisionFacts(checkout, "@")).commitId;
    return { copy, paths: await conflictedPaths(checkout, copy) };
  };
  let tip = (await revisionFacts(checkout, head)).commitId;
  const alone = await conflicts(request.commitId, tip);
  if (alone.paths.length) return { paths: alone.paths, conflictsWith: null };
  for (const landing of input.ahead) {
    const stacked = await (async () => {
      await importSubmissionSource(home, request.repo, landing.operationId, landing.retained, checkout);
      return conflicts(landing.commitId, tip);
    })().catch(() => null);
    if (!stacked || stacked.paths.length) continue;
    tip = stacked.copy;
    const candidate = await conflicts(request.commitId, tip);
    if (candidate.paths.length) return { paths: candidate.paths, conflictsWith: { operationId: landing.operationId, changeId: landing.changeId } };
  }
  return null;
}

/** The runner-owned checkout a repository's probes run in. */
export const probeCheckout = (home: string, repo: string): string =>
  join(home, "probes", createHash("sha256").update(repositoryKey(repo)).digest("hex").slice(0, 16));

/**
 * The runner's probe: every submission waits on it inside admission, so it never holds admission
 * past `budgetMs`, and never starts while that repository's last probe still runs. Either way, and on
 * failure (reported to `onSkipped`), the submission queues unchecked. An over-budget probe finishes
 * in the background, so a slow first clone still readies the checkout for the next submission.
 */
export function submissionProbe(input: { home: string; url(repo: string): string; jjConfig: Readonly<Record<string, string>>; budgetMs: number;
  onSkipped(repo: string, reason: string): void }): (request: SubmitRequest, ahead: QueuedLanding[]) => Promise<SubmissionConflict | null> {
  const running = new Set<string>();
  return async (request, ahead) => {
    const repo = repositoryKey(request.repo);
    if (running.has(repo)) { input.onSkipped(repo, "the previous probe is still running"); return null; }
    running.add(repo);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (async () => probeSubmission({ home: input.home, url: input.url(request.repo), jjConfig: input.jjConfig, request, ahead }))()
      .catch((error: unknown) => { input.onSkipped(repo, error instanceof Error ? error.message : String(error)); return null; })
      .finally(() => { running.delete(repo); clearTimeout(timer); });
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => { input.onSkipped(repo, `over its ${Math.round(input.budgetMs / 1000)}s budget`); resolve(null); }, input.budgetMs);
      timer.unref?.();
    });
    return Promise.race([probe, budget]);
  };
}
