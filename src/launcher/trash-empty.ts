#!/usr/bin/env bun
// The detached trash deletion (`startEmptyingTrash`): runs `emptyTrash` and writes what it
// deleted to the background-work log. It is an executable entry: nothing in src/lib imports
// it, and workspace-trash.ts spawns it.
import { emptyTrash } from "../lib/workspace/workspace-trash.ts";

try {
  const deleted = await emptyTrash();
  if (deleted.length) console.log(new Date().toISOString(), "trash emptied:", JSON.stringify(deleted));
} catch (caught) {
  const error = caught as Error | null | undefined;
  console.error(new Date().toISOString(), "trash emptying failed:", error?.stack ?? error);
  process.exitCode = 1;
}
