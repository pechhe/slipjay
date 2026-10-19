import { sanitizedHandoff, validSubmissionHandoff, handoffDigest } from "./submission-handoff.ts";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { landingCommandEnvironment, runWorkspaceCommand } from "../infra/workspace-command.ts";
import { jj } from "../infra/workspace-jj.ts";
import { repositoryKey } from "../runner/runner-contract.ts";
import type { Executor, OperationEvent, SubmitRequest } from "../runner/runner-contract.ts";

export type RetainedSubmission = Extract<OperationEvent, { type: "source_retained" }>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const submissionSourceRef = (operationId: string) => `refs/slipjay/submissions/${digest(operationId)}`;
export const submissionStorePath = (home: string, repo: string) => join(home, "sources", `${digest(repositoryKey(repo))}.git`);
const manifestPath = (home: string, operationId: string) => join(home, "submissions", `${digest(operationId)}.json`);

/** Capture touches only a bare Git object store, never a publisher or verifier checkout. */
export async function retainSubmissionSource(input: {
  home: string; operationId: string; request: SubmitRequest; url: string; executor: Executor; env?: NodeJS.ProcessEnv; gitExecutable?: string;
}): Promise<RetainedSubmission> {
  const { home, operationId, request, executor } = input;
  if (!/^[a-f0-9]{40}$/.test(request.commitId)) throw new Error("Submission retention requires an exact commit id");
  if (request.handoff && (!validSubmissionHandoff(request.handoff) || request.handoff.source !== request.commitId)) throw new Error("Invalid handoff or source mismatch");
  const store = submissionStorePath(home, request.repo);
  await mkdir(join(home, "sources"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "submissions"), { recursive: true, mode: 0o700 });
  const command = async (executable: string, args: string[]) => {
    const result = await executor.run({ executable, args, cwd: home,
      env: landingCommandEnvironment(input.env), timeoutMs: 120_000, maxOutputBytes: 16_384, maxOutputBytesPerStream: 8192 });
    // Remote output/URLs may contain credentials; failure diagnostics never echo them here.
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled)
      throw new Error("Runner could not retain the exact submitted source; no durable submission was acknowledged");
    return result.stdout.trim();
  };
  const gitExecutable = input.gitExecutable ?? await command("jj", ["config", "get", "git.executable-path"]);
  const run = (args: string[]) => command(gitExecutable, args);
  await run(["init", "--bare", store]);
  const ref = submissionSourceRef(operationId);
  const existing = await run(["--git-dir", store, "for-each-ref", "--format=%(objectname)", ref]);
  if (existing && existing !== request.commitId) throw new Error("Retained submission identity changed");
  if (!existing) {
    // Fetch into objects only. Check identity before installing an immutable operation ref.
    await run(["--git-dir", store, "fetch", "--no-tags", input.url, `refs/heads/${request.bookmark}`]);
    if (await run(["--git-dir", store, "rev-parse", "FETCH_HEAD^{commit}"]) !== request.commitId)
      throw new Error("Submission bookmark differs from the exact requested source");
    await run(["--git-dir", store, "update-ref", ref, request.commitId, "0".repeat(40)]);
  }
  const manifest = JSON.stringify({ version: 1, operationId, repo: repositoryKey(request.repo), source: request.commitId,
    changeId: request.changeId, requestId: request.requestId ?? null, submittedBy: request.submittedBy,
    identity: request.identity ?? null,
    ...(request.repair ? { repair: { operationId: request.repair.operationId, claimId: request.repair.claimId } } : {}),
    ...(request.handoff ? { handoff: { ...sanitizedHandoff(request.handoff, input.env ?? process.env), authority: "author-reported", inputSha256: handoffDigest(request.handoff) } } : {}),
    gaps: [...request.handoff ? [] : ["Spec revision/snapshot and intent not supplied", "Helper, focused-check and independent-review evidence not supplied"]],
    retention: "Runner retention policy: kept while open, unconfirmed or under a repair claim; deleted 14 days after its change published, otherwise 30 days after its outcome" });
  if (Buffer.byteLength(manifest) > 131072) throw new Error("Sanitized submission manifest exceeds retention capacity");
  const path = manifestPath(home, operationId);
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (previous !== null && previous !== manifest) throw new Error("Retained submission manifest changed");
  if (previous === null) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(manifest); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== manifest) throw error;
      }
    } finally { await rm(temporary, { force: true }); }
  }
  for (const directory of [join(home, "submissions"), home]) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return { type: "source_retained", commitId: request.commitId, manifestSha256: digest(manifest), sourceRef: ref, handoffComplete: false };
}

/** Restore from runner-owned objects even after the upstream candidate or warm checkout disappears. */
export async function importSubmissionSource(home: string, repo: string, operationId: string, retained: RetainedSubmission, checkout: string): Promise<void> {
  await readSubmissionManifest(home, repo, operationId, retained);
  const gitRoot = await jj(checkout, ["--ignore-working-copy", "git", "root"]);
  const name = `refs/heads/slipjay-private/artifacts/submission-${digest(operationId)}`;
  const result = await runWorkspaceCommand("git", ["--git-dir", gitRoot, "fetch", "--no-tags", "--no-write-fetch-head", submissionStorePath(home, repo), `${retained.sourceRef}:${name}`], { cwd: checkout });
  if (result.code !== 0) throw new Error("Could not restore retained submission source");
  await jj(checkout, ["git", "import"]);
  const observed = await jj(checkout, ["log", "-r", name.slice("refs/heads/".length), "--no-graph", "-T", "commit_id"]);
  if (observed !== retained.commitId) throw new Error("Restored submission differs from retained source");
}

/** Ledger hash binds retrieval to the retained operation, including its immutable source. */
export async function readSubmissionManifest(home: string, repo: string, operationId: string, retained: RetainedSubmission): Promise<unknown> {
  const bytes = await readFile(manifestPath(home, operationId), "utf8");
  const manifest = JSON.parse(bytes);
  if (digest(bytes) !== retained.manifestSha256 || manifest.source !== retained.commitId || manifest.operationId !== operationId
    || manifest.repo !== repositoryKey(repo) || retained.sourceRef !== submissionSourceRef(operationId)) throw new Error("Retained submission manifest does not match ledger evidence");
  return manifest;
}
