import { workspaceMetadata } from "./workspace-state.ts";
import { workspaceContext } from "../infra/workspace-jj.ts";
import { acquireWorkspaceClaim, WorkspaceClaimError } from "./workspace-claims.ts";
import type { ClaimAcquisition } from "./workspace-claims.ts";
import { requireWorkspaceClaimActivation } from "./workspace-claim-activation.ts";
export type ManagedClaimRequest = ClaimAcquisition & { activationId: string; generation?: string };
/** Host attach/adopt: validates JJ identity. Missing JJ never clears an existing claim. */
export async function acquireExistingWorkspaceClaim(path: string, input: ManagedClaimRequest) {
  await requireWorkspaceClaimActivation(input.activationId);
  const context = await workspaceContext(path);
  if (!context) throw new WorkspaceClaimError("CLAIM_CHECKOUT_UNAVAILABLE", "Checkout identity cannot be established; no unprotected work may start");
  const metadata = await workspaceMetadata(context.current.name);
  if (metadata?.spare === true) throw new WorkspaceClaimError("CLAIM_CHECKOUT_UNAVAILABLE", "Prepared pool spares must be allocated before custody acquisition");
  return acquireWorkspaceClaim(context.current.root, context.integration.root, context.current.name, input, input.generation);
}
