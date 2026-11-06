import { upgradeMachine } from "../lib/workspace/workspace-upgrade.ts";
import type { UpgradeOutcome } from "../lib/workspace/workspace-upgrade.ts";

const UPGRADE_USAGE = "Usage: slipjay upgrade [--runner] [--rollback] [--json]";

const short = (commit: string | null): string => commit ? commit.slice(0, 12) : "none";

/** One upgrade's human line: the slot, what it did, and the installs it moved between. */
function describeUpgrade(outcome: UpgradeOutcome): string {
  const line = outcome.action === "current" || outcome.action === "busy" ? `${outcome.slot}: ${outcome.action}${outcome.action === "current" ? ` ${short(outcome.to)}` : ""}`
    : outcome.action === "failed" ? `${outcome.slot}: failed`
      : `${outcome.slot}: ${outcome.action} ${short(outcome.from)} → ${short(outcome.to)}`;
  return outcome.reason ? `${line} (${outcome.reason})` : line;
}

/** `upgrade [--runner] [--rollback] [--json]`: install the integration head into the client or runner slot. */
export async function runUpgrade(rest: string[]): Promise<number> {
  const flags = new Set(rest);
  const json = flags.delete("--json"), runner = flags.delete("--runner"), rollback = flags.delete("--rollback");
  if (flags.size) throw new Error(UPGRADE_USAGE);
  const outcome = await upgradeMachine({ ...runner ? { slot: "runner" as const } : {}, rollback });
  if (json) console.log(JSON.stringify(outcome, null, 2));
  else {
    // A failure goes to stderr so a caller reading stdout sees only what happened.
    (outcome.action === "failed" ? console.error : console.log)(describeUpgrade(outcome));
    if (outcome.command) console.log(`slipjay → ${outcome.command}`);
  }
  return outcome.action === "failed" ? 1 : 0;
}
