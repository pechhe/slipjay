/**
 * `slipjay release`: promote the published integration branch to the release
 * branch its committed policy declares. `releaseIntegration` only plans, on the
 * author's machine: it names the candidate (the integration branch on the
 * remote), the base (the release branch on the remote), the commits between them,
 * any migration artifacts and any half-built Specs (warned about, never refused).
 *
 * `confirmRelease` runs on the runner, in its warm checkout, for the candidate
 * commit a human approved: it checks that exact commit out, runs
 * `requiredReleaseVerification`, builds the release merge, refuses unless its tree
 * is the verified tree, and publishes it. Once it has published, it runs the
 * candidate's declared `postRelease` step (see `post-release.ts`), whose failure is
 * reported in the result without undoing the release. The runner's serial queue
 * orders releases against each other and against landings.
 *
 * jj commands ignore working copies, except checking the candidate out.
 */
import { readExecutionPolicyAtCommit } from "./execution-policy.ts";
import { githubRepository } from "./issue-references.ts";
import { postReleaseRetry, runPostRelease } from "./post-release.ts";
import { halfBuiltSpecs } from "./release-specs.ts";
import { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.ts";
import { jj, run, workspaceContext } from "./workspace-jj.ts";

import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { GraphqlRunner, HalfBuiltSpecs } from "./release-specs.ts";
import type { RunnerStage } from "./runner-contract.ts";
import type { VerificationDeclaration } from "./verification-policy.ts";
import type { WorkspaceCommandResult } from "./workspace-command.ts";

export type ReleasePlan = {
  root: string;
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

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary)
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary & PostReleaseField)
  /**
   * The release branch already contains the candidate (an earlier or newer
   * release shipped it), so the confirm verified nothing; it reruns a post-release
   * step that did not complete. `merge` is the release merge that first contained
   * it and `releasedBy` that merge's candidate. Without such a merge (the branch
   * was moved outside `slipjay release`), `merge` is the release branch head and
   * `releasedBy` null. The summary describes the plan against that head, so
   * `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary & PostReleaseField)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: RequiredVerificationError["evidence"] };

export type ConfirmReleaseOptions = {
  /** The full candidate commit id a human approved. */
  candidate: string;
  /** Acknowledges that the release's migration artifacts are already applied where it deploys. */
  migrationsReady?: boolean;
  onProgress?: (line: string) => void;
  onStage?: (stage: Extract<RunnerStage, "installing" | "verifying" | "publishing" | "finalizing">) => void;
  /** Where each verification command runs (the runner's executor). */
  run?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  environment?: () => NodeJS.ProcessEnv;
  graphql?: GraphqlRunner;
};

const COMMIT_PREFIX = /^[a-f0-9]{12,64}$/;
const CANDIDATE_TRAILER = "Release-Candidate: ";

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
  return { root, remote, integrationBranch, releaseBranch, base, candidate, commits, migrationArtifacts, checks };
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
 * Run the declared post-release step for a published release. Whatever goes wrong,
 * the release stands: a failure, even one before the step starts, becomes a
 * reported `postRelease` outcome with its retry command.
 */
async function runPostReleaseStep(plan: ReleasePlan, merge: string, onProgress: (line: string) => void,
  { onlyIfPending, environment }: { onlyIfPending: boolean; environment?: () => NodeJS.ProcessEnv }): Promise<PostReleaseField> {
  try {
    const outcome = await runPostRelease({ root: plan.root, integrationBranch: plan.integrationBranch, candidate: plan.candidate,
      merge, onlyIfPending, onProgress, ...(environment ? { environment } : {}) });
    if (outcome && !outcome.ok) onProgress(`[release] post-release step failed: ${outcome.reason}. Retry with \`${outcome.retry}\`.`);
    return outcome ? { postRelease: outcome } : {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const retry = postReleaseRetry(plan.candidate);
    onProgress(`[release] post-release step failed: ${reason}. Retry with \`${retry}\`.`);
    return { postRelease: { ok: false, status: "failed", candidate: plan.candidate, merge, reason, retry } };
  }
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

/** Refuse a release carrying migration artifacts that its approver has not marked as applied. */
function requireMigrationsReady(plan: ReleasePlan, migrationsReady: boolean): void {
  if (plan.migrationArtifacts.length && !migrationsReady) {
    refuse(`This release carries migration artifacts (${plan.migrationArtifacts.join(", ")}). Apply them where ${plan.releaseBranch} deploys, then rerun with --migrations-ready.`);
  }
}

const refusalOf = (error: unknown): ReleaseResult => {
  if (error instanceof ReleaseRefusal) return { ok: false, status: "refused", reason: error.message };
  if (error instanceof RequiredVerificationError) return { ok: false, status: "verification_failed", reason: error.message, evidence: error.evidence };
  throw error;
};

/** Plan a release of the integration branch on the remote; publishes nothing. */
export async function releaseIntegration(cwd = process.cwd(), { graphql }: { graphql?: GraphqlRunner } = {}): Promise<ReleaseResult> {
  try {
    const plan = await planRelease(cwd);
    const summary = await describePlan(plan, graphql);
    if (!plan.commits.length) return { ok: true, status: "up_to_date", ...summary };
    return { ok: true, status: "planned", ...summary, subjects: plan.commits.map((commit) => commit.subject),
      next: `After explicit human approval: slipjay release --confirm ${plan.candidate.slice(0, 12)}`
        + (plan.migrationArtifacts.length ? " --migrations-ready (once these migrations are applied where the release deploys)" : "") };
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * On the author's machine, before a confirm goes to the runner: the full id of the
 * approved candidate, or the refusal the runner would return for it.
 */
export async function confirmableCandidate(cwd: string, confirm: string, migrationsReady: boolean): Promise<{ ok: true; status: "confirmable"; candidate: string; remote: string } | ReleaseResult> {
  try {
    const plan = await planRelease(cwd, { candidate: confirm });
    if (plan.commits.length) requireMigrationsReady(plan, migrationsReady);
    return { ok: true, status: "confirmable", candidate: plan.candidate, remote: plan.remote };
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * Refuse unless `checkout` still holds exactly the candidate's tree: the release
 * publishes the candidate, so checks that passed against edited source verified
 * something else. The edits are undone so the next confirm starts clean.
 */
async function requireCandidateTree(checkout: string, candidate: string): Promise<void> {
  const drift = await jj(checkout, ["diff", "--from", candidate, "--to", "@", "--summary"]);
  if (!drift) return;
  await jj(checkout, ["restore", "--from", candidate, "--into", "@"]);
  refuse(`Dependency preparation or release verification changed the candidate's source, so the verified tree is not the one a release would publish; nothing was published. Fix what edits it and confirm again:\n${drift}`);
}

/**
 * Verify and publish the approved `candidate` from `checkout`, which this call owns
 * for its duration (the runner's warm checkout: it checks the candidate out there).
 * A candidate the release branch already holds verifies nothing and only reruns a
 * post-release step that did not complete.
 */
export async function confirmRelease(checkout: string, options: ConfirmReleaseOptions): Promise<ReleaseResult> {
  const { candidate, migrationsReady = false, onProgress = () => {}, onStage = () => {}, run: runCommand, environment, graphql } = options;
  try {
    const plan = await planRelease(checkout, { candidate });
    if (!plan.commits.length) {
      const { merge, releasedBy } = await shippedBy(plan);
      onProgress(`[release] ${plan.candidate.slice(0, 12)} is already on ${plan.releaseBranch}`
        + (releasedBy ? `, released by ${releasedBy.slice(0, 12)}` : ""));
      onStage("finalizing");
      return { ok: true, status: "released_by", ...await describePlan(plan, graphql), merge, releasedBy,
        ...await runPostReleaseStep(plan, merge, onProgress, { onlyIfPending: true, environment }) };
    }
    requireMigrationsReady(plan, migrationsReady);
    const summary = await describePlan(plan, graphql);
    onStage("installing");
    await jj(checkout, ["new", plan.candidate]);
    await prepareWorkspaceDependencies(checkout, { quiet: true, ...(environment ? { env: environment() } : {}) });
    onStage("verifying");
    const verification = plan.checks.length
      ? await runRequiredVerification({ checks: plan.checks, root: checkout, onProgress,
        ...(environment ? { environment } : {}), ...(runCommand ? { run: runCommand } : {}) })
      : { passed: [], gaps: [] };
    await requireCandidateTree(checkout, plan.candidate);
    onStage("publishing");
    // The base must still be what was planned: a moved release branch needs a new plan.
    await fetch(plan.root, plan.remote, plan.releaseBranch);
    const base = await commitOf(plan.root, `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`);
    if (base !== plan.base) refuse(`${plan.releaseBranch}@${plan.remote} moved during the release; rerun it`);
    const merge = await buildMerge(plan);
    await publish(plan, merge);
    onStage("finalizing");
    return { ok: true, status: "released", ...summary, merge, verification, releasedAt: new Date().toISOString(),
      ...await runPostReleaseStep(plan, merge, onProgress, { onlyIfPending: false, environment }) };
  } catch (error) {
    return refusalOf(error);
  }
}
