/**
 * A short-lived cache of directory sizes for the host disk pass (SJ-226). `du` over run directories dominates a
 * pass, and sizes only feed the report and the per-Issue cap flag, never a removal decision, so a size a few
 * minutes old is as good as a fresh one. Unreadable or corrupt cache files are ignored.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SIZE_CACHE_TTL_MS: number = 30 * 60_000;

type Entries = Record<string, { sizeBytes: number; at: number }>;

/** Wrap `measure` so each path is measured at most once per `ttlMs`; the cache is persisted at `file`. */
export function cachedSizeOf(
  measure: (path: string) => Promise<number | null>,
  file: string,
  options: { now?: () => number; ttlMs?: number } = {},
): (path: string) => Promise<number | null> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SIZE_CACHE_TTL_MS;
  let loaded: Promise<Entries> | undefined;
  const load = (): Promise<Entries> => loaded ??= readFile(file, "utf8").then((text) => {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Entries : {};
  }, () => ({})).catch(() => ({}));
  return async (path) => {
    const entries = await load();
    const hit = entries[path];
    if (hit && typeof hit.sizeBytes === "number" && typeof hit.at === "number" && now() - hit.at >= 0 && now() - hit.at < ttlMs) return hit.sizeBytes;
    const sizeBytes = await measure(path);
    if (sizeBytes === null) return null;
    entries[path] = { sizeBytes, at: now() };
    for (const [key, entry] of Object.entries(entries)) if (now() - entry.at >= ttlMs) delete entries[key];
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(entries));
      await rename(`${file}.tmp`, file);
    } catch { /* a cache that cannot be written only costs the next pass a measurement */ }
    return sizeBytes;
  };
}
