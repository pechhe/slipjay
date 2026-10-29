import { spawn } from "node:child_process";

/** Keep a workspace occupied until the caller kills the returned process. */
export function holdWorkspace(cwd: string, options: { detached?: boolean } = {}) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore", ...options });
}
