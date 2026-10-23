import { releaseProject } from "../../support/release-project.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseIntegration } from "../../../src/lib/release/release.ts";
import type { OperationEvent, VerificationOperation } from "../../../src/lib/runner/runner-contract.ts";

/** A promoting fixture that also declares production migrations, with a commit helper that writes straight to main. */
export async function promotingProject() {
  const f = await releaseProject({ migrations: true, promotes: true });
  const commit = f.commit;
  const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
  const step = { executable: "node", args: ["-e", ""] };
  policy.deployments.environments.production.migrations = { verify: step, apply: step };
  await commit({ "slipjay.json": JSON.stringify(policy) }, "Declare production migrations");
  const plan = (stagingGreen: string, approved: string[], verifications: VerificationOperation[] = []) =>
    releaseIntegration(f.repo, { readPromotion: async () => ({ stagingGreen, approved, verifications }) });
  return { ...f, commit, plan, checks: policy.requiredReleaseVerification as unknown[] };
}

export const verificationOf = (commitId: string, status: VerificationOperation["status"], result?: OperationEvent): VerificationOperation =>
  ({ id: `op_${status}_${commitId.slice(0, 6)}`, kind: "verification", repo: "fixture/repo", commitId, submittedBy: "runner:staging", status,
    stage: status === "running" ? "verifying" : "queued", submittedAt: new Date().toISOString(), runs: [], lastSeq: 1,
    ...result ? { result: result as VerificationOperation["result"] } : {} });
