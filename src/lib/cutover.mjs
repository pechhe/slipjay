/**
 * `slipjay cutover`: move this machine's Slipway state from `~/.slipway` to
 * `~/.slipjay` once, so old and new code can never write separate lock stores.
 *
 * Order: refuse while anything holds or is about to hold the old state; move the
 * state directory and mode file (rename, or copy-verify-delete across devices);
 * write the marker last. Until the marker exists every slipjay state accessor
 * refuses (`workspace-paths.mjs`), so no slipjay process starts on the new store
 * mid-move. Existing workspaces stay where they are (`~/.slipway/workspaces`); their
 * metadata records their absolute paths, and new ones go to `~/.slipjay/workspaces`.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import lockfile from "proper-lockfile";
import { cutoverMarkerPath, legacyModePath, legacyStateHome, slipjayHome } from "./workspace-paths.mjs";

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

const readJson = (file) => readFile(file, "utf8").then(JSON.parse).catch(() => null);
const entries = (directory) => readdir(directory, { withFileTypes: true }).catch(() => []);

/** A proper-lockfile lock on `target` that its holder still refreshes. */
async function lockHeld(target, stale) {
  return lockfile.check(target, { realpath: false, stale }).catch(() => false);
}

/** Held locks and waiting records of the verification slots in one directory. */
async function slotHolders(root, directory, kind) {
  const holders = [];
  for (const entry of await entries(directory)) {
    if (!entry.isDirectory() || !entry.name.startsWith("verification-slot") || !entry.name.endsWith(".lock")) continue;
    const target = join(directory, entry.name.slice(0, -".lock".length));
    const holder = await readJson(`${target}.holder.json`);
    if (await lockHeld(target, 60_000) || alive(holder?.pid)) {
      holders.push(`${kind} ${relative(root, target)}${holder?.label ? ` held by ${holder.label}` : ""}${holder?.pid ? ` (pid ${holder.pid})` : ""}`);
    }
  }
  for (const entry of await entries(directory)) {
    if (!entry.isDirectory() || !entry.name.endsWith(".waiting")) continue;
    for (const waiter of await entries(join(directory, entry.name))) {
      const record = await readJson(join(directory, entry.name, waiter.name));
      if (alive(record?.pid)) holders.push(`${kind} waiter${record.label ? ` ${record.label}` : ""} (pid ${record.pid})`);
    }
  }
  return holders;
}

/**
 * Everything that holds, or is about to take, a lock or run in `root` (a
 * slipjay state directory), described one per line. Empty when it is quiescent.
 */
export async function cutoverHolders(root = legacyStateHome()) {
  if (!existsSync(root)) return [];
  const holders = [];
  // Landing transactions: workspace writer, integration, association and pool locks.
  for (const entry of await entries(join(root, "transactions"))) {
    if (entry.isDirectory() && entry.name.endsWith(".lock")
      && await lockHeld(join(root, "transactions", entry.name.slice(0, -".lock".length)), 120_000)) {
      holders.push(`landing transaction transactions/${entry.name.slice(0, -".lock".length)}`);
    }
  }
  holders.push(...await slotHolders(root, root, "verification slot"));
  holders.push(...await slotHolders(root, join(root, "post-land", "queue"), "post-land queue slot"));
  holders.push(...await slotHolders(root, join(root, "post-land", "issues"), "post-land Issue slot"));
  // Direct primary-checkout writers and per-workspace owners with a live process.
  for (const entry of await entries(join(root, "locks"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readJson(join(root, "locks", entry.name));
    if (!alive(record?.pid)) continue;
    holders.push(entry.name.startsWith("default@")
      ? `primary-checkout writer ${record.workspacePath ?? entry.name} (${record.surface ?? "unknown"} ${record.owner ?? "writer"}, pid ${record.pid})`
      : `workspace owner jj:${entry.name.slice(0, -".json".length)} (pid ${record.pid})`);
  }
  // Post-land runs that have not recorded a result and whose process is alive.
  for (const entry of await entries(join(root, "post-land"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await readJson(join(root, "post-land", entry.name));
    if (!record || record.finishedAt) continue;
    const pid = Number(await readFile(join(root, "post-land", `${record.commit}.pid`), "utf8").catch(() => ""));
    if (alive(pid)) holders.push(`post-land run ${String(record.commit).slice(0, 12)} (${record.status ?? "queued"}, pid ${pid})`);
  }
  // Post-integration runs hold their external-target lease while they work.
  for (const entry of await entries(join(root, "post-integration"))) {
    if (entry.isDirectory() && entry.name.startsWith("target-") && entry.name.endsWith(".lock")
      && await lockHeld(join(root, "post-integration", entry.name.slice(0, -".lock".length)), 120_000)) {
      holders.push(`post-integration run post-integration/${entry.name.slice(0, -".lock".length)}`);
    }
  }
  return holders;
}

/** Path → type, size and content digest of every entry beneath `root`, for copy verification. */
async function treeDigest(root) {
  const digest = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        digest.set(key, "directory");
        await walk(path);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        digest.set(key, `file ${content.length} ${createHash("sha256").update(content).digest("hex")}`);
      } else {
        digest.set(key, `other ${(await lstat(path)).mode}`);
      }
    }
  };
  if ((await stat(root)).isDirectory()) await walk(root);
  else {
    const content = await readFile(root);
    digest.set("", `file ${content.length} ${createHash("sha256").update(content).digest("hex")}`);
  }
  return digest;
}

async function sameTree(left, right) {
  const [a, b] = await Promise.all([treeDigest(left), treeDigest(right)]);
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/**
 * Move `from` (a file or directory) to `to`: one rename, or, when that crosses
 * devices, a copy beside `to` that is verified against `from`, renamed into
 * place and only then followed by deleting `from`. An earlier interrupted move
 * leaves both: identical copies finish by deleting `from`; differing ones refuse.
 */
async function moveVerified(from, to, io) {
  if (!existsSync(from)) return { moved: false, method: existsSync(to) ? "already-moved" : "absent" };
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  if (existsSync(to)) {
    if (!await sameTree(from, to)) {
      throw new Error(`Both ${from} and ${to} exist and differ, so an earlier cutover was interrupted after other writes. `
        + "Reconcile them by hand (keep the newer state), remove the other, then rerun `slipjay cutover`.");
    }
    await rm(from, { recursive: true, force: true });
    return { moved: true, method: "verified-existing" };
  }
  try {
    await io.rename(from, to);
    return { moved: true, method: "rename" };
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  const temporary = join(dirname(to), `.${basename(to)}.cutover-${randomUUID()}`);
  try {
    await cp(from, temporary, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (!await sameTree(from, temporary)) throw new Error(`The copy of ${from} did not match it; nothing was moved`);
    await io.rename(temporary, to);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await rm(from, { recursive: true, force: true });
  return { moved: true, method: "copy" };
}

/** Post-land records name their log by absolute path; point moved ones at the new state. */
async function repointPostLandLogs(from, to) {
  const directory = join(to, "post-land");
  for (const entry of await entries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = join(directory, entry.name);
    const record = await readJson(file);
    if (typeof record?.log !== "string" || !record.log.startsWith(`${from}/`)) continue;
    await writeFile(file, JSON.stringify({ ...record, log: join(to, relative(from, record.log)) }, null, 2), { mode: 0o600 });
  }
}

async function writeAtomic(file, content, mode) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Run (or, with `check`, only plan) the cutover. Returns
 * `{ status: "cut-over" | "already-cut-over" | "ready" | "refused", holders, ... }`;
 * `refused` names each holder and changes nothing. `io.rename` is injectable so
 * the cross-device fallback is testable.
 */
export async function cutover(options = {}) {
  const io = { rename, ...options.io };
  const from = { state: legacyStateHome(), mode: legacyModePath() };
  const to = { state: join(slipjayHome(), "state"), mode: join(slipjayHome(), "mode.json") };
  const marker = cutoverMarkerPath();
  if (existsSync(marker)) {
    // Nothing to do. Old state appearing again means old code is still running somewhere.
    const reappeared = Object.values(from).filter((path) => existsSync(path));
    return { status: "already-cut-over", marker, holders: [], ...(reappeared.length ? { reappeared } : {}) };
  }
  // A crashed earlier attempt may have left state at both locations.
  const holders = [...await cutoverHolders(from.state), ...await cutoverHolders(to.state)];
  if (holders.length) return { status: "refused", holders };
  if (options.check) return { status: "ready", holders, from, to };

  const state = await moveVerified(from.state, to.state, io);
  if (state.moved) await repointPostLandLogs(from.state, to.state);
  const mode = await moveVerified(from.mode, to.mode, io);
  // Something took a lock in the old state between the check and the move, or
  // wrote the old state while it moved: stop before settling the cutover.
  const late = await cutoverHolders(to.state);
  if (late.length) {
    throw new Error(`A holder appeared during the cutover (${late.join("; ")}); a process running Slipway is still active. `
      + "Stop it, then rerun `slipjay cutover`.");
  }
  const reappeared = Object.values(from).filter((path) => existsSync(path));
  if (reappeared.length) {
    throw new Error(`Old-location state reappeared during the cutover (${reappeared.join(", ")}); a process running Slipway is still active. `
      + "Stop it, then rerun `slipjay cutover`.");
  }
  const record = { version: 1, cutoverAt: new Date().toISOString(), from, to, state: state.method, mode: mode.method };
  await mkdir(slipjayHome(), { recursive: true, mode: 0o700 });
  await writeAtomic(marker, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return { status: "cut-over", marker, holders, ...record };
}
