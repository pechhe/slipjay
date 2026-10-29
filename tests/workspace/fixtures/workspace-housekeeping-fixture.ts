import { holdWorkspace } from "../../support/workspace-holder.ts";

export function occupy(cwd: string) {
  // Its own process group, like a process another session or terminal started: the caller's group counts as the caller.
  const child = holdWorkspace(cwd, { detached: true });
  return { pid: child.pid, dispose: () => child.kill() };
}
