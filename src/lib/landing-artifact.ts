import { createHash } from "node:crypto";
import { jj, revisionFacts } from "./workspace-jj.ts";
import { runWorkspaceCommand } from "./workspace-command.ts";

/** A private, immutable attempt artifact; never an upstream submission bookmark. */
export type LandingArtifact = {
  operationId: string;
  attempt: number;
  source: string;
  base: string;
  candidate: string;
};

/** Local heads are required for JJ import; custom Git namespaces are not JJ-visible. */
export function artifactBookmark(artifact: LandingArtifact): string {
  if (!Number.isSafeInteger(artifact.attempt) || artifact.attempt < 1) throw new Error("Invalid landing attempt");
  for (const revision of [artifact.source, artifact.base, artifact.candidate])
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Landing artifacts require exact commit ids");
  if (!artifact.operationId) throw new Error("Landing artifacts require an operation id");
  // The same attempt cannot acquire a new candidate by changing its ref name.
  return `slipjay-private/artifacts/${createHash("sha256").update(JSON.stringify([artifact.operationId, artifact.attempt])).digest("hex")}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const root = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
  const result = await runWorkspaceCommand("git", ["--git-dir", root, ...args], { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Artifact transport failed");
  return result.stdout.trim();
}

async function assertArtifact(cwd: string, artifact: LandingArtifact): Promise<void> {
  artifactBookmark(artifact);
  const parents = await git(cwd, ["show", "-s", "--format=%P", artifact.candidate]);
  // A prefix extends exactly one frozen predecessor, rather than a rewritten stack.
  if (parents !== artifact.base) throw new Error(`Landing artifact does not extend its exact expected base: expected ${artifact.base}, observed ${parents}`);
}

/** Pin author evidence as soon as it is fetched, including attempts that fail preparation. */
export async function retainLandingSource(cwd: string, operationId: string, attempt: number, source: string): Promise<void> {
  const name = `${artifactBookmark({ operationId, attempt, source, base: source, candidate: source })}-source`;
  for (const ref of [`refs/slipjay/${name}`, `refs/heads/${name}`]) {
    const existing = await git(cwd, ["for-each-ref", "--format=%(objectname)", ref]);
    if (existing && existing !== source) throw new Error("Retained landing source was changed");
    if (!existing) await git(cwd, ["update-ref", ref, source, "0".repeat(40)]);
  }
  await jj(cwd, ["git", "import"]);
}

/** Retain the artifact independently of working-copy changes and slot reuse. */
export async function retainLandingArtifact(cwd: string, artifact: LandingArtifact): Promise<void> {
  await assertArtifact(cwd, artifact);
  const bookmark = artifactBookmark(artifact);
  for (const [name, commit] of [[bookmark, artifact.candidate], [`${bookmark}-source`, artifact.source]]) {
    // Custom refs remain pinned even if JJ rewrites a visible bookmark after a bad gate.
    for (const ref of [`refs/slipjay/${name}`, `refs/heads/${name}`]) {
      const existing = await git(cwd, ["for-each-ref", "--format=%(objectname)", ref]);
      if (existing && existing !== commit) throw new Error("Retained landing artifact was changed");
      if (!existing) await git(cwd, ["update-ref", ref, commit!, "0".repeat(40)]);
    }
  }
  await jj(cwd, ["git", "import"]);
  if ((await revisionFacts(cwd, bookmark)).commitId !== artifact.candidate) throw new Error("Retained landing artifact identity differs");
}

/** Duplicate source into a fresh change before rebasing; never rewrite a retained attempt. */
export async function duplicateLandingSource(cwd: string, source: string, base: string): Promise<string> {
  const before = await jj(cwd, ["op", "log", "--limit", "1", "--no-graph", "-T", "id"]);
  // Copy the entire submitted stack; duplicating only its head could omit a helper's work.
  await jj(cwd, ["duplicate", "-r", `${base}..${source}`, "--onto", base]);
  const created = `all() ~ at_operation(${before}, all())`;
  const head = await jj(cwd, ["log", "-r", `heads(${created})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Source duplication did not produce exactly one candidate head");
  const ancestors = await jj(cwd, ["log", "-r", `(${base}..${head}) ~ ${head}`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
  let candidate = head;
  if (ancestors) {
    const beforeSquash = await jj(cwd, ["op", "log", "--limit", "1", "--no-graph", "-T", "id"]);
    // First-parent order keeps the feature title above its review fixes, without
    // treating merged-in upstream history as the feature's description.
    const description = await jj(cwd, ["log", "-r", `(${base}..${source}) & first_ancestors(${source})`, "--reversed", "--no-graph", "-T", 'description ++ "\\n"']);
    await jj(cwd, ["squash", "--from", `${base}..${head}`, "--onto", base, "--message", description]);
    candidate = await jj(cwd, ["log", "-r", `heads(all() ~ at_operation(${beforeSquash}, all()))`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
    if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error("Source assembly did not produce exactly one candidate");
  }
  await jj(cwd, ["edit", candidate]);
  return candidate;
}

/** Import and pin before the producer can release its copy. No upstream remote is involved. */
export async function importLandingArtifact(cwd: string, producer: string, artifact: LandingArtifact): Promise<void> {
  const bookmark = artifactBookmark(artifact);
  const producerRoot = await jj(producer, ["--ignore-working-copy", "git", "root"]);
  const assertProducer = async () => {
    for (const [name, commit] of [[bookmark, artifact.candidate], [`${bookmark}-source`, artifact.source]])
      if (await git(producer, ["rev-parse", `refs/slipjay/${name}`]) !== commit) throw new Error("Producer attempt ref differs from the requested artifact");
  };
  await assertProducer();
  // Fetch into objects only first: never overwrite a consumer's existing attempt ref.
  await git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", producerRoot, `refs/slipjay/${bookmark}`, `refs/slipjay/${bookmark}-source`]);
  await assertProducer();
  await jj(cwd, ["git", "import"]);
  await retainLandingArtifact(cwd, artifact);
}

/** Private evidence must be excluded from broad mutable-candidate housekeeping. */
export const RETAINED_ARTIFACT_REVISIONS = '::bookmarks(glob:"slipjay-private/artifacts/*")';
