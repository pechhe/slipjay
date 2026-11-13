import { acquireExistingWorkspaceClaim } from "../lib/workspace/workspace-claim-service.ts";
import { releaseWorkspaceClaim, markWorkspaceClaimRecovery, transferWorkspaceClaim, workspaceClaimStatus, WorkspaceClaimError } from "../lib/workspace/workspace-claims.ts";
import { claimController } from "../lib/workspace/workspace-claim-identity.ts";
import { activateWorkspaceClaims, requireWorkspaceClaimActivation, workspaceClaimCapability } from "../lib/workspace/workspace-claim-activation.ts";

/** Credentials are accepted only on stdin; errors never echo request content. */
export async function readClaimInput(): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); length += buffer.length;
    if (length > 64 * 1024) throw new WorkspaceClaimError("CLAIM_REQUEST_INVALID", "Claim request exceeds 64 KiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WorkspaceClaimError("CLAIM_REQUEST_INVALID", "Claim request must be JSON on stdin"); }
}
export async function runClaims(args: string[]): Promise<void> {
  const [action, path, ...extra] = args;
  try {
    if (extra.length) throw new WorkspaceClaimError("CLAIM_REQUEST_INVALID", "Usage: slipjay claims capability|activate|controller [pid]|acquire|release|transfer|recover|status <path>");
    let result: unknown;
    if (action === "capability" && !path) result = workspaceClaimCapability();
    else if (action === "activate" && !path) result = await activateWorkspaceClaims();
    else if (action === "controller") result = { version: 1, controller: await claimController(path ? Number(path) : process.ppid) };
    else if (action === "status" && path) result = await workspaceClaimStatus(path);
    else if (path && ["acquire", "release", "transfer", "recover"].includes(action ?? "")) {
      const input = await readClaimInput() as Parameters<typeof acquireExistingWorkspaceClaim>[1] & Parameters<typeof releaseWorkspaceClaim>[1]
        & { reason: string; next: Parameters<typeof transferWorkspaceClaim>[2] };
      if (!input || typeof input !== "object") throw new WorkspaceClaimError("CLAIM_REQUEST_INVALID", "Claim JSON object required");
      await requireWorkspaceClaimActivation(input.activationId);
      result = action === "acquire" ? await acquireExistingWorkspaceClaim(path, input)
        : action === "release" ? await releaseWorkspaceClaim(path, input)
        : action === "recover" ? await markWorkspaceClaimRecovery(path, input)
        : await transferWorkspaceClaim(path, input, input.next);
    } else throw new WorkspaceClaimError("CLAIM_REQUEST_INVALID", "Invalid claims command");
    console.log(JSON.stringify({ ok: true, ...result as object }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error instanceof WorkspaceClaimError ? error.code : "CLAIM_OPERATION_FAILED",
      reason: error instanceof WorkspaceClaimError ? error.message : "Claim operation failed; custody remains retained" }));
    process.exitCode = 1;
  }
}
