import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";
import { spawnDetached } from "./workspace-background.ts";
import { slipjayHome, trashHome } from "./workspace-paths.ts";

/**
 * Remove a checkout without waiting for its files to be deleted: rename it into the trash
 * home, which is instant, then start the background deletion (`startEmptyingTrash`). A
 * large checkout takes minutes to delete, and every removal path (cleanup, `remove`, each
 * sweep) waits on this step while holding its locks. A checkout that cannot be renamed
 * there, such as one on another volume, is deleted in place as before.
 */
export async function discardCheckout(path: string): Promise<void> {
  await mkdir(trashHome(), { recursive: true, mode: 0o700 });
  try {
    await rename(path, join(trashHome(), `${basename(path)}-${Date.now()}-${randomUUID().slice(0, 8)}`));
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ENOENT") return;
    await rm(path, { recursive: true, force: true });
    return;
  }
  await startEmptyingTrash();
}

/**
 * Delete everything in the trash home. One deletion runs on the machine at a time; another
 * finding it running returns at once, since the running one rereads the trash until it is
 * empty. A deletion interrupted by a crash is finished by the next one.
 */
export async function emptyTrash(): Promise<string[]> {
  try {
    return await withWorkspaceTransaction("trash", async () => {
      const deleted: string[] = [];
      for (;;) {
        const entries = (await readdir(trashHome()).catch(() => [])).filter((entry) => !deleted.includes(entry));
        if (!entries.length) return deleted;
        for (const entry of entries) {
          await rm(join(trashHome(), entry), { recursive: true, force: true });
          deleted.push(entry);
        }
      }
    }, { wait: false });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return [];
    throw error;
  }
}

/**
 * Empty the trash in a detached child at the lowest CPU priority, since how long deletion takes
 * matters less than the load it adds. Not macOS background QoS (`taskpolicy -b`): on a busy Mac
 * a process given it may not be scheduled at all. Does nothing when the trash is empty.
 */
export async function startEmptyingTrash(): Promise<{ started: boolean; pid?: number; reason?: string }> {
  if (!(await readdir(trashHome()).catch(() => [])).length) return { started: false, reason: "empty" };
  return await spawnDetached(["nice", "-n", "19", process.execPath, fileURLToPath(new URL("../../launcher/trash-empty.ts", import.meta.url))], slipjayHome());
}
