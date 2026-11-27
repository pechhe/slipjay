import { holdWorkspace } from "../../support/workspace-holder.ts";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

/** A process working inside `cwd` until disposed, as a live session would be. */
export function occupy(cwd: string) {
  const child = holdWorkspace(cwd);
  return () => child.kill();
}
