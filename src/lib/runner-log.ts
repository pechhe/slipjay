import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { DeployOperation, LandingOperation, Operation, OperationEvent, OperationLog, RunRecord, StoredEvent } from "./runner-contract.ts";

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
  const terminalTypes = `(${TERMINAL_EVENT_TYPES.map((type) => `'${type}'`).join(",")})`;
  // Projections read only the operations they need: open ones (the queue) or one change's.
  const openIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND operation_id NOT IN (SELECT operation_id FROM events WHERE type IN ${terminalTypes}) ORDER BY seq`);
  const changeIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.changeId') = ? ORDER BY seq DESC`);
  const deployIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND json_extract(data, '$.kind') = 'deploy' AND json_extract(data, '$.repo') = ?
    AND (? IS NULL OR json_extract(data, '$.environment') = ?) ORDER BY seq DESC`);
  const landed = db.prepare(`SELECT landed.at, landed.data FROM events landed
    JOIN events submitted ON submitted.operation_id = landed.operation_id AND submitted.type = 'submitted'
    WHERE landed.type = 'landed' AND json_extract(submitted.data, '$.repo') = ? ORDER BY landed.seq DESC LIMIT 1`);
  const control = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE operation_id = ? AND type IN ('paused', 'resumed') ORDER BY seq DESC LIMIT 1`);
  function paused(): { by: string; at: string } | null {
    const row = control.get(RUNNER_CONTROL_ID) as EventRow | undefined;
    const event = row ? JSON.parse(row.data) as OperationEvent : undefined;
    return row && event?.type === "paused" ? { by: event.by, at: row.at } : null;
  }
  const projectIds = (ids: string[]): Operation[] =>
    ids.flatMap((id) => { const operation = project(id, events({ operationId: id })); return operation ? [operation] : []; });
  // Two serial lanes across repositories, each in submission order: landings with
  // releases, and deploys.
  function queue(): Operation[] {
    const open = projectIds((openIds.all() as { operation_id: string }[]).map((row) => row.operation_id));
    const held = paused() !== null;
    for (const lane of [open.filter((operation) => operation.kind !== "deploy"), open.filter((operation) => operation.kind === "deploy")]) {
      const running = lane.find((operation) => operation.status === "running");
      lane.forEach((operation, index) => {
        operation.position = index + 1;
        if (operation.status !== "queued") return;
        if (held) operation.stage = "paused";
        if (running) operation.waitingFor = label(running);
      });
    }
    return open;
  }
  // An open operation carries its queue fields; a closed one is its bare projection.
  function placed<T extends Operation>(projected: T, open: Operation[]): T {
    return (open.find((entry) => entry.id === projected.id) as T | undefined) ?? projected;
  }
  function operation(id: string): Operation | null {
    const projected = project(id, events({ operationId: id }));
    return projected ? placed(projected, queue()) : null;
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
      const open = queue();
      return projectIds((changeIds.all(repo, changeId) as { operation_id: string }[]).map((row) => row.operation_id))
        .filter((entry): entry is LandingOperation => entry.kind === "landing")
        .map((entry) => placed(entry, open));
    },
    openOperations: (repo) => queue().filter((entry) => repo === undefined || entry.repo === repo),
    deployments: (repo, environment) => {
      const open = queue();
      return projectIds((deployIds.all(repo, environment ?? null, environment ?? null) as { operation_id: string }[]).map((row) => row.operation_id))
        .filter((entry): entry is DeployOperation => entry.kind === "deploy")
        .map((entry) => placed(entry, open));
    },
    lastLanded: (repo) => {
      const row = landed.get(repo) as { at: string; data: string } | undefined;
      const event = row ? JSON.parse(row.data) as OperationEvent : undefined;
      return row && event?.type === "landed" ? { commitId: event.commitId, at: row.at } : null;
    },
    paused,
    close: () => db.close(),
  };
}

/** How a queued operation names the one running ahead of it. */
const label = (operation: Operation): string =>
  operation.kind === "landing" ? `landing ${operation.changeId.slice(0, 12)}` : `${operation.kind} ${operation.commitId.slice(0, 12)}`;

function project(id: string, events: StoredEvent[]): Operation | null {
  const submitted = events.find((stored) => stored.event.type === "submitted");
  if (!submitted || submitted.event.type !== "submitted")
    return null;
  const fields = {
    id, repo: submitted.event.repo, commitId: submitted.event.commitId, submittedBy: submitted.event.submittedBy,
    status: "queued" as const, stage: "queued" as const, submittedAt: submitted.at,
    runs: [], lastSeq: events.at(-1)!.seq,
  };
  const operation: Operation = submitted.event.kind === "release"
    ? { ...fields, kind: "release", migrationsReady: submitted.event.migrationsReady }
    : submitted.event.kind === "deploy"
      ? { ...fields, kind: "deploy", environment: submitted.event.environment }
      : { ...fields, kind: "landing", changeId: submitted.event.changeId, bookmark: submitted.event.bookmark };
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
      case "released":
      case "deployed":
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
