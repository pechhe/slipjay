#!/usr/bin/env bun
// The detached housekeeping sweep (`startHousekeeping`, and a landing's `startLandedHousekeeping`):
// runs `runHousekeeping` for the integration root given as the last argument and writes one line
// per outcome to its log. With `--landing`, it first releases the landed workspace named by
// `--release`, ignoring the landing's processes listed by `--ignore`, and sweeps whatever the
// interval. It is an executable entry: nothing in src/lib imports it, and
// workspace-housekeeping.ts spawns it.
import { workspaceContext } from "../lib/infra/workspace-jj.ts";
import { readBuildThroughRunner, runnerLocation } from "../lib/runner/runner-client.ts";
import { runHousekeeping } from "../lib/workspace/workspace-housekeeping.ts";
import { releaseLandedWorkspace } from "../lib/workspace/workspace-lifecycle.ts";

const args = process.argv.slice(2);
const root = args.at(-1);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 && index + 1 < args.length - 1 ? args[index + 1] : undefined; };
const landing = args.includes("--landing");
try {
  if (!root || root.startsWith("--")) throw new Error("housekeeping needs the integration root");
  const released = option("--release");
  const context = released ? await workspaceContext(released) : null;
  if (context) {
    const ignore = (option("--ignore") ?? "").split(",").filter(Boolean).map(Number);
    const outcome = await releaseLandedWorkspace(context, { ignore }).catch((error: unknown) => ({ cleaned: false, reason: String(error) }));
    console.log(outcome.cleaned ? `Removed workspace: ${context.current.name}` : `Kept landed workspace ${context.current.name}: ${"reason" in outcome ? outcome.reason : "cleanup did not complete"}`);
  }
  const outcome = await runHousekeeping(root, {
    ...landing ? { intervalMs: 0 } : {},
    ...runnerLocation() ? { readBuild: (action, input) => readBuildThroughRunner(action, input) } : {},
  });
  if (landing && outcome.ran) {
    for (const removed of outcome.result.removed) console.log(`Removed workspace: ${removed}`);
    // An undelivered checkout kept by its session is the normal case; a delivered one is a leftover.
    for (const skipped of outcome.result.skipped) if (skipped.landed) console.log(`Kept landed workspace ${skipped.name}: ${skipped.reason}`);
  }
  console.log(new Date().toISOString(), "housekeeping:", JSON.stringify(outcome));
} catch (caught) {
  const error = caught as Error | null | undefined;
  console.error(new Date().toISOString(), "housekeeping failed:", error?.stack ?? error);
  process.exitCode = 1;
}
