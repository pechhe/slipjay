/** Build's acceptance decision for the exact commits a release would publish. */
import type { BuildReader } from "../build/tracker.ts";
import { githubRepository } from "../build/issue-references.ts";
import { readExecutionPolicyAtCommit } from "../policy/execution-policy.ts";
import { jj, run } from "../infra/workspace-jj.ts";

export type BuildReleasePlan = {
  repository: string;
  commits: { commitId: string; kind: "spec" | "chore" | "unclassified"; specId: string | null; number: number | null }[];
  specs: { specId: string; number: number; title: string; status: string; level: "agent" | "owner" | null;
    state: "accepted" | "gated" | "reverted" | "held";
    heldReason: "not_accepted" | "publication_not_accepted" | "gate_not_declared" | "gate_partial" | null; commitIds: string[] }[];
  releasable: boolean;
};

/** Literal declarations only; comments and quoted examples never declare a gate. */
export function declaredSpecGates(source: string): number[] {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[a-z]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+|[^\s]/g) ?? [];
  const code = tokens.filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const gates = new Set<number>();
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] !== "defineSpecGate" || code[index + 1] !== "(" || code[index - 1] === ".") continue;
    const value = code[index + 2]!;
    if (!/^\d+$/.test(value) || code[index + 3] !== ")" || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
      throw new Error("specGateDeclarations must use defineSpecGate with one positive integer literal");
    gates.add(Number(value));
  }
  if (gates.size > 500) throw new Error("specGateDeclarations exceeds Build's 500-gate limit");
  return [...gates].sort((a, b) => a - b);
}

/**
 * The candidate a genuine SlipJay release merge published: two parents, the release message, its
 * trailer naming the second parent, and exactly that parent's tree. Anything else is null, so a
 * merge that only copies the message still needs classification.
 */
export async function releaseMergeCandidate(root: string, commit: { commitId: string; parents: string[]; description: string }): Promise<string | null> {
  const candidate = /^Release .+ to .+\n\nRelease-Candidate: ([a-f0-9]{40,64})\n?$/.exec(commit.description)?.[1];
  if (!candidate || commit.parents.length !== 2 || commit.parents[1] !== candidate) return null;
  const differs = await jj(root, ["--ignore-working-copy", "diff", "--from", candidate, "--to", commit.commitId, "--name-only"]);
  return differs.trim() ? null : candidate;
}

/** Candidate ancestors absent from the release head, excluding SlipJay's own release merges. */
export async function buildReleaseCommits(root: string, candidate: string, base: string): Promise<{ commitId: string; revertsCommitId: string | null }[]> {
  const rows = await jj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", `::${candidate} ~ ::${base}`,
    "-T", 'commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ description.escape_json() ++ "\\n"']);
  const commits: { commitId: string; parents: string[]; description: string }[] = [];
  for (const row of rows.split("\n").filter(Boolean)) {
    const [commitId, parents, description] = row.split("\t");
    const commit = { commitId: commitId!, parents: parents!.split(",").filter(Boolean), description: JSON.parse(description!) as string };
    if (!await releaseMergeCandidate(root, commit)) commits.push(commit);
  }
  if (commits.length > 2000) throw new Error(`Release range has ${commits.length} commits; Build's release_plan limit is 2000. Nothing can be promoted.`);
  const result: { commitId: string; revertsCommitId: string | null }[] = [];
  for (const { commitId, description } of commits) {
    const reverted = /^This reverts commit ([a-f0-9]{4,64})\.$/m.exec(description)?.[1];
    if (!reverted) { result.push({ commitId, revertsCommitId: null }); continue; }
    const resolved = await run("jj", ["--ignore-working-copy", "log", "--no-graph", "-r", reverted, "-T", 'commit_id ++ "\\n"'], { cwd: root });
    const ids = resolved.code === 0 ? resolved.stdout.trim().split("\n").filter(Boolean) : [];
    result.push({ commitId, revertsCommitId: ids.length === 1 && ids[0]!.startsWith(reverted) ? ids[0]! : null });
  }
  return result;
}

/** Null for GitHub tracking. Every error on the Build path must refuse promotion. */
export async function readBuildReleasePlan(plan: { root: string; candidate: string; base: string; remote: string }, read?: BuildReader): Promise<BuildReleasePlan | null> {
  const { policy } = await readExecutionPolicyAtCommit(plan.root, plan.candidate);
  if (policy?.tracker !== "build") return null;
  if (!read) throw new Error("Build release_plan is unavailable: this release needs a runner with a Build connection");
  const repository = githubRepository(await jj(plan.root, ["--ignore-working-copy", "git", "remote", "list"]), plan.remote);
  if (!repository) throw new Error("Build release_plan requires a repository locator on the publication remote");
  const commits = await buildReleaseCommits(plan.root, plan.candidate, plan.base);
  const declaredGates = policy.specGateDeclarations === undefined ? [] : declaredSpecGates(await jj(plan.root,
    ["--ignore-working-copy", "file", "show", "-r", plan.candidate, "--", `root-file:${JSON.stringify(policy.specGateDeclarations)}`]));
  const value = await read("release_plan", { repository, commits, declaredGates });
  if (!value || typeof value !== "object") throw new Error("Build returned no release_plan");
  const answer = value as BuildReleasePlan;
  if (answer.repository !== repository || typeof answer.releasable !== "boolean" || !Array.isArray(answer.commits) || !Array.isArray(answer.specs)
    || answer.commits.length !== commits.length || new Set(answer.commits.map((commit) => commit.commitId)).size !== commits.length
    || answer.commits.some((commit) => !commits.some((requested) => requested.commitId === commit.commitId) || !["spec", "chore", "unclassified"].includes(commit.kind))
    || answer.specs.some((spec) => !["accepted", "gated", "reverted", "held"].includes(spec.state)
      || (spec.state === "held"
        ? !["not_accepted", "publication_not_accepted", "gate_not_declared", "gate_partial"].includes(spec.heldReason as string)
        : spec.heldReason !== null)))
    throw new Error("Build returned an incomplete or invalid release_plan");
  const specIds = new Set(answer.specs.map((spec) => spec.specId));
  if (specIds.size !== answer.specs.length || answer.specs.some((spec) => typeof spec.specId !== "string" || !Number.isSafeInteger(spec.number)
    || typeof spec.title !== "string" || !Array.isArray(spec.commitIds))
    || answer.commits.some((commit) => commit.kind === "spec" && !answer.specs.some((spec) => spec.specId === commit.specId
      && spec.number === commit.number && spec.commitIds.includes(commit.commitId))))
    throw new Error("Build returned a release_plan missing Spec classification evidence");
  return { ...answer, releasable: answer.releasable && !answer.commits.some((commit) => commit.kind === "unclassified") && !answer.specs.some((spec) => spec.state === "held") };
}

export const releaseSpecLabel = (state: BuildReleasePlan["specs"][number]["state"]): string =>
  ({ accepted: "Accepted", gated: "Hidden in production", reverted: "Reverted", held: "Held back" })[state];

export function requireBuildReleasable(plan: BuildReleasePlan | null): void {
  if (!plan || plan.releasable) return;
  const held = plan.specs.filter((spec) => spec.state === "held").map((spec) => `#${spec.number} ${spec.title}: ${spec.heldReason}`);
  const unclassified = plan.commits.filter((commit) => commit.kind === "unclassified").map((commit) => `unclassified commit ${commit.commitId}`);
  throw new Error(`Build refuses this release: ${[...held, ...unclassified].join("; ") || "release_plan is not releasable"}. Release approval cannot override acceptance.`);
}
