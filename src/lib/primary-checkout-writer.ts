/** Direct checkout writer authority shared by Peach and vanilla Pi.
 *
 * A Direct Thread writes the registered primary (JJ `default`) checkout. It uses
 * a primary-only writer record, keyed by the canonical checkout path so repositories never share
 * one `default` record. Acquisition serializes with the integration landing
 * transaction: a landing either finishes updating the primary checkout before a
 * direct write is admitted, or refuses while a live direct writer holds it. */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockHome } from "./workspace-paths.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

export type PrimaryWriterRecord = {
  version: 1; kind: "primary-checkout"; pid: number; surface: "peach" | "local"; owner: string;
  workspaceName: "default"; workspacePath: string; acquiredAt: string;
};

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "EPERM"; }
}

async function canonical(root: string): Promise<string> {
  return realpath(root).catch(() => resolve(root));
}

/** Writer-record name for one primary checkout; never a valid JJ workspace name. */
export async function primaryWriterName(integrationRoot: string): Promise<string> {
  const digest = createHash("sha256").update(await canonical(integrationRoot)).digest("hex");
  return `default@${digest.slice(0, 16)}`;
}

async function recordPath(integrationRoot: string): Promise<string> {
  return join(lockHome(), `${await primaryWriterName(integrationRoot)}.json`);
}

async function readRecord(file: string): Promise<PrimaryWriterRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw new Error("Direct checkout writer record is malformed; preserve it for explicit recovery");
  }
}

/** The live Direct writer, if any. A record whose process exited is fenced out. */
export async function activePrimaryWriter(integrationRoot: string): Promise<PrimaryWriterRecord | null> {
  const file = await recordPath(integrationRoot);
  const record = await readRecord(file);
  if (!record) return null;
  if (processAlive(record.pid)) return record;
  await rm(file, { force: true });
  return null;
}

function describe(record: PrimaryWriterRecord): string {
  return `${record.surface === "peach" ? "Peach" : "Pi"} ${record.owner ?? "writer"} (pid ${record.pid})`;
}

/** Refuse primary-checkout mutation while a Direct writer is live. Only the
 * same process and owner is exempt; landings and syncs pass no owner. */
export async function assertNoForeignPrimaryWriter(integrationRoot: string, owner?: string): Promise<void> {
  const active = await activePrimaryWriter(integrationRoot);
  if (active && !(owner !== undefined && active.pid === process.pid && active.owner === owner)) {
    throw new Error(`The primary checkout is being written by Direct ${describe(active)}; wait for that run to finish before changing it`);
  }
}

/** Admit one Direct writer for the primary checkout, idempotently for the same owner. */
export async function acquirePrimaryWriter({ integrationRoot, integrationBranch, owner, surface }: {
  integrationRoot: string; integrationBranch: string; owner: string; surface: "peach" | "local";
}): Promise<() => Promise<void>> {
  if (!owner) throw new Error("Direct checkout writer requires an owner");
  const root = await canonical(integrationRoot);
  const file = await recordPath(root);
  await withWorkspaceTransaction(`integrate:${resolve(integrationRoot)}:${integrationBranch}`, async () => {
    const active = await activePrimaryWriter(root);
    if (active && !(active.pid === process.pid && active.owner === owner)) {
      throw new Error(`Direct checkout ${root} is already being written by ${describe(active)}. Wait for it to finish, or start this work in an isolated workspace.`);
    }
    if (active) return;
    await mkdir(lockHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(file, {
      version: 1, kind: "primary-checkout", pid: process.pid, surface, owner,
      workspaceName: "default", workspacePath: root, acquiredAt: new Date().toISOString(),
    });
  });
  return () => releasePrimaryWriter(root, owner);
}

/** Release only this process's own record for `owner`; never another writer's. */
export async function releasePrimaryWriter(integrationRoot: string, owner: string): Promise<void> {
  const file = await recordPath(integrationRoot);
  const record = await readRecord(file).catch(() => null);
  if (record?.pid === process.pid && record.owner === owner) await rm(file, { force: true });
}
