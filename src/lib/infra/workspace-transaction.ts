import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { transactionHome } from "../workspace/workspace-paths.ts";

type TransactionOwner = { key: string; pid: number; command: string; since: string };
/** Diagnostic ownership, kept beside (never inside) proper-lockfile's lock directory. */
export async function workspaceTransactionLocks(): Promise<Array<{ lock: string; owner: TransactionOwner | null }>> {
  const root = transactionHome();
  return Promise.all((await readdir(root).catch(() => [])).filter((name) => name.endsWith(".lock")).map(async (name) => ({
    lock: join(root, name), owner: await readFile(join(root, name.slice(0, -5) + ".owner.json"), "utf8")
      .then((text) => JSON.parse(text) as TransactionOwner).catch(() => null),
  })));
}

// Only short native identity/owner transitions are serialized here. Never use
// this repository key around model work, verification or a connector request.
/** With `wait: false`, a held transaction rejects at once with code `ELOCKED`; with `waitMs`, after waiting at most that long. */
export async function withWorkspaceTransaction<T>(key: string, operation: () => Promise<T>, options: { wait?: boolean; waitMs?: number } = {}): Promise<T> {
  const root = transactionHome();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, createHash("sha256").update(key).digest("hex"));
  const diagnostic = process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS === "1";
  const ownerPath = target + ".owner.json";
  const waiting = diagnostic ? setTimeout(() => {
    void readFile(ownerPath, "utf8").catch(() => "unknown").then((owner) =>
      console.error(`[slipjay transaction] waiting 10s key=${JSON.stringify(key)} waiter=${process.pid} lock=${target}.lock owner=${owner}`));
  }, 10_000) : undefined;
  waiting?.unref();
  let release: () => Promise<void>;
  try { release = await lockfile.lock(target, {
    realpath: false, stale: 120000, update: 10000,
    // A healthy holder refreshes every 10 seconds. Wait beyond the stale
    // boundary so loaded workspace provisioning serializes instead of failing
    // while that holder is still making progress.
    retries: options.wait === false ? 0
      : options.waitMs ? { retries: Math.ceil(options.waitMs / 50), minTimeout: 25, maxTimeout: 50 }
      : { retries: 1400, minTimeout: 25, maxTimeout: 100 },
  }); } finally { clearTimeout(waiting); }
  try {
    if (diagnostic) await writeWorkspaceJson(ownerPath, { key, pid: process.pid, command: process.argv.slice(0, 2).join(" "), since: new Date().toISOString() });
    return await operation();
  } finally {
    // Delete our diagnostic before releasing: a new owner may acquire immediately.
    try { if (diagnostic) await rm(ownerPath, { force: true }); } finally { await release(); }
  }
}

/** Atomically replace a workspace JSON sidecar. */
export async function writeWorkspaceJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
