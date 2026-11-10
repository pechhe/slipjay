import { readBuildThroughRunner, runnerLocation } from "../lib/runner/runner-client.ts";
import { hostDisk } from "../lib/host-disk/host-disk.ts";
import type { HostDiskOutcome } from "../lib/host-disk/host-disk.ts";
import { ROUTINE_KEEP } from "../lib/host-disk/disk-plan.ts";

const REPORT_ONLY = new Set(["docker-volume", "loop-image", "unexplained"]);
const USAGE = "Usage: slipjay disk [--plan] [--json]";

/** The reader `prune --empty` uses, so an Issue counts as closed the same way. */
export const diskReadBuild = () => runnerLocation() ? (action: Parameters<typeof readBuildThroughRunner>[0], input: Parameters<typeof readBuildThroughRunner>[1]) => readBuildThroughRunner(action, input) : undefined;

/** The tab-separated lines of a finished pass: what was done, and what was kept with a guard's reason. */
export function diskLines(outcome: Exclude<HostDiskOutcome, { state: "busy" }>, all: boolean): string[] {
  // A healthy host says nothing in the hourly pass.
  const lines = all || outcome.level !== "ok" ? [`disk\t${outcome.level}\t${outcome.usagePercent}%`] : [];
  const quiet = !all && outcome.level === "ok";
  for (const row of outcome.results) {
    // Report-only rows (Docker volumes, loop images, unexplained space) are shown in a plan or on a host past ok.
    if (quiet && REPORT_ONLY.has(row.class)) continue;
    const taken = row.outcome !== "kept";
    if (!all && !taken && (row.action === "keep" && (row.class === "workspace" || ROUTINE_KEEP.test(row.reason)))) continue;
    const mb = (row.sizeBytes / 1024 / 1024).toFixed(1);
    // A row that keeps its class over budget says so, in a plan and in an applying pass.
    const holding = row.keepsOverBudget && outcome.budgets.evidence?.over ? `; holds evidence over budget (${mb} MB)` : "";
    lines.push(`${all ? row.action : row.outcome}\t${row.class}\t${mb} MB\t${row.owner ?? "-"}\t${row.path}\t${row.detail}${holding}`);
  }
  if (!quiet) for (const note of outcome.notes) lines.push(`disk\t${note}`);
  // A class over its budget is one line, after the pass for an applying run: what is still over and, for workspaces, what claimed checkouts hold.
  for (const [name, budget] of Object.entries(outcome.budgets)) {
    if (!budget.over) continue;
    const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    lines.push(`over budget\t${name}\t${mb(budget.usedBytes)} of ${mb(budget.budgetBytes)}${name === "workspaces" ? `\tclaimed workspaces hold ${mb(budget.usedBytes)}` : ""}`);
  }
  if (outcome.rescueEnvError) lines.push(`rescue\tfailed\t${outcome.rescueEnvError}`);
  if (outcome.ballastResult && (all || outcome.ballastResult.outcome !== "kept")) {
    lines.push(`ballast\t${outcome.ballastResult.outcome}\t${outcome.ballastResult.path}\t${outcome.ballastResult.detail}`);
  } else if (all && outcome.ballast) lines.push(`ballast\t${outcome.ballast.action}\t${outcome.ballast.path}\t${outcome.ballast.reason}`);
  for (const flag of outcome.flags) lines.push(`over cap\t${flag.issue}\t${(flag.sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GiB\t${flag.owner ?? "-"}`);
  return lines;
}

export async function runDisk(rest: string[]): Promise<void> {
  const flags = new Set(rest);
  const plan = flags.delete("--plan"), json = flags.delete("--json");
  if (flags.size) throw new Error(USAGE);
  const outcome = await hostDisk({ plan, readBuild: diskReadBuild() });
  if (json) console.log(JSON.stringify(outcome, null, 2));
  else if (outcome.state === "busy") console.log(outcome.reason);
  else for (const line of diskLines(outcome, plan)) console.log(line);
  if (outcome.state !== "busy" && outcome.failures) process.exitCode = 1;
}
