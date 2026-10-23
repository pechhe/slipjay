import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { readSubmissionManifest, submissionSourceRef, submissionStorePath } from "./submission-source.ts";
import type { RetainedSubmission } from "./submission-source.ts";
import { jj } from "../infra/workspace-jj.ts";
import { jjEnvironment, landingCommandEnvironment, runWorkspaceCommand } from "../infra/workspace-command.ts";
import type { Executor } from "../runner/runner-types.ts";

export const SOURCE_BUNDLE_MAX_BYTES = 128 * 1024 * 1024;

/** Derived export only: the ledger-bound private Git ref remains the recovery authority. */
export async function submissionSourceResponse(input: {
  home: string; repo: string; operationId: string; retained: RetainedSubmission; executor: Executor;
  env?: NodeJS.ProcessEnv; gitExecutable?: string; signal?: AbortSignal;
}): Promise<Response> {
  const { home, repo, operationId, retained, executor } = input;
  await readSubmissionManifest(home, repo, operationId, retained);
  const path = join(home, "submissions", `${randomUUID()}.bundle.tmp`);
  const remove = () => rm(path, { force: true });
  try {
    const env = landingCommandEnvironment(input.env);
    const run = async (executable: string, args: string[]) => {
      const result = await executor.run({ executable, args, cwd: home, env: executable === "jj" ? jjEnvironment(env) : env,
        timeoutMs: 120000, maxOutputBytes: 16384, abortSignal: input.signal });
      if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled) throw new Error("Source bundle preparation failed");
      return result.stdout.trim();
    };
    const git = input.gitExecutable ?? await run("jj", ["config", "get", "git.executable-path"]);
    // A complete bundle includes ancestry; no warm checkout or bundle prerequisite is required.
    await run(git, ["--git-dir", submissionStorePath(home, repo), "bundle", "create", path, submissionSourceRef(operationId)]);
    if (await run(git, ["bundle", "list-heads", path, submissionSourceRef(operationId)]) !== `${retained.commitId} ${submissionSourceRef(operationId)}`)
      throw new Error("Source bundle does not contain the retained candidate");
    await chmod(path, 0o600);
    const size = (await stat(path)).size;
    if (size < 1 || size > SOURCE_BUNDLE_MAX_BYTES) throw new Error("Source bundle exceeds export capacity");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    input.signal?.throwIfAborted();
    const stream = createReadStream(path, { signal: input.signal });
    stream.once("close", () => { void remove().catch(() => {}); });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
      "content-type": "application/x-git-bundle", "content-length": String(size), "cache-control": "no-store",
      "x-slipjay-source": retained.commitId, "x-slipjay-operation": operationId, "x-slipjay-sha256": hash.digest("hex"),
    } });
  } catch {
    await remove();
    throw new Error("Retained source export is unavailable; retained objects remain unchanged");
  }
}

/** Import only immutable objects into an already assigned checkout; never changes its working revision. */
export async function importSourceBundle(bundle: string, checkout: string, operationId: string, source: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("An exact source revision is required");
  const head = await runWorkspaceCommand("git", ["bundle", "list-heads", bundle, submissionSourceRef(operationId)], { cwd: checkout });
  if (head.code !== 0 || head.stdout.trim() !== `${source} ${submissionSourceRef(operationId)}`) throw new Error("Cannot import a bundle with a different operation or source");
  const root = await jj(checkout, ["--ignore-working-copy", "git", "root"]);
  const reference = submissionSourceRef(operationId);
  const name = `refs/heads/slipjay-private/artifacts/recovered-${createHash("sha256").update(operationId).digest("hex")}`;
  const result = await runWorkspaceCommand("git", ["--git-dir", root, "fetch", "--no-tags", "--no-write-fetch-head", bundle, `${reference}:${name}`], { cwd: checkout });
  if (result.code !== 0) throw new Error("Could not import the retained source bundle");
  await jj(checkout, ["git", "import"]);
  const observed = await jj(checkout, ["--ignore-working-copy", "log", "-r", name.slice(11), "--no-graph", "-T", "commit_id"]);
  if (observed !== source) throw new Error("Imported source differs from the requested candidate");
}
