import { spawn } from "node:child_process";

export function occupy(cwd: string) {
  // Its own process group, like a process another session or terminal started: the caller's group counts as the caller.
  const child = spawn("sleep", ["60"], { cwd, stdio: "ignore", detached: true });
  return { pid: child.pid, dispose: () => child.kill() };
}
