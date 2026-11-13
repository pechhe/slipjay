import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { join } from "node:path";
import { run } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { claimController, sameClaimController } from "./workspace-claim-identity.ts";
import type { ClaimController } from "./workspace-claim-identity.ts";
import { stateHome } from "./workspace-paths.ts";
import { WorkspaceClaimError } from "./workspace-claims.ts";

const workersHome = () => join(stateHome(), "managed-cleanup-workers");
const activationPath = () => join(stateHome(), "custody-activation.json");
export type CleanupInventory = { complete: boolean; pids: number[] };
export type CleanupInventoryReader = () => Promise<CleanupInventory>;
const isManaged = (args: string[]) => args.slice(0, 3).some((arg) =>
  /\/src\/launcher\/(?:workspace|housekeeping-run|spare-refill|trash-empty)\.ts$/.test(arg)
  || /\/\.bun\/bin\/(?:slipjay|slipway)$/.test(arg));
/** Managed CLI/background entry points only; not a promise over arbitrary obsolete library callers. */
export const managedCleanupInventory: CleanupInventoryReader = async () => {
  if (platform() === "linux") {
    const pids: number[] = [];
    let entries: string[];
    try { entries = await readdir("/proc"); } catch { return { complete: false, pids }; }
    for (const entry of entries.filter((name) => /^\d+$/.test(name))) {
      try {
        const args = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean);
        // Only executable arguments, never arbitrary shell/model text later in argv.
        if (isManaged(args)) {
          const environment = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
          if (environment.includes(`HOME=${process.env.HOME}`)) pids.push(Number(entry));
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return { complete: false, pids }; }
    }
    return { complete: true, pids };
  }
  if (platform() === "darwin") {
    const listed = await run("ps", ["-axo", "pid=,command="]);
    if (listed.code || listed.truncated) return { complete: false, pids: [] };
    const candidates = listed.stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match && isManaged(match[2]!.split(/\s+/)) ? [Number(match[1])] : [];
    });
    const pids: number[] = [];
    for (const pid of candidates) {
      const environment = await run("ps", ["eww", "-p", String(pid), "-o", "command="]);
      if (environment.code || environment.truncated) {
        if (await claimController(pid)) return { complete: false, pids };
        continue;
      }
      // ps appends the environment after argv; use its final HOME, never log this output.
      const homes = [...environment.stdout.matchAll(/(?:^|\s)HOME=([^\s]*)/g)];
      const home = homes.at(-1)?.[1];
      if (home === undefined) return { complete: false, pids };
      if (home === process.env.HOME) pids.push(pid);
    }
    return { complete: true, pids };
  }
  return { complete: false, pids: [] };
};
/** Register before a managed entry can do destructive work; no long-lived machine lock. */
export async function withManagedCleanupWorker<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(workersHome(), { recursive: true, mode: 0o700 });
  const path = join(workersHome(), `${randomUUID()}.json`);
  await writeWorkspaceJson(path, { version: 1, controller: await claimController() });
  try { return await operation(); } finally { await rm(path, { force: true }); }
}
// Only absence is proof that a sampled cleanup worker can no longer execute.
// Identity failures, permission errors and live unannounced workers still block activation.
function sampledWorkerExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ESRCH"; }
  return false;
}
async function barrier(reader: CleanupInventoryReader) {
  const inventory = await reader();
  if (!inventory.complete) throw new WorkspaceClaimError("CLAIM_ACTIVATION_UNKNOWN", "Managed cleanup worker inventory unavailable; drain cannot be established");
  const announced: ClaimController[] = [];
  try {
    for (const name of await readdir(workersHome())) {
      const record = JSON.parse(await readFile(join(workersHome(), name), "utf8")) as { version?: number; controller?: ClaimController };
      if (record.version === 1 && record.controller) announced.push(record.controller);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceClaimError("CLAIM_ACTIVATION_UNKNOWN", "Managed worker participation records unreadable"); }
  const old: number[] = [];
  for (const pid of inventory.pids.filter((pid) => pid !== process.pid)) {
    const identity = await claimController(pid);
    if ((!identity || !announced.some((entry) => sameClaimController(entry, identity))) && !sampledWorkerExited(pid)) old.push(pid);
  }
  if (old.length) throw new WorkspaceClaimError("CLAIM_ACTIVATION_DRAIN_REQUIRED", `Prior or unknown managed cleanup workers must drain: ${old.join(", ")}`);
}
export async function activateWorkspaceClaims(reader: CleanupInventoryReader = managedCleanupInventory): Promise<{ version: 1; activationId: string }> {
  return withWorkspaceTransaction("custody-activation", async () => {
    await barrier(reader);
    const existing = await readFile(activationPath(), "utf8").then((text) => JSON.parse(text) as { version?: number; activationId?: string }, () => null);
    const result = { version: 1 as const, activationId: existing?.version === 1 && typeof existing.activationId === "string" ? existing.activationId : randomUUID() };
    await writeWorkspaceJson(activationPath(), result);
    return result;
  });
}
export async function requireWorkspaceClaimActivation(id: string, reader: CleanupInventoryReader = managedCleanupInventory): Promise<void> {
  const activation = await readFile(activationPath(), "utf8").then((text) => JSON.parse(text) as { activationId?: string }, () => null);
  if (!id || activation?.activationId !== id) throw new WorkspaceClaimError("CLAIM_CAPABILITY_REQUIRED", "Ownership activation capability missing or changed");
  await barrier(reader);
}
export function workspaceClaimCapability() {
  return { version: 1, capability: "generation-bound-custody", protocol: 1, platform: platform(), supported: ["linux", "darwin"].includes(platform()),
    producerEntry: fileURLToPath(new URL("../../launcher/workspace.ts", import.meta.url)), activationRequired: true, retirementInterlock: "canonical-writer-fence-v1", settlementAuthority: "publisher-closed-obligation-set", credentialTransport: "stdin-json" };
}
