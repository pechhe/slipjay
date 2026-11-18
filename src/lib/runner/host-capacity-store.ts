import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { CAPACITY_GROWTH_STEP_BYTES, CAPACITY_SAMPLE_FLOOR_BYTES, CAPACITY_SAMPLE_WINDOW, CAPACITY_WAIT_RETENTION_MS, decideCapacity, learnTypical, planLandingRoom, sameCapacityOwner, withLearnedTypical, type CapacityDecision, type CapacityPolicy, type CapacityReading, type CapacityRequest, type CapacitySample, type CapacityWait, type CapacityWaitOutcome } from "./host-capacity.ts";

export type CapacityObservation = {
  reading: CapacityReading | null;
  owners: Readonly<Record<string, "alive" | "gone" | "unknown">>;
  /** How readily each preview gives way to a landing, where it declared it (SJ-275). */
  giveWay?: Readonly<Record<string, number>>;
};

/** A preview a landing stopped to make room, kept a week beside the waits (SJ-275). */
export type CapacityYieldRecord = { requestId: string; job: string; landingId: string; landingJob: string; residentBytes: number; at: number };

export type CapacityReceipt = {
  outcome: "admitted" | "waiting" | "unavailable";
  mode: CapacityPolicy["mode"];
  decision: CapacityDecision;
  request: CapacityRequest;
  /**
   * Previews this landing has stopped, or still needs stopped, to make its room (SJ-275): the caller stops each one's
   * unit. Repeated on every poll until its group is empty, so a stop that did not take is retried.
   */
  yields?: CapacityRequest[];
};

/** Waits ended at or after `since`, oldest first: one row per request, kept a week. */
const WAITS_SINCE = "SELECT lane, job, queued_at AS queuedAt, ended_at AS endedAt, outcome FROM waits WHERE ended_at >= ? ORDER BY ended_at, request_id";
const waitsSince = (db: DatabaseSync, since: number): CapacityWait[] =>
  (db.prepare(WAITS_SINCE).all(since) as CapacityWait[]).map((wait) => ({ ...wait }));

/**
 * The waits that ended at or after `since`, read without writing to the ledger, so a metric can ask it beside live
 * admissions. A ledger that was never written, or one from before waits were, has none; that is an empty report, not an
 * error. A ledger whose write-ahead log still needs recovery opens only for writing, so it is read the way admission
 * reads it.
 */
export function readCapacityWaits(path: string, since: number): CapacityWait[] {
  if (!existsSync(path)) return [];
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='waits'").get()) return [];
      return waitsSince(db, since);
    } finally { db.close(); }
  } catch {
    const store = openCapacityStore(path);
    try { return store.waits(since); } finally { store.close(); }
  }
}

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
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS peaks (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT NOT NULL, job TEXT NOT NULL, peak_bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS waits (request_id TEXT PRIMARY KEY, lane TEXT NOT NULL, job TEXT NOT NULL, queued_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, outcome TEXT NOT NULL); CREATE INDEX IF NOT EXISTS waits_ended_at ON waits(ended_at); CREATE TABLE IF NOT EXISTS yields (request_id TEXT PRIMARY KEY, job TEXT NOT NULL, landing_id TEXT NOT NULL, landing_job TEXT NOT NULL, resident_bytes INTEGER NOT NULL, at INTEGER NOT NULL);");
        // A ledger from before growth, or the measure of its peaks, was recorded gains the column; a concurrent opener
        // adding it first is not an error.
        const columns = (db.prepare("PRAGMA table_info(peaks)").all() as Array<{ name: string }>).map(({ name }) => name);
        for (const column of ["growth", "measure"].filter((name) => !columns.includes(name))) {
          try { db.exec(`ALTER TABLE peaks ADD COLUMN ${column} TEXT`); }
          catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
        }
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
  const all = () => (db.prepare("SELECT body FROM requests ORDER BY id").all() as Array<{ body: string }>).map(({ body }): CapacityRequest => {
    const request = JSON.parse(body) as CapacityRequest & { peakBytes?: number };
    // A job admitted before SJ-267 recorded its `memory.peak`, file cache included: its peak and growth start again.
    if (request.peakBytes === undefined) return request;
    const { peakBytes: _, growth: __, ...measured } = request;
    return measured;
  });
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
  // Finished jobs' peaks live apart from the per-poll decisions, which waiting jobs fill within minutes (SJ-246). Only
  // peaks of unreclaimable memory (`measure` 'resident', SJ-267) size work; the `memory.peak` ones before them (no
  // measure) stay as history.
  const samples = () => (db.prepare("SELECT lane, peak_bytes AS peakBytes FROM peaks WHERE measure = 'resident' ORDER BY seq").all() as CapacitySample[]);
  /**
   * The one row a waiting request leaves when its wait ends, written in the transaction that admitted it or gave up on
   * it. A request already admitted writes nothing, and the primary key means a wait whose end is seen again (a repeat
   * poll after the wait limit, or recovery of a request that already recorded its end) keeps its first row. Waits older
   * than a week go with the write that follows them, so a day's question stays small.
   */
  const endWait = (request: CapacityRequest, outcome: CapacityWaitOutcome, at: number) => {
    if (request.admittedAt !== null) return;
    db.prepare("INSERT OR IGNORE INTO waits(request_id,lane,job,queued_at,ended_at,outcome) VALUES (?,?,?,?,?,?)")
      .run(request.id, request.lane, request.job, request.queuedAt, at, outcome);
    db.prepare("DELETE FROM waits WHERE ended_at < ?").run(at - CAPACITY_WAIT_RETENTION_MS);
  };
  const complete = (request: CapacityRequest, kind: "finished" | "recovered", evidence: unknown = null, at = Date.now()) => {
    record(request.id, { kind, request, queueMs: (request.admittedAt ?? at) - request.queuedAt,
      runMs: request.admittedAt === null ? null : at - request.admittedAt, evidence }, at);
    // An owner that ended before admission abandoned its wait; one that ran and finished had no wait left to end.
    if (kind === "recovered") endWait(request, "abandoned", at);
    // Its evidence's `memoryPeakBytes` is the kernel's `memory.peak`, file cache included, so it sizes nothing (SJ-267).
    const reported = evidence as { memoryResidentBytes?: unknown; measuredPeakBytes?: unknown } | null;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : -1;
    const peak = Math.max(request.residentPeakBytes ?? -1, number(reported?.memoryResidentBytes), number(reported?.measuredPeakBytes));
    // Only a real measurement is kept, so work that measured nothing never pushes measured peaks out of the window.
    if (request.admittedAt !== null && peak >= CAPACITY_SAMPLE_FLOOR_BYTES) {
      db.prepare("INSERT INTO peaks(at,lane,job,peak_bytes,growth,measure) VALUES (?,?,?,?,?,'resident')")
        .run(at, request.lane, request.job, peak, request.growth ? JSON.stringify(request.growth) : null);
      db.prepare("DELETE FROM peaks WHERE lane=? AND measure = 'resident' AND seq NOT IN (SELECT seq FROM peaks WHERE lane=? AND measure = 'resident' ORDER BY seq DESC LIMIT ?)").run(request.lane, request.lane, CAPACITY_SAMPLE_WINDOW);
    }
    db.prepare("DELETE FROM requests WHERE id=?").run(request.id);
  };
  /** A higher peak, and when the job reached it: one growth entry per step, so a job's whole climb stays a short list. */
  const raised = (item: CapacityRequest, peak: number, now: number): CapacityRequest => {
    const growth = item.growth ?? [];
    const stepped = item.admittedAt !== null && peak - (growth.at(-1)?.[1] ?? 0) >= CAPACITY_GROWTH_STEP_BYTES;
    return { ...item, residentPeakBytes: peak, ...stepped ? { growth: [...growth, [Math.max(0, now - item.admittedAt!), peak] as const] } : {} };
  };
  /** Keep the most each running job's cgroup has been seen to use, so work whose cgroup is gone by recovery still has a peak. */
  const notePeaks = (requests: readonly CapacityRequest[], reading: CapacityReading | null, now: number) => requests.map((item) => {
    const peak = reading?.peakBytes[item.id];
    if (item.admittedAt === null || typeof peak !== "number" || !Number.isFinite(peak) || peak <= (item.residentPeakBytes ?? -1)) return item;
    const updated = raised(item, peak, now);
    save(updated);
    return updated;
  });
  return {
    close: () => db.close(),
    requests: all,
    /** Each kind of work's effective typical size, where it came from and how many peaks it rests on. */
    typical: (policy: CapacityPolicy) => learnTypical(policy, samples()),
    history: () => db.prepare("SELECT at, request_id AS requestId, body FROM decisions ORDER BY seq DESC LIMIT 100").all(),
    /** Previews stopped for a landing since `since`, oldest first (SJ-275). */
    yields: (since: number) => (db.prepare("SELECT request_id AS requestId, job, landing_id AS landingId, landing_job AS landingJob, resident_bytes AS residentBytes, at FROM yields WHERE at >= ? ORDER BY at, request_id").all(since) as CapacityYieldRecord[]).map((row) => ({ ...row })),
    waits: (since: number) => waitsSince(db, since),
    /** A running job's runner reports memory it uses outside its cgroup; its peak only ever rises. */
    noteUsage(id: string, owner: CapacityRequest["owner"], externalBytes: number, peakBytes: number): void {
      transaction(() => {
        const request = all().find((item) => item.id === id);
        if (!request) return;
        if (!sameCapacityOwner(request.owner, owner)) throw new Error("host capacity usage belongs to another owner");
        save({ ...peakBytes > (request.residentPeakBytes ?? 0) ? raised(request, peakBytes, Date.now()) : request, externalBytes });
      });
    },
    /**
     * One sample of a running job's memory, kept if it is a new peak (SJ-267). Unreclaimable memory has no kernel peak
     * counter, so the job's sampler reads it every few seconds. False once the job has left the ledger or its owner ended.
     */
    sample(id: string, observe: (requests: readonly CapacityRequest[]) => CapacityObservation, now = Date.now()): boolean {
      return transaction(() => {
        const request = all().find((item) => item.id === id);
        if (!request) return false;
        const observed = observe([request]);
        notePeaks([request], observed.reading, now);
        return observed.owners[id] !== "gone";
      });
    },
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
        const noted = notePeaks(existing, observed.reading, now);
        const registered = { ...noted.find((item) => item.id === request.id) ?? request, polledAt: now };
        const retained: CapacityRequest[] = [];
        for (const item of noted) {
          if (observed.owners[item.id] === "gone") complete(item, "recovered", null, now);
          else if (item.id !== registered.id) retained.push(item);
        }
        if (observed.owners[request.id] === "gone") throw new Error("host capacity owner ended before admission");
        retained.push(registered);
        const learned = withLearnedTypical(policy, samples());
        const decision = decideCapacity(learned, retained, registered.id, observed.reading, now);
        if (observed.owners[request.id] !== "alive" && registered.admittedAt === null) {
          decision.admitted = false;
          decision.reason = "request ownership cannot be established";
        }
        // A landing that cannot fit stops just enough previews to (SJ-275). Their claims stop counting now; the landing is
        // admitted by a later poll whose reading shows the memory back.
        if (!decision.admitted && observed.owners[request.id] === "alive") {
          const stopping = planLandingRoom(learned, retained, registered.id, observed.reading, now, observed.giveWay);
          for (const item of stopping) {
            const yieldedFor = { landingId: registered.id, landingJob: registered.job, at: now, residentBytes: observed.reading!.currentBytes[item.id]! };
            const index = retained.indexOf(item);
            retained[index] = { ...item, yieldedFor };
            save(retained[index]!);
            db.prepare("INSERT OR IGNORE INTO yields(request_id,job,landing_id,landing_job,resident_bytes,at) VALUES (?,?,?,?,?,?)")
              .run(item.id, item.job, registered.id, registered.job, yieldedFor.residentBytes, now);
          }
          db.prepare("DELETE FROM yields WHERE at < ?").run(now - CAPACITY_WAIT_RETENTION_MS);
          if (stopping.length) decision.reason = `stopping ${stopping.map((item) => item.job).join(", ")} to make room`;
        }
        const expired = registered.admittedAt === null && now - registered.queuedAt >= policy.maxWaitMs;
        // Shadow decisions never block execution, but they retain real owners/commitments and an explicit would-wait
        // receipt. Switching back to shadow must not discard work already running under enforce mode.
        const admitted = registered.admittedAt !== null || decision.admitted || policy.mode === "shadow";
        const updated = admitted && registered.admittedAt === null ? { ...registered, admittedAt: now } : registered;
        save(updated);
        const yields = retained.filter((item) => item.yieldedFor?.landingId === registered.id);
        const receipt: CapacityReceipt = {
          outcome: admitted ? "admitted" : expired ? "unavailable" : "waiting", mode: policy.mode, decision, request: updated,
          ...yields.length ? { yields } : {},
        };
        record(registered.id, receipt, now);
        // The wait's end is written with the decision that ended it: admitted now, or out of time and not running. A poll
        // that keeps waiting ends nothing.
        if (admitted) endWait(registered, "admitted", now);
        else if (expired) endWait(registered, "wait-limit", now);
        // Diagnostics are bounded, unlike live ownership. Never prune a live claim merely to bound the ledger.
        db.exec("DELETE FROM decisions WHERE seq < (SELECT COALESCE(MAX(seq),0)-1000 FROM decisions)");
        return receipt;
      });
    },
    /** A release is an observation, not an authority to forget descendants. Unknown means keep. */
    recover(observe: (requests: readonly CapacityRequest[]) => CapacityObservation, now = Date.now()): number {
      return transaction(() => {
        const requests = all();
        const observed = observe(requests);
        let removed = 0;
        for (const request of notePeaks(requests, observed.reading, now)) {
          if (observed.owners[request.id] !== "gone") continue;
          complete(request, "recovered", null, now);
          removed += 1;
        }
        return removed;
      });
    },
  };
}
