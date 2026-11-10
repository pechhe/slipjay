import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Turn the host disk policy's real-world effects off for a disposable home (no ballast, no scratch or cache roots),
 * so a test that runs `slipjay maintain` never allocates a ballast or touches the machine's /tmp. Other keys stay.
 */
export function quietDisk(home: string = homedir()): void {
  const path = join(home, ".slipjay", "config.json");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch { /* none yet */ }
  mkdirSync(join(home, ".slipjay"), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...config, disk: { ballast: { bytes: 0 }, scratchRoots: [], regenerable: [], runRoot: join(home, "runs") } }, null, 2));
}
