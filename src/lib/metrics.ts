import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "./workspace-paths.ts";

/**
 * Append one JSON line to `<state>/metrics/<kind>.jsonl`, so a slow day can be
 * explained afterwards. Best effort: a metrics failure never fails the command.
 */
export async function appendMetric(kind: string, record: Record<string, unknown>, { root = join(stateHome(), "metrics") }: { root?: string } = {}): Promise<void> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await appendFile(join(root, `${kind}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {}
}
