#!/usr/bin/env bun
// The detached housekeeping sweep (`startHousekeeping`): runs `runHousekeeping` for the
// integration root given as the only argument and writes one line per outcome to its
// log. It is a closure entry beside workspace-housekeeping.ts.
import { readBuildThroughRunner, runnerLocation } from "./runner-client.ts";
import { runHousekeeping } from "./workspace-housekeeping.ts";

const root = process.argv[2];
try {
  if (!root) throw new Error("housekeeping needs the integration root");
  const outcome = await runHousekeeping(root, runnerLocation() ? { readBuild: (action, input) => readBuildThroughRunner(action, input) } : {});
  console.log(new Date().toISOString(), "housekeeping:", JSON.stringify(outcome));
} catch (caught) {
  const error = caught as Error | null | undefined;
  console.error(new Date().toISOString(), "housekeeping failed:", error?.stack ?? error);
  process.exitCode = 1;
}
