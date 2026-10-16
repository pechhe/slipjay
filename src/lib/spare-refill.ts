#!/usr/bin/env bun
// The detached spare-pool refill (`startSpareRefill`): runs `refillPool` for the
// integration root given as the only argument and writes one line per outcome to its
// log. It is a closure entry beside workspace-pool.ts.
import { refillPool } from "./workspace-pool.ts";

const root = process.argv[2];
try {
  if (!root) throw new Error("spare-refill needs the integration root");
  await refillPool(root, (outcome) => console.log(new Date().toISOString(), JSON.stringify(outcome)));
} catch (caught) {
  const error = caught as Error | null | undefined;
  console.error(new Date().toISOString(), "refill failed:", error?.stack ?? error);
  process.exitCode = 1;
}
