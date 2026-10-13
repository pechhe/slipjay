import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Operation, OperationEvent, OperationLog, RunRecord, StoredEvent } from "./runner-contract.ts";

export function newOperationId(): string {
  return `op_${Date.now().toString(36).padStart(10, "0")}_${randomBytes(12).toString("hex")}`;
}

type EventRow = { seq: number; operation_id: string; at: string; data: string };

export function openOperationLog(path: string): OperationLog {
  const db = new DatabaseSync(path);
  if (path !== ":memory:")
    db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS events_operation_id ON events(operation_id); CREATE INDEX IF NOT EXISTS events_type ON events(type)`);
  const insert = db.prepare("INSERT INTO events (operation_id, at, type, data) VALUES (?, ?, ?, ?)");
  const select = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE seq > ? AND (? IS NULL OR operation_id = ?) ORDER BY seq`);
  const events: OperationLog["events"] = (options = {}) => {
    const id = options.operationId ?? null;
    return (select.all(options.afterSeq ?? 0, id, id) as EventRow[]).map((row) => ({
      seq: row.seq, operationId: row.operation_id, at: row.at,
      event: JSON.parse(row.data) as OperationEvent,
    }));
  };
  const terminalTypes = "('landed','failed','declined','superseded','cancelled')";
  // Projections read only the operations they need: open ones (the queue) or one change's.
  const openIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND operation_id NOT IN (SELECT operation_id FROM events WHERE type IN ${terminalTypes}) ORDER BY seq`);
  const changeIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.changeId') = ? ORDER BY seq DESC`);
  const projectIds = (ids: string[]): Operation[] =>
    ids.flatMap((id) => { const operation = project(id, events({ operationId: id })); return operation ? [operation] : []; });
  // One serial queue across repositories, in submission order; positions come from the id list alone.
  const openOrder = (): string[] => (openIds.all() as { operation_id: string }[]).map((row) => row.operation_id);
  function queue(): Operation[] {
    const open = projectIds(openOrder());
    open.forEach((operation, index) => { operation.position = index + 1; });
    return open;
  }
  function withPosition(projected: Operation, order: string[]): Operation {
    const index = order.indexOf(projected.id);
    return index >= 0 ? { ...projected, position: index + 1 } : projected;
  }
  function operation(id: string): Operation | null {
    const projected = project(id, events({ operationId: id }));
    return projected ? withPosition(projected, openOrder()) : null;
  }
  return {
    append(operationId, event) {
      const at = new Date().toISOString();
      const result = insert.run(operationId, at, event.type, JSON.stringify(event));
      return { seq: Number(result.lastInsertRowid), operationId, at, event };
    },
    events,
    operation,
    operationsForChange: (repo, changeId) => {
      const order = openOrder();
      return projectIds((changeIds.all(repo, changeId) as { operation_id: string }[]).map((row) => row.operation_id))
        .map((entry) => withPosition(entry, order));
    },
    openOperations: (repo) => queue().filter((entry) => repo === undefined || entry.repo === repo),
    close: () => db.close(),
  };
}

function project(id: string, events: StoredEvent[]): Operation | null {
  const submitted = events.find((stored) => stored.event.type === "submitted");
  if (!submitted || submitted.event.type !== "submitted")
    return null;
  const { repo, changeId, commitId, bookmark, submittedBy } = submitted.event;
  const operation: Operation = {
    id, repo, changeId, commitId, bookmark, submittedBy,
    status: "queued", stage: "queued", submittedAt: submitted.at,
    runs: [], lastSeq: events.at(-1)!.seq,
  };
  const runs = new Map<string, RunRecord>();
  for (const stored of events) {
    const event = stored.event;
    switch (event.type) {
      case "stage":
        operation.stage = event.stage;
        if (event.stage !== "queued" && !operation.result)
          operation.status = "running";
        break;
      case "run_started": {
        const run: RunRecord = { runId: event.runId, command: event.command, host: event.host, startedAt: stored.at };
        runs.set(event.runId, run);
        operation.runs.push(run);
        break;
      }
      case "run_finished": {
        const run = runs.get(event.runId);
        if (run) {
          Object.assign(run, { finishedAt: stored.at, exitCode: event.exitCode, signal: event.signal, timedOut: event.timedOut, durationMs: event.durationMs });
        }
        break;
      }
      case "landed":
      case "failed":
      case "declined":
      case "superseded":
      case "cancelled":
        operation.status = event.type;
        operation.result = event;
        operation.finishedAt = stored.at;
        break;
      default:
        break;
    }
  }
  return operation;
}
