/**
 * Where a repository's work is tracked: GitHub Issues, the default, or HQ Build, chosen by
 * `tracker` in slipjay.json. In a Build-tracked repository the numbers `start --issue` and
 * `attach-issue` record are Build numbers: landings name them in a `Build: #N` trailer, and
 * their titles and states are read from Build through the SlipJay runner, which holds the
 * Build credential. Callers pass that reader (`readBuildThroughRunner` on a client); without
 * one a Build item's title and state are unknown.
 */
import { run } from "../infra/workspace-jj.ts";

export type Tracker = "github" | "build";

/** The tracker a parsed policy declares; GitHub when it declares none. */
export const trackerOf = (policy: { tracker?: unknown } | null | undefined): Tracker => policy?.tracker === "build" ? "build" : "github";

/** Build's read-only actions the runner forwards; nothing else crosses that seam. */
export const BUILD_READ_ACTIONS = ["read", "list", "waits", "binds"] as const;
export type BuildReadAction = (typeof BUILD_READ_ACTIONS)[number];
/** Reads Build, throwing a `BuildRefusal` when Build refuses and any other error when it gives no answer. */
export type BuildReader = (action: BuildReadAction, input: Record<string, unknown>) => Promise<unknown>;
/** Build's answer to a read of an item that does not exist. */
export const BUILD_ITEM_UNAVAILABLE = "build_item_unavailable";
export class BuildRefusal extends Error {
  readonly code: string;
  constructor(action: string, code: string) {
    super(`Build refused ${action}: ${code}`);
    this.code = code;
  }
}

/** The fields of a Build item SlipJay reads. */
export type BuildItem = { id: string; number: number; kind: string; status: string; parentId: string | null; title: string; bodyRevision?: number | null };

const CLOSED_STATUSES = new Set(["landed", "accepted", "dropped", "achieved", "superseded", "imported_closed"]);
/** Closed: nothing is left to deliver. A `legacy` item, imported closed from GitHub, is closed whatever its status. */
export const buildItemClosed = (item: Pick<BuildItem, "kind" | "status">): boolean => item.kind === "legacy" || CLOSED_STATUSES.has(item.status);

/** The item, or null when Build says it does not exist; throws when Build cannot answer. */
export async function readBuildItem(read: BuildReader, reference: { number: number } | { itemId: string }): Promise<BuildItem | null> {
  try {
    return await read("read", reference) as BuildItem;
  } catch (error) {
    if (error instanceof BuildRefusal && error.code === BUILD_ITEM_UNAVAILABLE) return null;
    throw error;
  }
}

/** The work item's title, or null when it cannot be read. */
export async function workItemTitle(root: string, tracker: Tracker, number: number, read?: BuildReader): Promise<string | null> {
  if (tracker === "build") {
    if (!read) return null;
    try {
      return (await readBuildItem(read, { number }))?.title?.trim() || null;
    } catch { return null; }
  }
  const result = await run("gh", ["issue", "view", String(number), "--json", "title", "-q", ".title"], { cwd: root });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** Whether the work item is closed, or null when its state cannot be read. */
export async function workItemClosed(root: string, tracker: Tracker, number: number, read?: BuildReader): Promise<boolean | null> {
  if (tracker === "build") {
    if (!read) return null;
    try {
      const item = await readBuildItem(read, { number });
      return item ? buildItemClosed(item) : null;
    } catch { return null; }
  }
  const result = await run("gh", ["issue", "view", String(number), "--json", "state", "-q", ".state"], { cwd: root, timeoutMs: 20_000 });
  const state = result.code === 0 ? result.stdout.trim() : "";
  return state ? state === "CLOSED" : null;
}
