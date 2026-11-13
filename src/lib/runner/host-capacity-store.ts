import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { decideCapacity, sameCapacityOwner, type CapacityDecision, type CapacityPolicy, type CapacityReading, type CapacityRequest } from "./host-capacity.ts";

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
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL);");
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
  const complete = (request: CapacityRequest, kind: "finished" | "recovered", evidence: unknown = null, at = Date.now()) => {
    record(request.id, { kind, request, queueMs: (request.admittedAt ?? at) - request.queuedAt,
      runMs: request.admittedAt === null ? null : at - request.admittedAt, evidence }, at);
    db.prepare("DELETE FROM requests WHERE id=?").run(request.id);
  };
  return {
    close: () => db.close(),
    requests: all,
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
        const registered = previous ?? request;
        const observed = observe(previous ? existing : [...existing, registered]);
        const retained: CapacityRequest[] = [];
        for (const item of existing) {
          if (observed.owners[item.id] === "gone") complete(item, "recovered", null, now);
          else retained.push(item);
        }
        if (observed.owners[request.id] === "gone") throw new Error("host capacity owner ended before admission");
        if (!retained.some((item) => item.id === registered.id)) retained.push(registered);
        const decision = decideCapacity(policy, retained, registered.id, observed.reading, now);
        if (observed.owners[request.id] !== "alive" && registered.admittedAt === null) {
          decision.admitted = false;
          decision.reason = "request ownership cannot be established";
        }
        const expired = registered.admittedAt === null && (now - registered.queuedAt >= policy.maxWaitMs || registered.bytes > policy.budgetBytes);
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
        for (const request of requests) {
          if (observed.owners[request.id] !== "gone") continue;
          complete(request, "recovered");
          removed += 1;
        }
        return removed;
      });
    },
  };
}
