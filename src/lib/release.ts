/**
 * `slipjay release`: promote the published integration branch to the release
 * branch its committed policy declares. Without a confirmation it only plans: it
 * names the candidate (the integration branch on the remote), the base (the
 * release branch on the remote), the commits between them, any migration
 * artifacts and any half-built Specs (warned about, never refused). With `confirm`, the candidate commit id a human approved, it checks
 * that exact commit out on its own, runs `requiredReleaseVerification`, builds the
 * release merge, refuses unless its tree is the verified tree, and publishes it.
 * Concurrent confirms coalesce: see `holdReleaseSlot`. Once it has published, it
 * runs the candidate's declared `postRelease` step (see `post-release.ts`), whose
 * failure is reported in the result without undoing the release.
 *
 * jj commands ignore working copies, except creating the verification checkout,
 * which snapshots only the checkout the release runs from.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readExecutionPolicyAtCommit } from "./execution-policy.ts";
import { githubRepository } from "./post-land-issue.ts";
import { pendingPostRelease, postReleaseRetry, runPostRelease } from "./post-release.ts";
import { halfBuiltSpecs } from "./release-specs.ts";
import { runRequiredVerification } from "./required-verification.ts";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.ts";
import { run, workspaceContext } from "./workspace-jj.ts";
import { stateHome } from "./workspace-paths.ts";
import { appendMetric } from "./metrics.ts";
import { withVerificationSlot } from "./verification-slot.ts";

import type { GraphqlRunner, HalfBuiltSpecs } from "./release-specs.ts";
import type { VerificationDeclaration, VerificationEvidence } from "./verification-policy.ts";
import type { WorkspaceCommandResult } from "./workspace-command.ts";
import type { VerificationSlotRecord } from "./verification-slot.ts";

export type ReleasePlan = {
  root: string;
  integrationRoot: string;
  remote: string;
  integrationBranch: string;
  releaseBranch: string;
  /** The release branch on the remote. */
  base: string;
  /** The integration commit being released. */
  candidate: string;
  commits: Array<{ commitId: string; subject: string; description: string }>;
  migrationArtifacts: string[];
  checks: VerificationDeclaration[];
};

export type ReleaseSummary = {
  integrationBranch: string;
  releaseBranch: string;
  remote: string;
  base: string;
  candidate: string;
  commits: number;
  migrationArtifacts: string[];
  checks: string[];
  /** Open Specs with Tickets in the range; absent when the range is empty. */
  halfBuiltSpecs?: HalfBuiltSpecs;
};

/** The outcome of a repository's declared `postRelease` step for one release. */
export type PostReleaseOutcome = {
  ok: boolean;
  status: "running" | "failed" | "complete";
  target?: string;
  candidate: string;
  /** Null only when the merge that shipped the candidate could not be read. */
  merge: string | null;
  /** The integration commit whose exact source the step ran in. */
  source?: string;
  attempt?: number;
  reason?: string;
  /** The command that reruns a step that did not complete. */
  retry?: string;
};

/** Present after a confirmed release, or a confirm that retried a pending step. */
type PostReleaseField = { postRelease?: PostReleaseOutcome };
/** Present on a plan while the target's latest post-release step did not complete. */
type PendingPostReleaseField = { pendingPostRelease?: PostReleaseOutcome };

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary & PostReleaseField & PendingPostReleaseField)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary & PendingPostReleaseField)
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary & PostReleaseField)
  /**
   * The release branch already contains the candidate: a release this one waited
   * for shipped it, so it verified nothing. `merge` is the release merge that
   * first contained it and `releasedBy` that merge's candidate. Without such a
   * merge (the branch was moved outside `slipjay release`), `merge` is the
   * release branch head and `releasedBy` null. The summary describes the plan
   * against that head, so `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary & PostReleaseField)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: unknown };

type ReleaseOptions = { confirm?: string; migrationsReady?: boolean; onProgress?: (line: string) => void; graphql?: GraphqlRunner };
type ShippedOutcome = { summary: ReleaseSummary; merge: string; releasedBy: string | null };
type VerifiedOutcome = { summary: ReleaseSummary; merge: string; verification: VerificationEvidence | { passed: never[]; gaps: never[] } };

const COMMIT_PREFIX = /^[a-f0-9]{12,64}$/;
const CANDIDATE_TRAILER = "Release-Candidate: ";
const releaseHome = (): string => join(stateHome(), "releases");

class ReleaseRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRefusal";
  }
}
const refuse: (message: string) => never = (message) => { throw new ReleaseRefusal(message); };

const jjRun = (cwd: string, args: string[]): Promise<WorkspaceCommandResult> => run("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd });

async function jjOut(cwd: string, args: string[]): Promise<string> {
  const result = await jjRun(cwd, args);
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const lines = (text: string): string[] => text.split("\n").filter(Boolean);
const commitIds = async (cwd: string, revset: string): Promise<string[]> => lines(await jjOut(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']));
const symbol = (name: string): string => JSON.stringify(name);

async function commitOf(cwd: string, revset: string): Promise<string | null> {
  const result = await jjRun(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']);
  const ids = result.code === 0 ? lines(result.stdout) : [];
  return ids.length === 1 ? ids[0]! : null;
}

const fetch = (cwd: string, remote: string, branch: string): Promise<WorkspaceCommandResult> => jjRun(cwd, ["git", "fetch", "--remote", remote, "--branch", branch]);

/**
 * What a release from `cwd`'s repository would publish. `candidate` pins a commit
 * id (or 12+ character prefix) that must already be published on the integration
 * branch; by default the candidate is the integration branch on the remote.
 */
export async function planRelease(cwd = process.cwd(), { candidate: pinned }: { candidate?: string } = {}): Promise<ReleasePlan> {
  const context = await workspaceContext(cwd);
  if (!context) refuse(`Not inside a Jujutsu repository: ${cwd}`);
  const root = context.current.root;
  const integrationBranch = context.integrationBranch;
  const remote = context.configuration.remote;
  if (!remote) refuse("slipjay.json declares no publication remote; a release publishes the release branch to it");

  const fetched = await fetch(root, remote, integrationBranch);
  if (fetched.code !== 0) refuse(`Could not fetch ${integrationBranch} from ${remote}: ${fetched.stderr.trim()}`);
  const published = `${symbol(integrationBranch)}@${symbol(remote)}`;
  if (pinned !== undefined && !COMMIT_PREFIX.test(pinned)) refuse("The release candidate must be a commit id or a prefix of at least 12 hex characters");
  const candidate = await commitOf(root, pinned ?? published);
  if (!candidate) refuse(pinned ? `No single commit matches ${pinned}` : `${integrationBranch}@${remote} does not exist`);
  if (!await commitOf(root, `${candidate} & ::${published}`)) refuse(`${candidate} is not published on ${integrationBranch}@${remote}`);

  // The candidate's own committed policy decides what a release of it requires.
  const { policy } = await readExecutionPolicyAtCommit(root, candidate);
  const releaseBranch = policy?.releaseBranch;
  if (!releaseBranch) refuse(`slipjay.json at ${candidate.slice(0, 12)} declares no releaseBranch`);
  const checks = policy.requiredReleaseVerification;
  if (!checks) refuse(`slipjay.json at ${candidate.slice(0, 12)} declares no requiredReleaseVerification (declare [] to release without checks)`);

  const fetchedRelease = await fetch(root, remote, releaseBranch);
  if (fetchedRelease.code !== 0) refuse(`Could not fetch ${releaseBranch} from ${remote}: ${fetchedRelease.stderr.trim()}`);
  const base = await commitOf(root, `${symbol(releaseBranch)}@${symbol(remote)}`);
  if (!base) refuse(`${releaseBranch}@${remote} does not exist; publish the release branch once before releasing to it`);

  const commits = lines(await jjOut(root, ["log", "--no-graph", "-r", `::${candidate} ~ ::${base}`,
    "-T", 'commit_id ++ "\\t" ++ description.escape_json() ++ "\\n"'])).map((line) => {
    const [commitId, encoded] = line.split("\t");
    const description = JSON.parse(encoded!) as string;
    return { commitId: commitId!, subject: description.split("\n")[0]!, description };
  });
  const artifactPaths = policy.migrationFinalization?.artifactPaths ?? [];
  const changed = commits.length ? lines(await jjOut(root, ["diff", "--from", base, "--to", candidate, "--name-only"])) : [];
  const migrationArtifacts = changed.filter((file) => artifactPaths.some((path: string) => file === path || file.startsWith(`${path}/`)));
  return { root, integrationRoot: context.integration.root, remote, integrationBranch, releaseBranch,
    base, candidate, commits, migrationArtifacts, checks };
}

/** Check the candidate out on its own, prepare its dependencies and run the declared checks. */
async function verifyCandidate(plan: ReleasePlan, onProgress: (line: string) => void): Promise<VerifiedOutcome["verification"]> {
  const short = plan.candidate.slice(0, 12);
  const name = `slipjay-release-${short}`;
  const checkout = join(releaseHome(), "checkouts", short);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(join(releaseHome(), "checkouts"), { recursive: true });
  // A leftover from an interrupted release would block the name.
  await jjRun(plan.root, ["workspace", "forget", name]);
  const added = await run("jj", ["--color=never", "workspace", "add", "--name", name, "--revision", plan.candidate, checkout], { cwd: plan.root });
  if (added.code !== 0) throw new Error(`jj workspace add failed: ${(added.stderr || added.stdout).trim()}`);
  try {
    if (!plan.checks.length) return { passed: [], gaps: [] };
    onProgress(`[release] preparing dependencies for ${short}`);
    await prepareWorkspaceDependencies(checkout, { quiet: true });
    // The caller holds the release slot, so this verification passes straight through it.
    return await runRequiredVerification({ checks: plan.checks, root: checkout, onProgress });
  } finally {
    const workingCopy = await commitOf(plan.root, `${symbol(name)}@`);
    await jjRun(plan.root, ["workspace", "forget", name]);
    if (workingCopy) await jjRun(plan.root, ["abandon", workingCopy]);
    await rm(checkout, { recursive: true, force: true });
  }
}

/**
 * Run a release's verification and publication in the repository's release slot.
 * Releases have their own slot: a release verifies a pinned candidate in its own
 * checkout and only touches the release branch, so landings never wait for it.
 *
 * Candidates sit on the linear integration branch, so of any two one contains the
 * other, and a release of the newer ships both. A confirm therefore never refuses
 * a busy slot: it waits, standing aside for every waiting release whose candidate
 * contains its own, so of several waiters only the newest verifies. The operation
 * re-reads the release branch once it holds the slot; what the release it waited
 * for already shipped needs no verification. A dead contender's records and lock
 * go stale as for any verification slot, so they never block.
 *
 * Resolves to null, without the slot, when the release branch already contains
 * the candidate while another release holds the slot or outranks this one: the
 * release it waited for shipped it, and waiting behind the next cannot add to that.
 */
async function holdReleaseSlot<T>(plan: ReleasePlan, onProgress: (line: string) => void, operation: () => Promise<T>): Promise<T | null> {
  const ours = plan.candidate;
  const short = (commit: string): string => commit.slice(0, 12);
  const containment = new Map<string, boolean>();
  let fetched = false;
  // Whether `theirs` contains ours. A candidate published after this plan's fetch is fetched once.
  const contains = async (theirs: unknown): Promise<boolean> => {
    if (typeof theirs !== "string" || !/^[a-f0-9]{40,64}$/.test(theirs)) return false;
    if (theirs === ours) return true;
    if (!containment.has(theirs)) {
      if (!await commitOf(plan.root, theirs)) {
        if (fetched) return false;
        fetched = true;
        await fetch(plan.root, plan.remote, plan.integrationBranch);
        if (!await commitOf(plan.root, theirs)) return false;
      }
      containment.set(theirs, Boolean(await commitOf(plan.root, `${ours} & ::${theirs}`)));
    }
    return containment.get(theirs)!;
  };
  const earlier = (record: VerificationSlotRecord, own: VerificationSlotRecord): boolean => record.since < own.since || (record.since === own.since && record.id < own.id);
  const released = `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`;
  const shipped = new AbortController();
  let reported = "";
  try {
    return await withVerificationSlot(operation, {
    scope: `${plan.integrationRoot}#release`,
    label: `release ${short(ours)}`,
    record: { candidate: ours },
    signal: shipped.signal,
    yieldTo: async ({ own, holder, waiters }): Promise<boolean> => {
      // Stand aside for a waiter that ships ours: newer, or the same candidate confirmed earlier.
      let newer: VerificationSlotRecord | null = null;
      for (const waiter of waiters) {
        if (await contains(waiter.candidate) && (waiter.candidate !== ours || earlier(waiter, own))) newer = waiter;
      }
      // Waiting behind anyone, report a candidate the release branch already holds instead.
      // Publishing fetched the release branch into the shared repository, so no fetch is needed to see it.
      if ((newer || holder) && await commitOf(plan.root, `${ours} & ::${released}`)) {
        shipped.abort();
        return true;
      }
      const attached = holder && await contains(holder.candidate) ? holder : newer;
      const awaited = attached ?? holder;
      if (awaited) {
        const name = typeof awaited.candidate === "string" ? `release ${short(awaited.candidate)}` : awaited.label ?? "another release";
        const line = `[release] waiting for ${name} ${attached ? `(contains ${short(ours)})` : `to finish before ${short(ours)}`}`;
        if (line !== reported) onProgress(reported = line);
      }
      return Boolean(newer);
    },
    });
  } catch (error) {
    if (shipped.signal.aborted) return null;
    throw error;
  }
}

/** The release merge on the release branch that first shipped `plan.candidate`, and its candidate. */
async function shippedBy(plan: ReleasePlan): Promise<{ merge: string; releasedBy: string | null }> {
  const released = `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`;
  const [found] = await commitIds(plan.root,
    `roots(merges() & ${plan.candidate}:: & ::${released} & description(substring:${symbol(CANDIDATE_TRAILER)}))`);
  const merge = found ?? plan.base;
  const description = await jjOut(plan.root, ["log", "--no-graph", "-r", merge, "-T", "description"]);
  return { merge, releasedBy: description.match(/^Release-Candidate: ([a-f0-9]+)$/m)?.[1] ?? null };
}

const releaseMessage = (plan: ReleasePlan): string =>
  `Release ${plan.integrationBranch} to ${plan.releaseBranch}\n\n${CANDIDATE_TRAILER}${plan.candidate}\n`;
const mergeRevset = (plan: ReleasePlan): string =>
  `children(${plan.base}) & children(${plan.candidate}) & description(substring:${symbol(`${CANDIDATE_TRAILER}${plan.candidate}`)})`;

/** Build the release merge; refuse unless it is conflict-free and its tree is the candidate's. */
async function buildMerge(plan: ReleasePlan): Promise<string> {
  // Discard an unpublished merge left by an interrupted attempt.
  for (const stale of await commitIds(plan.root, mergeRevset(plan))) await jjRun(plan.root, ["abandon", stale]);
  await jjOut(plan.root, ["new", "--no-edit", "-m", releaseMessage(plan), plan.base, plan.candidate]);
  const merges = await commitIds(plan.root, mergeRevset(plan));
  if (merges.length !== 1) refuse(`Expected one release merge, found ${merges.length}`);
  const [merge] = merges;
  const conflicted = await jjOut(plan.root, ["log", "--no-graph", "-r", merge!, "-T", 'if(conflict, "conflict", "")']);
  const differs = lines(await jjOut(plan.root, ["diff", "--from", plan.candidate, "--to", merge!, "--name-only"]));
  if (conflicted || differs.length) {
    await jjRun(plan.root, ["abandon", merge!]);
    refuse(`The release merge is not the verified tree (${conflicted ? "it conflicts" : `it also changes ${differs.slice(0, 10).join(", ")}`}): `
      + `${plan.releaseBranch} has changes ${plan.integrationBranch} lacks. Integrate them into ${plan.integrationBranch} first.`);
  }
  return merge!;
}

/** Move the release bookmark to the merge and push it; jj refuses if the remote moved since the fetch. */
async function publish(plan: ReleasePlan, merge: string): Promise<void> {
  const bookmark = symbol(plan.releaseBranch);
  await jjRun(plan.root, ["bookmark", "track", `${bookmark}@${symbol(plan.remote)}`]);
  await jjOut(plan.root, ["bookmark", "set", plan.releaseBranch, "-r", merge]);
  const pushed = await jjRun(plan.root, ["git", "push", "--remote", plan.remote, "--bookmark", plan.releaseBranch]);
  await fetch(plan.root, plan.remote, plan.releaseBranch);
  if (await commitOf(plan.root, `${merge} & ::${bookmark}@${symbol(plan.remote)}`)) return;
  await jjRun(plan.root, ["bookmark", "set", plan.releaseBranch, "--allow-backwards", "-r", `${bookmark}@${symbol(plan.remote)}`]);
  await jjRun(plan.root, ["abandon", merge]);
  refuse(`Push of ${plan.releaseBranch} to ${plan.remote} failed: ${(pushed.stderr || pushed.stdout).trim() || "the remote does not contain the release"}`);
}

/**
 * Plan, or with `confirm` verify and publish, a release. `confirm` is the
 * candidate commit a human approved; `migrationsReady` acknowledges that the
 * release's migration artifacts are already applied where it deploys.
 */
export async function releaseIntegration(cwd = process.cwd(), options: ReleaseOptions = {}): Promise<ReleaseResult> {
  const startedAt = Date.now();
  const measured: { verifyMs?: number } = {};
  const result: ReleaseResult & { candidate?: string; commits?: number } = await releaseIntegrationUnmeasured(cwd, options, (verifyMs) => { measured.verifyMs = verifyMs; });
  if (options.confirm !== undefined) {
    await appendMetric("releases", { status: result.status, candidate: result.candidate ?? options.confirm,
      commits: result.commits ?? null, totalMs: Date.now() - startedAt, ...measured });
  }
  return result;
}

/**
 * Run the declared post-release step for a published release. Whatever goes wrong,
 * the release stands: a failure, even one to take the target lease, becomes a
 * reported `postRelease` outcome with its retry command.
 */
async function runPostReleaseStep(plan: ReleasePlan, mergeOf: () => Promise<string>, onProgress: (line: string) => void, { onlyIfPending }: { onlyIfPending: boolean }): Promise<PostReleaseField> {
  let merge: string | null = null;
  try {
    merge = await mergeOf();
    const outcome = await runPostRelease({ root: plan.root, integrationBranch: plan.integrationBranch, candidate: plan.candidate,
      merge, onlyIfPending, onProgress });
    if (outcome && !outcome.ok) onProgress(`[release] post-release step failed: ${outcome.reason}. Retry with \`${outcome.retry}\`.`);
    return outcome ? { postRelease: outcome } : {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retry = postReleaseRetry(plan.candidate);
    onProgress(`[release] post-release step failed: ${reason}. Retry with \`${retry}\`.`);
    return { postRelease: { ok: false, status: "failed", candidate: plan.candidate, merge, reason, retry } };
  }
}

/** A plan reports a post-release step that did not complete, so no release silently skips it. */
async function pendingPostReleaseField(plan: ReleasePlan): Promise<PendingPostReleaseField> {
  const pending = await pendingPostRelease(plan.root, plan.candidate);
  return pending ? { pendingPostRelease: pending } : {};
}

/** The result fields describing `plan`; the Spec check runs again on every call, as a Spec's Tickets may have closed in between. */
async function describePlan(plan: ReleasePlan, graphql: GraphqlRunner | undefined): Promise<ReleaseSummary> {
  const summary: ReleaseSummary = { integrationBranch: plan.integrationBranch, releaseBranch: plan.releaseBranch, remote: plan.remote,
    base: plan.base, candidate: plan.candidate, commits: plan.commits.length, migrationArtifacts: plan.migrationArtifacts,
    checks: plan.checks.map((check) => [check.executable, ...check.args].join(" ")) };
  if (!plan.commits.length) return summary;
  const remotes = await jjRun(plan.root, ["git", "remote", "list"]);
  summary.halfBuiltSpecs = await halfBuiltSpecs(remotes.code === 0 ? githubRepository(remotes.stdout, plan.remote) : null,
    plan.commits.map((commit) => commit.description), { graphql });
  return summary;
}

async function releaseIntegrationUnmeasured(cwd: string, { confirm, migrationsReady = false, onProgress = () => {}, graphql }: ReleaseOptions = {}, onVerified: (verifyMs: number) => void = () => {}): Promise<ReleaseResult> {
  try {
    const plan = await planRelease(cwd, confirm === undefined ? {} : { candidate: confirm });
    if (!plan.commits.length) {
      // A confirm of a released candidate retries a post-release step that did not complete.
      const retried = confirm === undefined ? await pendingPostReleaseField(plan)
        : await runPostReleaseStep(plan, async () => (await shippedBy(plan)).merge, onProgress, { onlyIfPending: true });
      return { ok: true, status: "up_to_date", ...await describePlan(plan, graphql), ...retried };
    }
    const summary = await describePlan(plan, graphql);
    if (confirm === undefined) {
      return { ok: true, status: "planned", ...summary, ...await pendingPostReleaseField(plan), subjects: plan.commits.map((commit) => commit.subject),
        next: `After explicit human approval: slipjay release --confirm ${plan.candidate.slice(0, 12)}`
          + (plan.migrationArtifacts.length ? " --migrations-ready (once these migrations are applied where the release deploys)" : "") };
    }
    const requireMigrationsReady = (current: ReleasePlan): void => {
      if (current.migrationArtifacts.length && !migrationsReady) {
        refuse(`This release carries migration artifacts (${current.migrationArtifacts.join(", ")}). Apply them where ${current.releaseBranch} deploys, then rerun with --migrations-ready.`);
      }
    };
    requireMigrationsReady(plan);
    // What the release branch already holds needs no slot and no verification; null when it lacks the candidate.
    const alreadyShipped = async (current: ReleasePlan): Promise<ShippedOutcome | null> =>
      current.commits.length ? null : { summary: await describePlan(current, graphql), ...await shippedBy(current) };
    const inSlot = async (): Promise<ShippedOutcome | VerifiedOutcome> => {
      // A release that waited finds the release branch moved by the one it waited for: plan again against it.
      await fetch(plan.root, plan.remote, plan.releaseBranch);
      const moved = await commitOf(plan.root, `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`) !== plan.base;
      const current = moved ? await planRelease(cwd, { candidate: plan.candidate }) : plan;
      const shippedOutcome = await alreadyShipped(current);
      if (shippedOutcome) return shippedOutcome;
      const described = moved ? await describePlan(current, graphql) : summary;
      requireMigrationsReady(current);
      const verifyStarted = Date.now();
      const verification = await verifyCandidate(current, onProgress).finally(() => onVerified(Date.now() - verifyStarted));
      // The base must still be what was planned: a moved release branch needs a new plan.
      await fetch(current.root, current.remote, current.releaseBranch);
      const base = await commitOf(current.root, `${symbol(current.releaseBranch)}@${symbol(current.remote)}`);
      if (base !== current.base) refuse(`${current.releaseBranch}@${current.remote} moved during the release; rerun it`);
      const merge = await buildMerge(current);
      await publish(current, merge);
      return { summary: described, merge, verification };
    };
    let outcome: ShippedOutcome | VerifiedOutcome | null = null;
    // A release that stood aside because its candidate shipped confirms that against a fresh plan.
    while (!outcome) outcome = await holdReleaseSlot(plan, onProgress, inSlot) ?? await alreadyShipped(await planRelease(cwd, { candidate: plan.candidate }));
    if ("releasedBy" in outcome) {
      onProgress(`[release] ${plan.candidate.slice(0, 12)} is already on ${plan.releaseBranch}`
        + (outcome.releasedBy ? `, released by ${outcome.releasedBy.slice(0, 12)}` : ""));
      return { ok: true, status: "released_by", ...outcome.summary, merge: outcome.merge, releasedBy: outcome.releasedBy,
        ...await runPostReleaseStep(plan, async () => outcome!.merge, onProgress, { onlyIfPending: true }) };
    }
    const record = { ...outcome.summary, merge: outcome.merge, verification: outcome.verification, releasedAt: new Date().toISOString() };
    await mkdir(releaseHome(), { recursive: true });
    await writeFile(join(releaseHome(), `${record.releasedAt.replace(/[:.]/g, "-")}-${plan.candidate.slice(0, 12)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true, status: "released", ...record, ...await runPostReleaseStep(plan, async () => outcome!.merge, onProgress, { onlyIfPending: false }) };
  } catch (error) {
    if (error instanceof ReleaseRefusal) return { ok: false, status: "refused", reason: error.message };
    if ((error as { name?: string } | null | undefined)?.name === "RequiredVerificationError") return { ok: false, status: "verification_failed", reason: (error as { message: string }).message, evidence: (error as { evidence: unknown }).evidence };
    throw error;
  }
}
