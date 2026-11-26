import { githubRepository } from "../build/issue-references.ts";
import { jj, workspaceContext } from "../infra/workspace-jj.ts";
import { publicationRemote } from "../landing/landing-remote.ts";
import { promotionRefusal } from "../release/audit-ledger.ts";
import type { AuditSummary } from "../release/audit-ledger.ts";
import type { PromotionState } from "../release/release.ts";
import { connectRunner } from "./runner-client.ts";
import { request, runnerToken } from "./runner-transport.ts";
import type { DeployOperation, ReleaseOperation, VerificationOperation } from "./runner-types.ts";

/**
 * For a promotion plan: what the runner knows of staging, earlier approvals, audits and the pre-verifications of `commits`
 * (ids or prefixes), in one request. A runner without `/v1/promotion` is read from its four lists instead.
 */
export async function readPromotionState(cwd: string, options: { location: string; commits?: string[]; env?: NodeJS.ProcessEnv }): Promise<PromotionState> {
  const env = options.env ?? process.env;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  const repo = githubRepository(await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]), publicationRemote(context) ?? "origin");
  if (!repo) throw new Error("Runner promotions require a GitHub repository on the publication remote");
  const token = await runnerToken(env);
  const connection = await connectRunner(options.location, { ...env, SLIPJAY_RUNNER_TOKEN: token });
  const missing = (error: unknown): boolean => error instanceof Error && /HTTP 404$/.test(error.message);
  try {
    const query = new URLSearchParams({ repo });
    for (const commit of options.commits ?? []) query.append("commit", commit);
    try {
      return (await (await request(connection.baseUrl, token, `/v1/promotion?${query}`)).json()) as PromotionState;
    } catch (error) { if (!missing(error)) throw error; }
    const read = async <T>(route: string, query: Record<string, string>): Promise<T[]> =>
      ((await (await request(connection.baseUrl, token, `${route}?${new URLSearchParams({ repo, ...query })}`)).json()) as { operations: T[] }).operations;
    const staging = await read<DeployOperation>("/v1/deploys", { environment: "staging" });
    const releases = await read<ReleaseOperation>("/v1/releases", {});
    // A runner from before pre-verification has no such route: it has pre-verified nothing.
    const verifications = await read<VerificationOperation>("/v1/verifications", {})
      .catch((error: unknown) => { if (missing(error)) return []; throw error; });
    // A runner from before audits has no such route: it refuses nothing on their account.
    const audits = await request(connection.baseUrl, token, `/v1/audits?${new URLSearchParams({ repo })}`)
      .then(async (response) => ((await response.json()) as { summary: AuditSummary }).summary)
      .catch((error: unknown) => { if (missing(error)) return null; throw error; });
    return {
      verifications,
      ...audits ? { auditRefusal: promotionRefusal(audits) } : {},
      stagingGreen: staging.find((operation) => operation.result?.type === "deployed")?.commitId ?? null,
      stagingGreenCommits: [...new Set(staging.filter((operation) => operation.result?.type === "deployed").map((operation) => operation.commitId))],
      approved: releases.filter((operation) => operation.status !== "cancelled" && operation.status !== "superseded").map((operation) => operation.commitId),
    };
  } finally { connection.close(); }
}
