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
/**
 * A participating CLI is unannounced while it starts (before its record is written) and as it exits
 * (after its record is removed), so any concurrent slipjay command would otherwise refuse custody
 * operations. Each sampled worker gets this long to announce or exit; an old worker does neither.
 */
export type DrainSettle = { windowMs: number; pollMs: number };
const drainSettle: DrainSettle = { windowMs: 3000, pollMs: 25 };
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
async function announcedControllers(): Promise<ClaimController[]> {
  const announced: ClaimController[] = [];
  try {
    for (const name of await readdir(workersHome())) {
      // A record removed between listing and reading is a worker finishing, not an unreadable one.
      const text = await readFile(join(workersHome(), name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (text === null) continue;
      const record = JSON.parse(text) as { version?: number; controller?: ClaimController };
      if (record.version === 1 && record.controller) announced.push(record.controller);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceClaimError("CLAIM_ACTIVATION_UNKNOWN", "Managed worker participation records unreadable"); }
  return announced;
}
/** The sampled process announced itself, or provably no longer runs (gone, or its pid now names another process). */
async function workerSettled(pid: number, identity: ClaimController | null, announced: ClaimController[]): Promise<boolean> {
  if (identity && announced.some((entry) => sameClaimController(entry, identity))) return true;
  if (sampledWorkerExited(pid)) return true;
  if (!identity) return false;
  const current = await claimController(pid);
  return current !== null && !sameClaimController(current, identity);
}
// One inventory snapshot, as before: workers starting after it are outside this barrier's promise.
async function barrier(reader: CleanupInventoryReader, settle: DrainSettle) {
  const inventory = await reader();
  if (!inventory.complete) throw new WorkspaceClaimError("CLAIM_ACTIVATION_UNKNOWN", "Managed cleanup worker inventory unavailable; drain cannot be established");
  let pending = await Promise.all(inventory.pids.filter((pid) => pid !== process.pid)
    .map(async (pid) => ({ pid, identity: await claimController(pid) })));
  const deadline = Date.now() + settle.windowMs;
  for (;;) {
    const announced = await announcedControllers();
    const settled = await Promise.all(pending.map((worker) => workerSettled(worker.pid, worker.identity, announced)));
    pending = pending.filter((_, index) => !settled[index]);
    if (!pending.length) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, settle.pollMs));
  }
  throw new WorkspaceClaimError("CLAIM_ACTIVATION_DRAIN_REQUIRED", `Prior or unknown managed cleanup workers must drain: ${pending.map((worker) => worker.pid).join(", ")}`);
}
export async function activateWorkspaceClaims(reader: CleanupInventoryReader = managedCleanupInventory, settle: DrainSettle = drainSettle): Promise<{ version: 1; activationId: string }> {
  return withWorkspaceTransaction("custody-activation", async () => {
    await barrier(reader, settle);
    const existing = await readFile(activationPath(), "utf8").then((text) => JSON.parse(text) as { version?: number; activationId?: string }, () => null);
    const result = { version: 1 as const, activationId: existing?.version === 1 && typeof existing.activationId === "string" ? existing.activationId : randomUUID() };
    await writeWorkspaceJson(activationPath(), result);
    return result;
  });
}
export async function requireWorkspaceClaimActivation(id: string, reader: CleanupInventoryReader = managedCleanupInventory, settle: DrainSettle = drainSettle): Promise<void> {
  const activation = await readFile(activationPath(), "utf8").then((text) => JSON.parse(text) as { activationId?: string }, () => null);
  if (!id || activation?.activationId !== id) throw new WorkspaceClaimError("CLAIM_CAPABILITY_REQUIRED", "Ownership activation capability missing or changed");
  await barrier(reader, settle);
}
export function workspaceClaimCapability() {
  return { version: 1, capability: "generation-bound-custody", protocol: 1, platform: platform(), supported: ["linux", "darwin"].includes(platform()),
    producerEntry: fileURLToPath(new URL("../../launcher/workspace.ts", import.meta.url)), activationRequired: true, retirementInterlock: "canonical-writer-fence-v1", settlementAuthority: "publisher-closed-obligation-set", credentialTransport: "stdin-json" };
}
