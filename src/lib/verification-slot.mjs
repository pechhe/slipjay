import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { stateHome } from "./workspace-paths.mjs";

/** Set on verification commands so a landing started inside one (a test
 * fixture, a nested tool) never waits for the slot its parent holds. */
export const VERIFICATION_SLOT_ENV = "SLIPJAY_VERIFICATION_SLOT";

/** Environment for a command running inside the held slot. */
export function verificationSlotEnvironment(environment = process.env) {
  return { ...environment, [VERIFICATION_SLOT_ENV]: "held" };
}

const slotHeldBy = (environment) => environment[VERIFICATION_SLOT_ENV] === "held";

// Marks the async flow that holds the slot, so a landing can hold it across
// rebase, verification and integration while its inner verification call
// passes straight through.
const heldSlot = new AsyncLocalStorage();

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

// A record whose process is gone is removed, so a crashed landing never counts
// as ahead of a live one and the waiting directory cannot grow without bound.
const readRecord = async (file) => {
  let record;
  try { record = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (Number.isInteger(record?.pid) && alive(record.pid)) return record;
  await rm(file, { force: true }).catch(() => {});
  return null;
};

// A waiter touches its record on every poll. One untouched for as long as the
// lock takes to go stale belongs to a stopped process (or a reused pid), so it no
// longer counts: a contender that yields to waiters is never held up by it.
const STALE_MS = 60_000;
const readWaitingRecord = async (file) => {
  const modified = await stat(file).then((stats) => stats.mtimeMs, () => null);
  if (modified === null) return null;
  if (Date.now() - modified > STALE_MS) {
    await rm(file, { force: true }).catch(() => {});
    return null;
  }
  return await readRecord(file);
};

/** Replace `file` whole, so a reader never sees a half-written record. */
async function writeRecord(file, record) {
  const partial = `${file}.${record.id}.partial`;
  await writeFile(partial, JSON.stringify(record), { mode: 0o600 });
  await rename(partial, file);
}

/** One slot per integration root, so unrelated repositories never queue on each other. */
const slotName = (scope) => scope
  ? `verification-slot-${createHash("sha256").update(String(scope)).digest("hex").slice(0, 16)}`
  : "verification-slot";

/** The live holder and the live waiters other than `own`, oldest first. */
async function slotRecords(target, waitingDir, own) {
  const holder = await readRecord(`${target}.holder.json`);
  const names = await readdir(waitingDir).catch(() => []);
  const waiters = (await Promise.all(names.filter((name) => name.endsWith(".json") && name !== `${own.id}.json`)
    .map((name) => readWaitingRecord(join(waitingDir, name))))).filter(Boolean);
  return { holder, waiters: waiters.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1)) };
}

/**
 * Who is ahead of a waiting landing: the holder plus live landings that started
 * waiting earlier. Advisory only: the slot is not first-come-first-served, and
 * these records only describe it.
 */
const queueStatus = ({ holder, waiters }, own) => ({
  ahead: waiters.filter((record) => record.since < own.since || (record.since === own.since && record.id < own.id)).length + 1,
  holder: holder?.label ?? null,
});

/**
 * Run one landing while holding the verification slot for its integration root
 * (`scope`), so concurrent landings of one repository queue instead of starving
 * each other's timeouts while unrelated repositories land in parallel. A
 * landing holds it from rebase through integration: verifying against a base
 * that another landing advances meanwhile only earns a "bookmark moved" retry.
 * The lock lives under the user's Pi home and goes stale a minute after its
 * holder dies. Without a `scope` the slot is machine-wide. `onWait` is called
 * when the landing starts waiting and whenever the number of landings ahead of
 * it (or the holder) changes.
 *
 * `record` adds structured fields to this contender's holder and waiting records.
 * With `yieldTo`, the contender is in the waiting records from the start, and
 * `yieldTo({ own, holder, waiters })` decides before each attempt, and again once
 * the slot is taken, whether to stand aside this round: the lock is not
 * first-come-first-served, so a contender that must defer to a waiter hands a
 * slot it took straight back.
 */
export async function withVerificationSlot(operation, options = {}) {
  const environment = options.env ?? process.env;
  if (slotHeldBy(environment) || heldSlot.getStore()) return await operation();
  const root = options.root ?? stateHome();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, slotName(options.scope));
  const waitingDir = `${target}.waiting`;
  const own = { ...options.record, id: randomUUID(), pid: process.pid, since: Date.now(), label: options.label ?? null };
  const pollMs = options.pollMs ?? 2_000;
  const stands = async () => Boolean(options.yieldTo) && await options.yieldTo({ own, ...await slotRecords(target, waitingDir, own) });
  let release = null;
  let waiting = false;
  let reported = "";
  const enqueue = async () => {
    if (waiting) return;
    waiting = true;
    await mkdir(waitingDir, { recursive: true, mode: 0o700 });
    await writeRecord(join(waitingDir, `${own.id}.json`), own);
  };
  try {
    if (options.yieldTo) await enqueue();
    while (!release) {
      options.signal?.throwIfAborted();
      if (!await stands()) {
        try {
          release = await lockfile.lock(target, {
            realpath: false, stale: STALE_MS, update: 15_000, retries: 0,
            // A lost slot only weakens queueing; it must never crash the landing process.
            onCompromised: () => {},
          });
        } catch (error) {
          if (error?.code !== "ELOCKED") throw error;
        }
        if (release && await stands().catch(async (error) => { await release().catch(() => {}); throw error; })) {
          await release().catch(() => {});
          release = null;
        }
      }
      if (release) break;
      await enqueue();
      const status = queueStatus(await slotRecords(target, waitingDir, own), own);
      if (JSON.stringify(status) !== reported) {
        reported = JSON.stringify(status);
        options.onWait?.(status);
      }
      const now = new Date();
      await utimes(join(waitingDir, `${own.id}.json`), now, now).catch(() => {});
      await sleep(pollMs, undefined, options.signal ? { signal: options.signal } : undefined);
    }
  } finally {
    if (waiting) await rm(join(waitingDir, `${own.id}.json`), { force: true }).catch(() => {});
  }
  const holderFile = `${target}.holder.json`;
  await writeRecord(holderFile, own).catch(() => {});
  try {
    return await heldSlot.run(true, operation);
  } finally {
    // Only the current holder clears its record; a compromised slot may have moved on.
    if ((await readRecord(holderFile))?.id === own.id) await rm(holderFile, { force: true }).catch(() => {});
    await release().catch(() => {});
  }
}
