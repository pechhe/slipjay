import { project } from "../../support/workspace-project.ts";
import { landedState } from "./landed-state.ts";
import type { PlannedWorkspace } from "../../../src/lib/workspace/workspace-sweep.ts";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

export const byName = (plan: PlannedWorkspace[]) => Object.fromEntries(plan.map((entry) => [entry.name, entry]));

export async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  // Planning starts after delivery; see landedState's coverage contract.
  return landedState(f, file, file);
}
