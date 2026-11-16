import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { CAPACITY_SAMPLE_FLOOR_BYTES, CAPACITY_SAMPLE_WINDOW, decideCapacity, learnTypical, sameCapacityOwner, withLearnedTypical, type CapacityDecision, type CapacityPolicy, type CapacityReading, type CapacityRequest, type CapacitySample } from "./host-capacity.ts";

export type CapacityObservation = {
  reading: CapacityReading | null;
  owners: Readonly<Record<string, "alive" | "gone" | "unknown">>;
};

export type CapacityReceipt = {
  outcome: "admitted" | "waiting" | "unavailable";
  mode: CapacityPolicy["mode"];
  decision: CapacityDecision;
  request: CapacityRequest;
};

/**
 * One host ledger, shared by every CLI/runner caller. Observation and admission happen in the same SQLite write
 * transaction: two readers of the same quiet host cannot both spend its remaining commitment. No lock is held while
 * waiting for capacity or running work. Rows disappear only after the owner observer proves their lifetime ended.
 */
export function openCapacityStore(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    // SQLite can return SQLITE_BUSY from a concurrent first WAL open without invoking its busy handler. Retry only
    // idempotent initialization within one bounded deadline; ordinary admission transactions use SQLite's handler.
    db.exec("PRAGMA busy_timeout=25;");
    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peaks (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT NOT NULL, job TEXT NOT NULL, peak_bytes INTEGER NOT NULL);");
        break;
      } catch (error) {
        const remaining = deadline - Date.now();
        if ((error as { errcode?: number }).errcode !== 5 || remaining <= 0) throw error;
        Atomics.wait(pause, 0, 0, Math.min(25, remaining));
      }
    }
    db.exec("PRAGMA busy_timeout=5000;");
  } catch (error) {
    db.close();
    throw error;
  }
  const all = () => (db.prepare("SELECT body FROM requests ORDER BY id").all() as Array<{ body: string }>).map(({ body }) => JSON.parse(body) as CapacityRequest);
  const save = (request: CapacityRequest) => db.prepare("INSERT INTO requests(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(request.id, JSON.stringify(request));
  const transaction = <A>(work: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const record = (id: string, body: unknown, at = Date.now()) => {
    db.prepare("INSERT INTO decisions(at,request_id,body) VALUES (?,?,?)").run(at, id, JSON.stringify(body));
    db.exec("DELETE FROM decisions WHERE seq < (SELECT COALESCE(MAX(seq),0)-1000 FROM decisions)");
  };
  // Finished jobs' peaks live apart from the per-poll decisions, which waiting jobs fill within minutes (SJ-246).
  const samples = () => (db.prepare("SELECT lane, peak_bytes AS peakBytes FROM peaks ORDER BY seq").all() as CapacitySample[]);
  const complete = (request: CapacityRequest, kind: "finished" | "recovered", evidence: unknown = null, at = Date.now()) => {
    record(request.id, { kind, request, queueMs: (request.admittedAt ?? at) - request.queuedAt,
      runMs: request.admittedAt === null ? null : at - request.admittedAt, evidence }, at);
    const measured = (evidence as { memoryPeakBytes?: unknown } | null)?.memoryPeakBytes;
    const peak = Math.max(request.peakBytes ?? -1, typeof measured === "number" && Number.isFinite(measured) ? measured : -1);
    // Only a real measurement is kept, so work that measured nothing never pushes measured peaks out of the window.
    if (request.admittedAt !== null && peak >= CAPACITY_SAMPLE_FLOOR_BYTES) {
      db.prepare("INSERT INTO peaks(at,lane,job,peak_bytes) VALUES (?,?,?,?)").run(at, request.lane, request.job, peak);
      db.prepare("DELETE FROM peaks WHERE lane=? AND seq NOT IN (SELECT seq FROM peaks WHERE lane=? ORDER BY seq DESC LIMIT ?)").run(request.lane, request.lane, CAPACITY_SAMPLE_WINDOW);
    }
    db.prepare("DELETE FROM requests WHERE id=?").run(request.id);
  };
  /** Keep the most each running job's cgroup has been seen to use, so work whose cgroup is gone by recovery still has a peak. */
  const notePeaks = (requests: readonly CapacityRequest[], reading: CapacityReading | null) => requests.map((item) => {
    const peak = reading?.peakBytes[item.id];
    if (item.admittedAt === null || typeof peak !== "number" || !Number.isFinite(peak) || peak <= (item.peakBytes ?? -1)) return item;
    const updated = { ...item, peakBytes: peak };
    save(updated);
    return updated;
  });
  return {
    close: () => db.close(),
    requests: all,
    /** Each kind of work's effective typical size, where it came from and how many peaks it rests on. */
    typical: (policy: CapacityPolicy) => learnTypical(policy, samples()),
    history: () => db.prepare("SELECT at, request_id AS requestId, body FROM decisions ORDER BY seq DESC LIMIT 100").all(),
    finish(id: string, owner: CapacityRequest["owner"], stopped: (request: CapacityRequest) => boolean, evidence: unknown = null): boolean {
      return transaction(() => {
        const request = all().find((item) => item.id === id);
        if (!request) return true;
        if (!sameCapacityOwner(request.owner, owner)) throw new Error("host capacity release belongs to another owner");
        if (!stopped(request)) return false;
        complete(request, "finished", evidence);
        return true;
      });
    },
    poll(request: CapacityRequest, policy: CapacityPolicy, observe: (requests: readonly CapacityRequest[]) => CapacityObservation, now: number): CapacityReceipt {
      return transaction(() => {
        const existing = all();
        const previous = existing.find((item) => item.id === request.id);
        if (previous && (previous.bytes !== request.bytes || previous.lane !== request.lane
          || previous.cgroup !== request.cgroup || !sameCapacityOwner(previous.owner, request.owner))) {
          throw new Error(`host capacity request ${request.id} belongs to a different owner or commitment`);
        }
        const observed = observe(previous ? existing : [...existing, request]);
        const noted = notePeaks(existing, observed.reading);
        const registered = { ...noted.find((item) => item.id === request.id) ?? request, polledAt: now };
        const retained: CapacityRequest[] = [];
        for (const item of noted) {
          if (observed.owners[item.id] === "gone") complete(item, "recovered", null, now);
          else if (item.id !== registered.id) retained.push(item);
        }
        if (observed.owners[request.id] === "gone") throw new Error("host capacity owner ended before admission");
        retained.push(registered);
        const decision = decideCapacity(withLearnedTypical(policy, samples()), retained, registered.id, observed.reading, now);
        if (observed.owners[request.id] !== "alive" && registered.admittedAt === null) {
          decision.admitted = false;
          decision.reason = "request ownership cannot be established";
        }
        const expired = registered.admittedAt === null && now - registered.queuedAt >= policy.maxWaitMs;
        // Shadow decisions never block execution, but they retain real owners/commitments and an explicit would-wait
        // receipt. Switching back to shadow must not discard work already running under enforce mode.
        const admitted = registered.admittedAt !== null || decision.admitted || policy.mode === "shadow";
        const updated = admitted && registered.admittedAt === null ? { ...registered, admittedAt: now } : registered;
        save(updated);
        const receipt: CapacityReceipt = {
          outcome: admitted ? "admitted" : expired ? "unavailable" : "waiting", mode: policy.mode, decision, request: updated,
        };
        record(registered.id, receipt, now);
        // Diagnostics are bounded, unlike live ownership. Never prune a live claim merely to bound the ledger.
        db.exec("DELETE FROM decisions WHERE seq < (SELECT COALESCE(MAX(seq),0)-1000 FROM decisions)");
        return receipt;
      });
    },
    /** A release is an observation, not an authority to forget descendants. Unknown means keep. */
    recover(observe: (requests: readonly CapacityRequest[]) => CapacityObservation): number {
      return transaction(() => {
        const requests = all();
        const observed = observe(requests);
        let removed = 0;
        for (const request of notePeaks(requests, observed.reading)) {
          if (observed.owners[request.id] !== "gone") continue;
          complete(request, "recovered");
          removed += 1;
        }
        return removed;
      });
    },
  };
}
