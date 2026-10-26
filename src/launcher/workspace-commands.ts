import { adoptWorkspace } from "../lib/workspace/workspace-adopt.ts";
import { attachWorkspaceIssue, inspectWorkspaces, readWorkspaceMode, workspaceContext, writeWorkspaceMode, refillPool, readySpares, spareAllowance, describeRetention, retainedWorkspaceMaterial, readLandedRecord, readLandingState } from "../lib/slipjay.ts";
import { workspaceMetadata } from "../lib/workspace/workspace-state.ts";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Disk use of a checkout, for spotting retained workspaces worth reclaiming. */
function diskUsage(root: string): string {
  try { return execFileSync("du", ["-sh", root], { encoding: "utf8", timeout: 60_000 }).split("\t")[0] ?? "?"; }
  catch { return "?"; }
}

export async function runStatus(): Promise<void> {
  const context = await workspaceContext();
  const landing = context && context.current.name !== "default" ? await readLandingState(context.current.name, { readOnly: true }) : null;
  // The Issue attached by `start --issue` or `attach-issue`, for clients that label the workspace.
  const issueNumber = context ? (await workspaceMetadata(context.current.name))?.issueNumber : undefined;
  console.log(context
    ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: { ...context.current, ...(issueNumber ? { issueNumber } : {}) }, integration: context.integration, integrationBranch: context.integrationBranch,
      spares: await spareAllowance(context),
      ...(landing ? { landing: { phase: landing.phase, artifactCommitId: landing.artifactCommitId, ...(landing.primaryCheckout ? { primaryCheckout: landing.primaryCheckout } : {}) } } : {}) }, null, 2)
    : "Not inside a Jujutsu repository");
}

export async function runLanded(rest: string[]): Promise<void> {
  if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error("Usage: slipjay landed <path>");
  console.log(JSON.stringify(await readLandedRecord(resolve(rest[0]!))));
}

export async function runMode(rest: string[]): Promise<void> {
  const requested = rest[0];
  console.log(requested ? await writeWorkspaceMode(requested) : await readWorkspaceMode());
}

export async function runList(): Promise<void> {
  const context = await workspaceContext();
  for (const workspace of await inspectWorkspaces()) {
    const issue = workspace.metadata?.issueNumber ? ` · issue #${workspace.metadata.issueNumber}` : "";
    const state = workspace.name === "default" ? "integration" : workspace.metadata?.spare ? "spare"
      : workspace.hasWork ? "unlanded" : workspace.landed ? "landed" : "empty";
    // Landed checkouts should be gone; say why one is still here and what it costs.
    const paths = state === "landed" && workspace.root && context
      ? await retainedWorkspaceMaterial(workspace.root, context.integration.root).catch(() => [])
      : [];
    const kept = paths.length ? ` · ${diskUsage(workspace.root)} kept: ${describeRetention({ reason: "unique-files", paths })}` : "";
    console.log(`${workspace.name}\t${workspace.root}\t${state}${issue}${kept}`);
  }
}

export async function runPool(rest: string[]): Promise<void> {
  if (rest[0] === "refill") await refillPool(process.cwd(), (outcome) => console.log(JSON.stringify(outcome)));
  else if (rest.length === 0) {
    const spares = await readySpares(process.cwd());
    console.log(spares.length ? spares.map((spare) => `ready\t${spare.name}\t${spare.root}`).join("\n") : "No ready spare workspace.");
  } else throw new Error("Usage: slipjay pool [refill]");
}

export async function runAttachIssue(rest: string[]): Promise<void> {
  const issueNumber = Number(rest[0]);
  const result = await attachWorkspaceIssue(process.cwd(), issueNumber);
  console.log(`Attached Issue #${result.issueNumber} to jj:${result.workspaceName}.`);
}

export async function runAdopt(rest: string[]): Promise<void> {
  const paths = rest.filter((arg) => arg !== "--json");
  if (paths.length !== 1 || paths[0]!.startsWith("-")) throw new Error("Usage: slipjay adopt <path> [--json]");
  const result = await adoptWorkspace(process.cwd(), resolve(paths[0]!));
  console.log(rest.includes("--json") ? JSON.stringify(result) : `Adopted ${result.revisions.length} revision(s) from jj:${result.workspaceName}`);
}
