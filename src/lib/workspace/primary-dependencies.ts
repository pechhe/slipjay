import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { installInputFingerprint } from "./install-inputs.ts";
import { stateHome } from "./workspace-paths.ts";
import { readJsonOptional } from "./workspace-state.ts";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.ts";

/** What `refreshPrimaryDependencies` reads and does; tests replace them. */
export type PrimaryDependencyHost = {
  fingerprint(root: string): Promise<string | null>;
  install(root: string, installInputs: string): Promise<void>;
  /** The primary checkout's current commit, which an install must not change. */
  sourceId(root: string): Promise<string>;
};

/** Where the install inputs of a primary checkout's last successful install are recorded. */
const recordPath = (root: string): string =>
  join(stateHome(), "primary-installs", `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)}.json`);

/**
 * Bring a primary checkout's dependencies in line with its source after SlipJay moved it
 * (or found it current): a landing that changes install inputs otherwise leaves its
 * `node_modules` stale for every tool that runs there. Compared with the fingerprint recorded
 * for its last successful install, so an already-stale tree is caught and an unchanged one
 * costs a fingerprint only. Never throws: the result is a warning, and the source move stands.
 * Callers hold the `integrate:` transaction, which serialises this per checkout.
 */
export async function refreshPrimaryDependencies(root: string, host: PrimaryDependencyHost): Promise<string | undefined> {
  try {
    const inputs = await host.fingerprint(root);
    if (!inputs) return undefined;
    if ((await readJsonOptional<{ installInputs?: string }>(recordPath(root)))?.installInputs === inputs) return undefined;
    const before = await host.sourceId(root);
    await host.install(root, inputs);
    if (await host.sourceId(root) !== before)
      return "Installing the primary checkout's dependencies changed its tracked source; the install is not recorded, so fix the install script";
    await mkdir(join(stateHome(), "primary-installs"), { recursive: true });
    await writeWorkspaceJson(recordPath(root), { installInputs: inputs, installedAt: new Date().toISOString() });
    return undefined;
  } catch (error) {
    return `The primary checkout's dependencies could not be installed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The real fingerprint and quiet frozen install; `sourceId` comes from the caller's `revisionFacts`. */
export const primaryDependencyHost = (sourceId: PrimaryDependencyHost["sourceId"]): PrimaryDependencyHost => ({
  fingerprint: (root) => installInputFingerprint(root),
  install: async (root, installInputs) => { await prepareWorkspaceDependencies(root, { quiet: true, installInputs }); },
  sourceId,
});
