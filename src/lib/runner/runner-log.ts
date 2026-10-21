import { projectWatchOperation } from "./runner-watch-projection.ts";
import { landingOutcome } from "../landing/landing-outcome.ts";
import { classifyFailure, classifyVerificationFailures } from "./failure-classification.ts";
import { deliveryState } from "../build/build-receipts.ts";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { admissionLane, admits, awaitingReplacement, recoveryKey, repositoryKey, RUNNER_CONTROL_ID, RUNNER_DEFAULT_WORKERS, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import { BUDGET_MIN_SAMPLES, BUDGET_WINDOW_MS, pipelineMetrics } from "./pipeline-metrics.ts";
import type { AuditOperation, DeployOperation, LandingOperation, Operation, OperationEvent, OperationLog, PublishedLanding, ReleaseOperation, ResetOperation, RunRecord, StoredEvent, HeldIntegrationState, VerificationOperation } from "./runner-contract.ts";

export function newOperationId(): string {
  return `op_${Date.now().toString(36).padStart(10, "0")}_${randomBytes(12).toString("hex")}`;
}

type EventRow = { seq: number; operation_id: string; at: string; data: string };

/** How long a repository's short-landing class stands before the sliding budget window is read again. */
const SHORT_CLASS_REFRESH_MS = 600_000;

/** What the queue admits by, so a queued operation names what it really waits for: `runnerLogOptions` derives it from the runner config. */
export type OperationLogOptions = {
  workers?: number; lane?: (repo: string) => string; depth?: (repo: string) => 1 | 2;
  /** The verify-stage p90 at or below which a repository's landings are short; absent, there is no short place. */
  shortLandingP90Ms?: number;
};

export function openOperationLog(path: string, { workers = RUNNER_DEFAULT_WORKERS, lane = (repo: string) => repo, depth = () => 1, shortLandingP90Ms }: OperationLogOptions = {}): OperationLog {
  const db = new DatabaseSync(path);
  if (path !== ":memory:")
    db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS events_operation_id ON events(operation_id); CREATE INDEX IF NOT EXISTS events_type ON events(type); CREATE INDEX IF NOT EXISTS events_at ON events(at);
    CREATE UNIQUE INDEX IF NOT EXISTS events_submission_request ON events(json_extract(data, '$.repo'), json_extract(data, '$.requestId')) WHERE type = 'submission_request'`);
  const listeners = new Set<(event: StoredEvent) => void>();
  const insert = db.prepare("INSERT INTO events (operation_id, at, type, data) VALUES (?, ?, ?, ?)");
  // Separate statements: an `OR operation_id = ?` would hide the index and scan the whole ledger per operation.
  const select = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE seq > ? ORDER BY seq LIMIT ?`);
  const selectOperation = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE operation_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const events: OperationLog["events"] = (options = {}) => {
    const after = options.afterSeq ?? 0, limit = options.limit ?? -1;
    const rows = options.operationId === undefined ? select.all(after, limit) : selectOperation.all(options.operationId, after, limit);
    return (rows as EventRow[]).map((row) => ({
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
  const kindIds = db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
    AND json_extract(data, '$.kind') = ? AND json_extract(data, '$.repo') = ? ORDER BY seq DESC`);
  const landed = db.prepare(`SELECT landed.at, landed.data FROM events landed
    JOIN events submitted ON submitted.operation_id = landed.operation_id AND submitted.type = 'submitted'
    WHERE landed.type = 'landed' AND json_extract(submitted.data, '$.repo') = ? ORDER BY landed.seq DESC LIMIT 1`);
  const landings = db.prepare(`SELECT landed.operation_id, landed.at, landed.data, json_extract(submitted.data, '$.changeId') AS change_id FROM events landed
    JOIN events submitted ON submitted.operation_id = landed.operation_id AND submitted.type = 'submitted'
    WHERE landed.type = 'landed' AND json_extract(submitted.data, '$.repo') = ? ORDER BY landed.seq`);
  const gateCandidates = (type: "verification_passed" | "verification_skipped") =>
    new Set((db.prepare("SELECT json_extract(data, '$.candidate') AS candidate FROM events WHERE type = ?").all(type) as { candidate: string }[]).map((row) => row.candidate));
  /** The commits a repository's landings published, each with whether the landing checks passed on it, or were skipped for a settings landing. */
  function publishedLandings(repo: string): PublishedLanding[] {
    const rows = landings.all(repo) as { operation_id: string; at: string; data: string; change_id: string }[];
    if (!rows.length) return [];
    const passed = gateCandidates("verification_passed"), skipped = gateCandidates("verification_skipped");
    return rows.flatMap((row) => {
      const event = JSON.parse(row.data) as OperationEvent;
      if (event.type !== "landed") return [];
      return [{ operationId: row.operation_id, changeId: row.change_id, commitId: event.commitId, base: event.base, at: row.at,
        gate: skipped.has(event.commitId) ? "skipped" as const : passed.has(event.commitId) ? "green" as const : "none" as const }];
    });
  }
  const control = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE operation_id = ? AND type IN ('paused', 'resumed') ORDER BY seq DESC LIMIT 1`);
  function paused(): { by: string; at: string } | null {
    const row = control.get(RUNNER_CONTROL_ID) as EventRow | undefined;
    const event = row ? JSON.parse(row.data) as OperationEvent : undefined;
    return row && event?.type === "paused" ? { by: event.by, at: row.at } : null;
  }
  const projectIds = (ids: string[]): Operation[] =>
    ids.flatMap((id) => { const operation = project(id, events({ operationId: id })); return operation ? [operation] : []; });
  // Lanes in submission order: each repository lane's landings with its resets, its release
  // lane, and deploys. Queued work names the lane's running operation, or what else holds
  // it: a release publishing in its repository lane, and a release and a reset of one
  // repository, which never overlap. With none, the lane's first queued operation, while
  // every worker is busy, names the operations holding them.
  function queue(): Operation[] {
    const open = projectIds((openIds.all() as { operation_id: string }[]).map((row) => row.operation_id));
    const held = paused() !== null;
    // Until Build admits it, a Build-bound landing holds no place in any lane.
    for (const operation of open) if (operation.kind === "landing" && operation.admission === "pending" && operation.status === "queued") operation.waitingFor = "Build admission";
    // Nor does a candidate Build may yet replace with a newer one.
    const replaced = open.filter((operation) => awaitingReplacement(operation, open));
    for (const operation of replaced) operation.waitingFor = "Build admission of a newer candidate";
    const serial = open.filter((operation) => operation.kind !== "deploy" && !(operation.kind === "landing" && operation.admission === "pending") && !replaced.includes(operation));
    const busy = serial.filter((operation) => operation.status === "running");
    const admittedTo = (operation: Operation) => admissionLane(lane(operation.repo), operation.repo, operation.kind);
    const holding = (first: Operation | undefined) => first && first.kind !== "deploy" ? busy.find((operation) => lane(operation.repo) === lane(first.repo) && (
      first.kind === "release" ? operation.kind === "reset"
        : operation.kind === "release" && (first.kind === "reset" || operation.stage === "publishing" || operation.stage === "finalizing"))) : undefined;
    const lanes = [...new Set(serial.map(admittedTo))].map((key) => serial.filter((operation) => admittedTo(operation) === key));
    const shortPlace = shortLandingP90Ms !== undefined;
    const places = busy.map((operation) => ({ short: Boolean(operation.shortLanding) }));
    /** The queued operations the rule finds no place for. */
    const placeless = new Set<Operation>();
    // The places that keep `operation` from starting, by the queue's rule; none when it has one.
    const capacity = (operation: Operation, successor: boolean): string | undefined => {
      const short = shortPlace && operation.kind === "landing" && !successor && shortRepository(operation.repo);
      if (admits(short, places, workers, shortPlace)) return undefined;
      const long = busy.filter((entry) => !entry.shortLanding);
      return !short && long.length >= workers ? `a worker (${long.map(label).join(", ")})` : `every place (${busy.map(label).join(", ")})`;
    };
    for (const entries of [...lanes, open.filter((operation) => operation.kind === "deploy")]) {
      const running = entries.find((operation) => operation.status === "running") ?? holding(entries[0]);
      entries.forEach((operation, index) => {
        operation.position = index + 1;
        if (operation.status !== "queued") return;
        if (held) operation.stage = "paused";
        // A depth-two landing verifies beside the one landing its repository runs, when a place is free.
        const turn = index === 1 && running !== undefined && entries[0] === running && running.kind === "landing" && operation.kind === "landing" && depth(operation.repo) === 2;
        // As the queue does, an older reset, release or audit of its repository fences a depth-two head and successor.
        const fence = (turn || index === 0 && operation.kind === "landing" && depth(operation.repo) === 2) ? open.slice(0, open.indexOf(operation)).find((other) => repositoryKey(other.repo) === repositoryKey(operation.repo)
          && other.kind !== "landing" && other.kind !== "deploy" && other.kind !== "verification") : undefined;
        const successor = turn && !fence;
        if (fence) operation.waitingFor = label(fence);
        else if (running && !successor) operation.waitingFor = label(running);
        else if (operation.kind !== "deploy" && (index === 0 || successor)) {
          const places = capacity(operation, successor);
          if (places) placeless.add(operation);
          operation.waitingFor = places ?? (running ? label(running) : undefined);
        }
      });
    }
    // Nothing passes older work of its repository lane that waits for a place, as the queue admits.
    const waitingForPlace = new Map<string, Operation>();
    for (const operation of serial) {
      if (operation.status !== "queued" || operation.kind === "verification") continue;
      const older = waitingForPlace.get(lane(operation.repo));
      if (older && (operation.waitingFor === undefined || placeless.has(operation))) operation.waitingFor = label(older);
      else if (placeless.has(operation)) waitingForPlace.set(lane(operation.repo), operation);
    }
    // A pre-verification waits behind any other work of its repository lane, then for staging to catch up.
    for (const operation of serial) if (operation.kind === "verification" && operation.status === "queued") {
      const ahead = serial.find((other) => other.kind !== "verification" && lane(other.repo) === lane(operation.repo));
      if (ahead) operation.waitingFor = label(ahead);
      else if (stagingDue(operation.repo)) operation.waitingFor = "a staging deploy of the latest landing";
    }
    return open;
  }
  function lastLanded(repo: string): { commitId: string; at: string } | null {
    const row = landed.get(repo) as { at: string; data: string } | undefined;
    const event = row ? JSON.parse(row.data) as OperationEvent : undefined;
    return row && event?.type === "landed" ? { commitId: event.commitId, at: row.at } : null;
  }
  const eventsSince = db.prepare("SELECT seq, operation_id, at, data FROM events WHERE at >= ? ORDER BY seq");
  let shortClasses: { at: number; short: Set<string> } | undefined;
  function shortRepository(repo: string): boolean {
    if (shortLandingP90Ms === undefined) return false;
    const now = Date.now();
    if (!shortClasses || now - shortClasses.at > SHORT_CLASS_REFRESH_MS) {
      // The window counts landings submitted in it, so no earlier event bears on it.
      const recent = (eventsSince.all(new Date(now - BUDGET_WINDOW_MS).toISOString()) as EventRow[]).map((row) => ({
        seq: row.seq, operationId: row.operation_id, at: row.at, event: JSON.parse(row.data) as OperationEvent }));
      const verify = pipelineMetrics(recent, new Date(now).toISOString(), { now }).repositories;
      shortClasses = { at: now, short: new Set(verify.filter((entry) => entry.verify && entry.verify.samples >= BUDGET_MIN_SAMPLES
        && entry.verify.p90Ms <= shortLandingP90Ms).map((entry) => repositoryKey(entry.repo))) };
    }
    return shortClasses.short.has(repositoryKey(repo));
  }
  function stagingDue(repo: string): boolean {
    const latest = lastLanded(repo);
    return latest !== null && !projectIds((deployIds.all(repo, "staging", "staging") as { operation_id: string }[]).map((row) => row.operation_id))
      .some((entry) => entry.commitId === latest.commitId && entry.result !== undefined);
  }
  /** The lane an operation queues in: its admission lane, or the deploys. */
  const laneOf = (operation: Operation) => queue().filter((entry) => entry.kind === "deploy" ? operation.kind === "deploy"
    : operation.kind !== "deploy" && admissionLane(lane(entry.repo), entry.repo, entry.kind) === admissionLane(lane(operation.repo), operation.repo, operation.kind));
  // An open operation carries its queue fields; a closed one is its bare projection.
  function placed<T extends Operation>(projected: T, open: Operation[]): T {
    return (open.find((entry) => entry.id === projected.id) as T | undefined) ?? projected;
  }
  function ofKind<K extends "release" | "verification" | "reset" | "audit">(repo: string, kind: K): Extract<ReleaseOperation | VerificationOperation | ResetOperation | AuditOperation, { kind: K }>[] {
    const open = queue();
    return projectIds((kindIds.all(kind, repo) as { operation_id: string }[]).map((row) => row.operation_id))
      .filter((entry): entry is Extract<ReleaseOperation | VerificationOperation | ResetOperation | AuditOperation, { kind: K }> => entry.kind === kind)
      .map((entry) => placed(entry, open));
  }
  function operation(id: string): Operation | null {
    const projected = project(id, events({ operationId: id }));
    return projected ? placed(projected, queue()) : null;
  }
  const snapshotRows = db.prepare(`SELECT seq, operation_id, at, data FROM events WHERE operation_id IN (
    SELECT operation_id FROM events WHERE type = 'submitted' ORDER BY seq DESC LIMIT 100
  ) OR operation_id IN (SELECT operation_id FROM events WHERE type = 'submitted'
    AND operation_id NOT IN (SELECT operation_id FROM events WHERE type IN ${terminalTypes})) ORDER BY seq`);
  const heldRows = db.prepare(`WITH latest AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY json_extract(data, '$.repo') ORDER BY seq DESC) AS rank
    FROM events WHERE type = 'integration_held'
  ) SELECT h.seq, h.at, h.data,
    (SELECT MAX(b.seq) FROM events b WHERE b.seq < h.seq
      AND b.type IN ('integration_held', 'integration_recovered', 'integration_released')
      AND json_extract(b.data, '$.repo') = json_extract(h.data, '$.repo')
      AND ((b.type = 'integration_held' AND json_extract(b.data, '$.commitId') != json_extract(h.data, '$.commitId')) OR (b.type != 'integration_held' AND json_extract(b.data, '$.commitId') = json_extract(h.data, '$.commitId')))) AS boundary
    FROM latest h WHERE h.rank = 1 AND NOT EXISTS (SELECT 1 FROM events r WHERE r.type IN ('integration_recovered', 'integration_released') AND r.seq > h.seq AND json_extract(r.data, '$.repo') = json_extract(h.data, '$.repo') AND json_extract(r.data, '$.commitId') = json_extract(h.data, '$.commitId'))`);
  const heldHistory = db.prepare(`SELECT MIN(at) AS since, COUNT(*) - 1 AS retries FROM events
    WHERE type = 'integration_held' AND seq > ? AND seq <= ?
    AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.commitId') = ?`);
  function held(): HeldIntegrationState[] {
    return (heldRows.all() as { seq: number; at: string; data: string; boundary: number | null }[]).map((row) => {
      const event = JSON.parse(row.data) as Extract<OperationEvent, { type: 'integration_held' }>;
      const history = heldHistory.get(row.boundary ?? 0, row.seq, event.repo, event.commitId) as { since: string; retries: number };
      return { repo: event.repo, commitId: event.commitId, reason: event.reason, ...history };
    });
  }
  function append(operationId: string, event: OperationEvent): StoredEvent {
      if (event.type === "integration_held" || event.type === "integration_recovered") {
        const history = events().filter((row) => (row.event.type === "integration_held" || row.event.type === "integration_recovered") && row.event.repo === event.repo && row.event.commitId === event.commitId);
        const boundary = history.findLastIndex((row) => row.event.type === "integration_recovered");
        const holds = history.slice(boundary + 1).filter((row) => row.event.type === "integration_held");
        const since = holds[0]?.at ?? new Date().toISOString();
        const retries = event.type === "integration_held" ? holds.length : Math.max(0, holds.length - 1) + (event.retried ? 1 : 0);
        append(operationId, { type: "held", repo: event.repo, commitId: event.commitId, retries, durationMs: Math.max(0, Date.now() - Date.parse(since)), published: event.type === "integration_recovered" });
      }
      if (event.type === "client") {
        const duplicate = events({ operationId }).find((row) => row.event.type === "client" && row.event.id === event.id);
        if (duplicate) return duplicate;
      }
      if (["failed", "declined", "cancelled", "superseded"].includes(event.type)) {
        const history = events({ operationId });
        const current = operation(operationId);
        const context = { paused: paused() !== null, held: history.some((row) => row.event.type === "integrated" || row.event.type === "integration_held") };
        const withBody = (entry: RunRecord) => {
          const done = history.findLast((row) => row.event.type === "run_finished" && row.event.runId === entry.runId)?.event;
          return { ...entry, ...(done?.type === "run_finished" ? { testBodyRan: done.testBodyRan } : {}) };
        };
        // Several failed checks classify one by one, each from the run its `runId` names; otherwise one run by command.
        const classification = event.type === "failed" && event.failures?.length
          ? classifyVerificationFailures(event, context, event.failures.map((failure) => {
            const found = failure.runId ? current?.runs.find((entry) => entry.runId === failure.runId) : undefined;
            return { failure, ...(found ? { run: withBody(found) } : {}) };
          }))
          : (() => {
            const run = current?.runs.findLast((entry) => event.type === "failed" && entry.command === event.command) ?? current?.runs.at(-1);
            return classifyFailure(event as Extract<OperationEvent, { type: "failed" | "declined" | "cancelled" | "superseded" }>, { ...context, ...(run ? { run: withBody(run) } : {}) });
          })();
        if (classification.cause === "gate" && current?.kind === "landing") {
          const base = history.findLast((row) => row.event.type === "verification_base")?.event;
          for (const earlier of projectIds((changeIds.all(current.repo, current.changeId) as { operation_id: string }[]).map((row) => row.operation_id))) {
            if (earlier.id === operationId || earlier.submittedAt > current.submittedAt) continue;
            const old = events({ operationId: earlier.id });
            const oldBase = old.findLast((row) => row.event.type === "verification_base")?.event;
            const passed = earlier.status === "landed" || old.some((row) => row.event.type === "verification_passed");
            if (passed && base?.type === "verification_base" && oldBase?.type === "verification_base" && base.base !== oldBase.base && earlier.commitId === current.commitId) {
              classification.interaction = { earlierOperation: earlier.id, fromBase: oldBase.base, toBase: base.base };
              break;
            }
          }
        }
        append(operationId, classification);
      }
      const at = new Date().toISOString();
      const data = JSON.stringify(event);
      const result = insert.run(operationId, at, event.type, data);
      const stored = { seq: Number(result.lastInsertRowid), operationId, at, event: JSON.parse(data) as OperationEvent };
      // A finished operation may be a new verify sample.
      if ((TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)) shortClasses = undefined;
      for (const listener of [...listeners]) listener(stored);
      if (event.type === "submitted") {
        const current = operation(operationId)!;
        const lane = laneOf(current);
        append(operationId, { type: "queue_snapshot", position: current.position ?? 1, depth: lane.length, waitingFor: current.waitingFor ?? (lane.at(-2)?.id ?? null), paused: paused() !== null });
      }
      return stored;
  }
  const log: OperationLog = {
    append,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    latestSeq: () => Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq),
    snapshot(runner, now = new Date()) {
      db.exec("BEGIN");
      try {
        const seq = Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq);
        const all = (snapshotRows.all() as EventRow[]).map((row): StoredEvent => ({ seq: row.seq, operationId: row.operation_id, at: row.at, event: JSON.parse(row.data) as OperationEvent }));
        const open = queue().map((op) => projectWatchOperation(op, all, now));
        const repos = (db.prepare("SELECT DISTINCT json_extract(data, '$.repo') AS repo FROM events WHERE type = 'submitted'").all() as { repo: string }[]).map((row) => row.repo);
        return { version: 1, runner, seq, observedAt: now.toISOString(),
          lanes: { serial: open.filter((op) => op.kind !== "deploy"), deploy: open.filter((op) => op.kind === "deploy") },
          paused: paused(), held: held(),
          recentReleases: projectIds((db.prepare("SELECT operation_id FROM events WHERE type = 'submitted' AND json_extract(data, '$.kind') = 'release' ORDER BY seq DESC LIMIT 10").all() as { operation_id: string }[]).map((row) => row.operation_id)).filter((op): op is ReleaseOperation => op.kind === "release").sort((a, b) => b.lastSeq - a.lastSeq).slice(0, 10).map(withoutRuns),
          recentProductionDeploys: projectIds((db.prepare("SELECT operation_id FROM events WHERE type = 'submitted' AND json_extract(data, '$.kind') = 'deploy' AND json_extract(data, '$.environment') = 'production' ORDER BY seq DESC LIMIT 10").all() as { operation_id: string }[]).map((row) => row.operation_id)).filter((op): op is DeployOperation => op.kind === "deploy").map(withoutRuns),
          lastStagingDeploys: repos.flatMap((repo) => { const latest = projectIds((db.prepare(`SELECT e.operation_id FROM events e WHERE e.type = 'submitted' AND json_extract(e.data, '$.kind') = 'deploy' AND json_extract(e.data, '$.repo') = ? AND json_extract(e.data, '$.environment') = 'staging' AND EXISTS (SELECT 1 FROM events d WHERE d.operation_id = e.operation_id AND d.type IN ${terminalTypes}) ORDER BY e.seq DESC LIMIT 1`).all(repo) as { operation_id: string }[]).map((row) => row.operation_id)).find((op) => op.kind === "deploy"); return latest?.kind === "deploy" ? [withoutRuns(latest)] : []; }),
          lastSuite: { status: "unavailable" }, build: deliveryState(log) };
      } finally { db.exec("COMMIT"); }
    },
    events,
    operation,
    submission(repo, requestId) {
      const row = db.prepare("SELECT operation_id, data FROM events WHERE type = 'submission_request' AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.requestId') = ? ORDER BY seq LIMIT 1").get(repo, requestId) as { operation_id: string; data: string } | undefined;
      if (!row) return null;
      const current = operation(row.operation_id);
      if (current?.kind !== "landing") throw new Error("Submission request lost its landing operation");
      return { operation: current, request: JSON.parse(row.data) as Extract<OperationEvent, { type: "submission_request" }> };
    },
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
    releases: (repo) => ofKind(repo, "release"),
    verifications: (repo) => ofKind(repo, "verification"),
    resets: (repo) => ofKind(repo, "reset"),
    audits: (repo) => ofKind(repo, "audit"),
    landings: publishedLandings,
    lastLanded,
    shortRepository,
    stagingDue,
    paused,
    held,
    buildBound: () => (db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
      AND (json_extract(data, '$.admission') IS NOT NULL OR json_extract(data, '$.chore') IS NOT NULL) ORDER BY seq`).all() as { operation_id: string }[])
      .flatMap(({ operation_id: id }) => { const history = events({ operationId: id }); const operation = project(id, history);
        return operation?.kind === "landing" ? [{ operation, history }] : []; }),
    publicationRecoveries: () => {
      const recoveries = new Map<string, StoredEvent[]>();
      for (const row of db.prepare("SELECT seq, operation_id, at, data FROM events WHERE type = 'integration_recovered' ORDER BY seq").all() as EventRow[]) {
        const event = JSON.parse(row.data) as OperationEvent;
        if (event.type !== "integration_recovered") continue;
        const key = recoveryKey(event.repo, event.commitId);
        recoveries.set(key, [...recoveries.get(key) ?? [], { seq: row.seq, operationId: row.operation_id, at: row.at, event }]);
      }
      return recoveries;
    },
    close: () => { listeners.clear(); db.close(); },
  };
  return log;
}

/** A finished operation as the snapshot's history shows it: its result without its runs' evidence. */
const withoutRuns = <T extends Operation>({ runs: _runs, ...rest }: T): Omit<T, "runs"> => rest;

/** How a queued operation names the one running ahead of it. */
export const label = (operation: Operation): string =>
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
      ? { ...fields, kind: "deploy", environment: submitted.event.environment, ...submitted.event.promotion ? { promotion: submitted.event.promotion } : {} }
      : submitted.event.kind === "reset" ? { ...fields, kind: "reset" }
      : submitted.event.kind === "recovery" ? { ...fields, kind: "recovery" }
      : submitted.event.kind === "verification" ? { ...fields, kind: "verification" }
      : submitted.event.kind === "audit" ? { ...fields, kind: "audit", slot: submitted.event.slot }
      : { ...fields, kind: "landing", changeId: submitted.event.changeId, bookmark: submitted.event.bookmark, ...submitted.event.admission ? { admission: "pending" } : {} };
  const runs = new Map<string, RunRecord>();
  for (const stored of events) {
    const event = stored.event;
    switch (event.type) {
      case "stage":
        operation.stage = event.stage;
        if (event.shortLanding) operation.shortLanding = true;
        if (event.stage !== "queued") operation.startedAt ??= stored.at;
        if (event.stage !== "queued" && !operation.result)
          operation.status = "running";
        break;
      case "run_started": {
        const run: RunRecord = { runId: event.runId, command: event.command, host: event.host, startedAt: stored.at, ...(event.timeoutMs === undefined ? {} : { timeoutMs: event.timeoutMs }), ...(event.purpose ? { purpose: event.purpose } : {}), ...(event.attempt ? { attempt: event.attempt } : {}), ...(event.commandEvidence ? { commandEvidence: event.commandEvidence } : {}) };
        runs.set(event.runId, run);
        operation.runs.push(run);
        break;
      }
      case "run_finished": {
        const run = runs.get(event.runId);
        if (run) {
          const { type: _type, runId: _runId, ...details } = event;
          Object.assign(run, { finishedAt: stored.at, ...details });
        }
        break;
      }
      case "test_report": {
        const run = runs.get(event.runId);
        if (run) {
          const { type: _type, runId: _runId, ...report } = event;
          run.testReport = report;
        }
        break;
      }
      case "yielded":
        operation.status = "queued";
        operation.stage = "queued";
        break;
      case "build_admitted":
        if (operation.kind === "landing") operation.admission = "admitted";
        break;
      case "audit_head":
        if (operation.kind === "audit") operation.head = event.commit;
        break;
      case "audit_cause":
        if (operation.kind === "audit") operation.cause = { cause: event.cause, by: event.by, at: stored.at, ...event.note ? { note: event.note } : {} };
        break;
      case "landed":
      case "released":
      case "verified":
      case "deployed":
      case "reset":
      case "audited":
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
  if (operation.kind === "landing") operation.outcome = landingOutcome(operation, events);
  return operation;
}
