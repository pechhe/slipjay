import { runnerBuildNotice, runnerLocation } from "../lib/runner/runner-client.ts";
import type { RunnerBuild } from "../lib/runner/runner-client.ts";
import { changesBetween, describeChange, listChanges } from "../lib/workspace/workspace-changes.ts";
import type { Change } from "../lib/workspace/workspace-changes.ts";
import { upgradeMachine } from "../lib/workspace/workspace-upgrade.ts";
import type { UpgradeOutcome } from "../lib/workspace/workspace-upgrade.ts";

const UPGRADE_USAGE = "Usage: slipjay upgrade [--runner] [--rollback] [--json]";
const CHANGES_USAGE = "Usage: slipjay changes [--since <revision|YYYY-MM-DD>] [--json]";

const short = (commit: string | null): string => commit ? commit.slice(0, 12) : "none";

/** One upgrade's human line: the slot, what it did, and the installs it moved between. */
function describeUpgrade(outcome: UpgradeOutcome): string {
  const line = outcome.action === "current" || outcome.action === "busy" ? `${outcome.slot}: ${outcome.action}${outcome.action === "current" ? ` ${short(outcome.to)}` : ""}`
    : outcome.action === "failed" ? `${outcome.slot}: failed`
      : `${outcome.slot}: ${outcome.action} ${short(outcome.from)} → ${short(outcome.to)}`;
  return outcome.reason ? `${line} (${outcome.reason})` : line;
}

/** One line naming a runner left behind by the client's installs, which only `--runner` on its host moves. */
export function describeRunnerBuild(runner: RunnerBuild, clientRevision: string): string {
  return `runner ${runner.name} runs ${short(runner.revision)}, this client runs ${short(clientRevision)}: run slipjay upgrade --runner on its host to move it`;
}

/** The outcome `--json` prints: the runner it found behind, when there was one. */
export const withRunnerBuild = (outcome: UpgradeOutcome, runner: RunnerBuild | null): UpgradeOutcome | (UpgradeOutcome & { runner: RunnerBuild }) =>
  runner ? { ...outcome, runner } : outcome;

/** What a slot's move changed: the commits it brought in (or a rollback took away), or why they could not be read. */
type SlotChanges = { changes: Change[] } | { changesUnavailable: string } | Record<string, never>;

async function slotChanges(outcome: UpgradeOutcome): Promise<SlotChanges> {
  if ((outcome.action !== "upgraded" && outcome.action !== "rolled-back") || !outcome.from || !outcome.to) return {};
  try {
    return { changes: outcome.action === "upgraded" ? await changesBetween(outcome.from, outcome.to) : await changesBetween(outcome.to, outcome.from) };
  } catch (error) { return { changesUnavailable: error instanceof Error ? error.message : String(error) }; }
}

/** `upgrade [--runner] [--rollback] [--json]`: install the integration head into the client or runner slot. */
export async function runUpgrade(rest: string[]): Promise<number> {
  const flags = new Set(rest);
  const json = flags.delete("--json"), runner = flags.delete("--runner"), rollback = flags.delete("--rollback");
  if (flags.size) throw new Error(UPGRADE_USAGE);
  const outcome = await upgradeMachine({ ...runner ? { slot: "runner" as const } : {}, rollback });
  // Reading history never fails the upgrade: the slot has already moved.
  const moved = await slotChanges(outcome);
  // A client upgrade never moves the runner, so say when the build this machine now runs is ahead of it.
  // Only the client's own slot: a runner upgrade has just moved the runner's, and reports that itself.
  const behind = outcome.slot === "client" && outcome.to ? await runnerBuildNotice(runnerLocation(), outcome.to) : null;
  if (json) console.log(JSON.stringify({ ...withRunnerBuild(outcome, behind), ...moved }, null, 2));
  else {
    // A failure goes to stderr so a caller reading stdout sees only what happened.
    (outcome.action === "failed" ? console.error : console.log)(describeUpgrade(outcome));
    if ("changes" in moved) {
      const verb = outcome.action === "upgraded" ? "brought in" : "took away";
      console.log(`${verb} ${moved.changes.length} commit${moved.changes.length === 1 ? "" : "s"}:`);
      for (const change of moved.changes) console.log(`  ${describeChange(change)}`);
    } else if ("changesUnavailable" in moved) console.log(`what changed could not be listed: ${moved.changesUnavailable}`);
    if (outcome.command) console.log(`slipjay → ${outcome.command}`);
    if (behind && outcome.to) console.log(describeRunnerBuild(behind, outcome.to));
  }
  return outcome.action === "failed" ? 1 : 0;
}

/** `changes [--since <revision|YYYY-MM-DD>] [--json]`: what the integration branch changed, from its commit messages. */
export async function runChanges(rest: string[]): Promise<number> {
  let json = false, since: string | null = null;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!, value = rest[index + 1];
    if (arg === "--json") json = true;
    else if (arg === "--since" && since === null && value && !value.startsWith("--")) { since = value; index++; }
    else throw new Error(CHANGES_USAGE);
  }
  const changes = await listChanges({ since });
  if (json) console.log(JSON.stringify(changes, null, 2));
  else if (!changes.length) console.log("no changes");
  else for (const change of changes) console.log(describeChange(change));
  return 0;
}
