import { readBuildThroughRunner, runnerLocation } from "../lib/runner/runner-client.ts";
import type { SweepOptions } from "../lib/workspace/workspace-sweep.ts";
import { callerPids, workspaceHolders } from "../lib/workspace/workspace-holders.ts";
import { cleanupLandedWorkspace, planDisposableWorkspaces, pruneEmptyWorkspaces, evictIdleWorkspaces, EVICTION_IDLE_MS, archiveWorkspace, latestArchiveFor, listArchives, restoreArchive, releaseWorkspace, readReleaseResult, latestReleaseFor, listReleaseResults, processArchiveRequests, workspaceContext, describeRetention, removeWorkspace } from "../lib/slipjay.ts";
import { resolve } from "node:path";

/** What `prune --empty` (with `emptyIdleMs: 0`) or the automatic sweep would do now, changing nothing. */
async function printRetentionPlan(options: SweepOptions, json: boolean): Promise<void> {
  const planned = await planDisposableWorkspaces(process.cwd(), options);
  if (json) return console.log(JSON.stringify(planned, null, 2));
  if (planned[0]) console.log(`repository ${planned[0].repository}`);
  const unknown = "unknown";
  for (const workspace of planned) {
    const issue = workspace.issueNumber ? ` · issue #${workspace.issueNumber}` : "";
    const size = workspace.sizeBytes === null ? `size ${unknown}` : `${Math.round(workspace.sizeBytes / 1024 / 1024)} MB`;
    const landing = workspace.landing
      ? `${workspace.landing.phase}, ${workspace.landing.published === null ? `publication ${unknown}` : workspace.landing.published ? "published" : "not published"}`
      : "none";
    console.log(`\n${workspace.action.toUpperCase()} ${workspace.name} (${workspace.state}${issue} · ${size}): ${workspace.reason}`);
    console.log(`  path: ${workspace.root || unknown}`);
    if (workspace.state === "integration") continue;
    if (workspace.state === "orphan") console.log(`  repository: ${workspace.repository ?? "none (not a JJ checkout)"}`);
    else console.log(`  task: ${workspace.task ?? "none"} · assigned: ${workspace.assignedAt ?? unknown} · landing: ${landing}`);
    console.log(`  processes: ${workspace.holders === null ? unknown : workspace.holders.join(", ") || "none"}`);
    console.log(`  unique files: ${workspace.uniqueFiles === null ? unknown : workspace.uniqueFiles.join(", ") || "none"}`);
  }
}

/**
 * Remove the workspace at `path` if it has landed or is untouched; unfinished
 * work stays in place and reports failure, so a caller (such as Claude Code's
 * WorktreeRemove hook) never treats a kept workspace as removed.
 */
async function removeWorkspaceAt(path: string, discard = false): Promise<number> {
  const context = await workspaceContext(path).catch(() => null);
  if (!context || context.current.name === "default") {
    console.log(`No isolated workspace at ${path}; nothing to remove.`);
    return 0;
  }
  const name = context.current.name;
  const holders = await workspaceHolders(context.current.root, { ignore: await callerPids() });
  if (!holders || holders.length) {
    console.error(`Kept jj:${name}: ${holders ? "in use by a live process" : "process working directories unavailable"}`);
    return 1;
  }
  const result = await cleanupLandedWorkspace(path);
  if (result.cleaned) {
    console.log(`Removed landed workspace jj:${name}`);
    return 0;
  }
  // A landing record another delivery's archive disowns proves nothing: judge the checkout as never landed.
  if (result.reason === "not-landed" || result.reason === "archived-elsewhere" || discard && result.reason === "new-unlanded-work") {
    try {
      // Removing never deletes a file no history holds, one already there or one teardown writes.
      await removeWorkspace(context.integration.root, name, { retainMaterial: true, ...discard ? { allowWork: true, allowIssue: true } : {} });
      console.log(`Removed untouched workspace jj:${name}`);
      return 0;
    } catch (error) {
      console.error(`Kept jj:${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  console.error(`Kept jj:${name}: ${describeRetention(result)}`);
  return 1;
}

export async function runPrune(rest: string[]): Promise<void> {
  const flags = new Set(rest);
  const plan = flags.delete("--plan"), json = flags.delete("--json"), empty = flags.delete("--empty");
  if (flags.size || (!plan && (!empty || json))) throw new Error("Usage: slipjay prune --empty | prune [--empty] --plan [--json]");
  const reader: Pick<SweepOptions, "readBuild"> = runnerLocation() ? { readBuild: (action, input) => readBuildThroughRunner(action, input) } : {};
  if (plan) await printRetentionPlan({ ...reader, ...empty ? { emptyIdleMs: 0 } : {} }, json);
  else {
    const result = await pruneEmptyWorkspaces(process.cwd(), reader);
    for (const name of result.removed) console.log(`Removed empty workspace: ${name}`);
    for (const path of result.pruned) console.log(`Pruned state: ${path}`);
    for (const path of result.orphans) console.log(`Removed orphaned directory: ${path}`);
    for (const skipped of result.skipped) console.error(`Skipped ${skipped.name}: ${skipped.reason}`);
    if (result.removed.length === 0 && result.skipped.length === 0 && result.pruned.length === 0 && result.orphans.length === 0) console.log("No empty workspaces to prune.");
  }
}

export async function runEvict(rest: string[]): Promise<void> {
  const flags = new Set(rest);
  const plan = flags.delete("--plan"), json = flags.delete("--json");
  let idleHours = 24;
  const idleIndex = rest.indexOf("--idle-hours");
  if (idleIndex >= 0) {
    const value = rest[idleIndex + 1];
    flags.delete("--idle-hours");
    if (value) flags.delete(value);
    idleHours = Number(value);
    if (!Number.isFinite(idleHours) || idleHours <= 0) throw new Error("Usage: slipjay evict [--plan] [--json] [--idle-hours <n>]");
  }
  if (flags.size) throw new Error("Usage: slipjay evict [--plan] [--json] [--idle-hours <n>]");
  const idleMs = idleHours === 24 ? EVICTION_IDLE_MS : idleHours * 60 * 60_000;
  const { plans, outcome } = await evictIdleWorkspaces(process.cwd(), { idleMs, plan });
  if (plan || json) {
    console.log(JSON.stringify(plan ? plans : outcome, null, 2));
  } else {
    for (const result of outcome.results) {
      const freed = result.freedBytes === null ? "" : `, freed ${(result.freedBytes / 1024 / 1024).toFixed(0)} MB`;
      console.log(`Evicted ${result.name}: ${result.removedPaths.join(", ")}${freed}`);
    }
    for (const skipped of outcome.skipped) console.error(`Kept ${skipped.name}: ${skipped.reason}`);
    if (!outcome.results.length) console.log("No idle workspace to evict.");
  }
}

export async function runArchive(rest: string[]): Promise<void> {
  const args = rest.filter((arg) => !arg.startsWith("-"));
  if (rest.length !== args.length || args.length > 1) throw new Error("Usage: slipjay archive [path]");
  const target = args[0] ?? process.cwd();
  const outcome = await archiveWorkspace(target, { reason: "archived by hand" });
  if ("refusal" in outcome) throw new Error(`Cannot archive ${target}: ${outcome.refusal}`);
  const { archive } = outcome;
  const kept = archive.payload ? `${archive.inventory.length} files outside history, ${(archive.payload.bytes / 1024 / 1024).toFixed(1)} MB` : "no files outside history";
  console.log(`Archived ${archive.workspaceName} as ${archive.id}: commit ${archive.commitId.slice(0, 12)} kept as bookmark ${archive.bookmark}, ${kept}.`);
}

export async function runRestore(rest: string[]): Promise<void> {
  // `--name` and `--path` let a harness put the checkout back exactly where its thread
  // expects it, which is what a resume needs.
  let archiveId: string | undefined;
  let name: string | undefined;
  let path: string | undefined;
  let latest = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--latest") {
      latest = true;
      continue;
    }
    if (arg === "--name" || arg === "--path") {
      const value = rest[++index];
      if (!value || value.startsWith("-")) throw new Error("Usage: slipjay restore <archive-id> [--name <name>] [--path <path>]");
      if (arg === "--name") name = value; else path = value;
    } else if (arg.startsWith("-") || archiveId !== undefined) {
      throw new Error("Usage: slipjay restore <archive-id> [--name <name>] [--path <path>]");
    } else archiveId = arg;
  }
  if (latest) {
    // A resumed thread knows where its checkout was, not which attempt archived it.
    if (!path) throw new Error("Usage: slipjay restore --latest --path <path> [--name <name>]");
    const newest = await latestArchiveFor(path);
    if (!newest) throw new Error(`No archive of ${path} to restore.`);
    archiveId = newest.id;
  }
  if (!archiveId) throw new Error("Usage: slipjay restore <archive-id> [--name <name>] [--path <path>]");
  const outcome = await restoreArchive(archiveId, { name, path });
  if ("refusal" in outcome) throw new Error(`Cannot restore ${archiveId}: ${outcome.refusal}`);
  console.log(JSON.stringify({ state: "restored", archiveId: outcome.archive.id, workspacePath: outcome.workspacePath, workspaceName: outcome.workspaceName }));
}

export async function runArchives(rest: string[]): Promise<void> {
  if (rest.length) throw new Error("Usage: slipjay archives");
  const archives = await listArchives();
  if (!archives.length) console.log("No archived workspaces.");
  for (const archive of archives) console.log(`${archive.id}\t${archive.createdAt}\t${archive.workspaceName}\t${archive.commitId.slice(0, 12)}\t${archive.inventory.length} files`);
}

export async function runMaintain(rest: string[]): Promise<void> {
  // The hourly pass: honour release requests first, then shed idle dependency trees.
  const json = rest.includes("--json");
  const args = rest.filter((arg) => arg !== "--json");
  if (args.length) throw new Error("Usage: slipjay maintain [--json]");
  const outcomes = await processArchiveRequests();
  const { outcome } = await evictIdleWorkspaces(process.cwd());
  if (json) console.log(JSON.stringify({ requests: outcomes, evictions: outcome }, null, 2));
  else {
    for (const entry of outcomes) console.log(`${entry.outcome}\t${entry.workspacePath}\t${entry.reason}`);
    for (const result of outcome.results) console.log(`evicted\t${result.name}\t${result.removedPaths.join(", ")}`);
    for (const skipped of outcome.skipped) if (!/used within|pool spare|no activity recorded/.test(skipped.reason)) console.error(`kept\t${skipped.name}\t${skipped.reason}`);
    if (!outcomes.length && !outcome.results.length) console.log("Nothing to archive or evict.");
  }
}

export async function runRetire(rest: string[]): Promise<void> {
  const operationIndex = rest.indexOf("--operation");
  const operationId = operationIndex >= 0 ? rest[operationIndex + 1] : undefined;
  const positional = rest.filter((arg, index) => !arg.startsWith("--") && index !== operationIndex + 1);
  if (!operationId || positional.length > 1 || rest.length !== positional.length + 2 || operationId.startsWith("-")) {
    throw new Error("Usage: slipjay retire <path> --operation <id>");
  }
  const result = await releaseWorkspace(positional[0] ?? process.cwd(), { operationId });
  console.log(JSON.stringify(result));
  if (result.state === "uncertain") process.exitCode = 2;
  else if (result.state === "refused") process.exitCode = 1;
}

export async function runRetireResult(rest: string[]): Promise<void> {
  // `--path` answers with the newest record for a checkout, which is what a harness
  // resuming a thread can name; `retire-result <id>` answers for one operation.
  let result;
  if (rest[0] === "--path") {
    if (rest.length !== 2 || rest[1]!.startsWith("-")) throw new Error("Usage: slipjay retire-result --path <path> | retire-result <operation-id>");
    result = await latestReleaseFor(rest[1]!);
  } else {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) throw new Error("Usage: slipjay retire-result --path <path> | retire-result <operation-id>");
    result = await readReleaseResult(rest[0]!);
  }
  console.log(JSON.stringify(result));
  // A harness reads this status: only a retirement is a success, and an unfinished
  // attempt is its own answer rather than something to mistake for one.
  if (!result) process.exitCode = 1;
  else if (result.state === "uncertain" || result.state === "retiring") process.exitCode = 2;
  else if (result.state === "refused") process.exitCode = 1;
}

export async function runRetirements(rest: string[]): Promise<void> {
  if (rest.length) throw new Error("Usage: slipjay retirements");
  const results = await listReleaseResults();
  if (!results.length) console.log("No releases recorded.");
  for (const result of results) console.log(`${result.operationId}\t${result.state}\t${result.at}\t${result.workspacePath}`);
}

export async function runCleanup(rest: string[]): Promise<void> {
  if (rest.length > 1 || rest[0]?.startsWith("-")) throw new Error("Usage: slipjay cleanup [path]");
  const result = await cleanupLandedWorkspace(rest[0] ? resolve(rest[0]) : process.cwd());
  console.log(result.cleaned ? "Workspace removed." : `Workspace retained: ${describeRetention(result)}.`);
}

export async function runRemove(rest: string[]): Promise<void> {
  const paths = rest.filter((arg) => arg !== "--discard");
  if (paths.length !== 1 || paths[0]!.startsWith("-")) throw new Error("Usage: slipjay remove [--discard] <path>");
  process.exitCode = await removeWorkspaceAt(resolve(paths[0]!), rest.includes("--discard"));
}
