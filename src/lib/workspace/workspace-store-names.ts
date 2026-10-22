import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * JJ's `workspace forget` leaves the workspace's name in its workspace store
 * (`.jj/repo/workspace_store/index`), still pointing at the old checkout. A workspace later
 * renamed to that name resolves to the old path, and keeps it through further renames, so an
 * Issue's deterministic `ys-<n>` name could not be reused once its workspace was removed.
 * Dropping the forgotten name's entries before the rename avoids it.
 */

const readVarint = (bytes: Buffer, at: number): [number, number] | null => {
  let value = 0;
  for (let shift = 0, i = at; i < bytes.length && shift < 28; shift += 7, i += 1) {
    value |= (bytes[i]! & 0x7f) << shift;
    if (!(bytes[i]! & 0x80)) return [value, i + 1];
  }
  return null;
};

/** The store's entries as `[name, raw bytes]`, or null when the file is not the layout this reads. */
function parseEntries(bytes: Buffer): Array<[string | null, Buffer]> | null {
  const entries: Array<[string | null, Buffer]> = [];
  for (let at = 0; at < bytes.length;) {
    if (bytes[at] !== 0x0a) return null;
    const size = readVarint(bytes, at + 1);
    if (!size || size[1] + size[0] > bytes.length) return null;
    const message = bytes.subarray(at, size[1] + size[0]);
    const body = bytes.subarray(size[1], size[1] + size[0]);
    let name: string | null = null;
    if (body[0] === 0x0a) {
      const length = readVarint(body, 1);
      if (!length || length[1] + length[0] > body.length) return null;
      name = body.subarray(length[1], length[1] + length[0]).toString("utf8");
    }
    entries.push([name, message]);
    at += message.length;
  }
  return entries;
}

/**
 * Remove every store entry for workspace `name` from the repository at `integrationRoot`. The
 * caller has checked no live workspace holds the name. A store of another kind or layout is left alone.
 */
export async function dropForgottenWorkspaceName(integrationRoot: string, name: string): Promise<void> {
  const directory = join(integrationRoot, ".jj", "repo", "workspace_store");
  const path = join(directory, "index");
  const kind = await readFile(join(directory, "type"), "utf8").catch(() => "");
  if (kind.trim() !== "simple_workspace_store") return;
  const bytes = await readFile(path).catch(() => null);
  const entries = bytes && parseEntries(bytes);
  if (!bytes || !entries || !entries.some(([entry]) => entry === name)) return;
  const kept = Buffer.concat(entries.filter(([entry]) => entry !== name).map(([, message]) => message));
  const temporary = `${path}.slipjay-${process.pid}`;
  await writeFile(temporary, kept, { mode: 0o600 });
  await rename(temporary, path);
}
