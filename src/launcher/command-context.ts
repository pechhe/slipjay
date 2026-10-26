import { workspaceContext } from "../lib/slipjay.ts";

/** The repository's integration checkout, even when `cwd` is inside one of its workspaces. */
export async function integrationRoot(cwd: string): Promise<string> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  return context.integration.root;
}

