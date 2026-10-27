import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { admissionLane, admits, awaitingReplacement, recoveryKey, RECEIPT_KEY_EVENT_TYPES, RECEIPT_SETTLEMENT_EVENT_TYPES, repositoryKey, RUNNER_CONTROL_ID, RUNNER_DEFAULT_WORKERS, RUNNER_DEFAULT_DEPLOY_WORKERS, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { AuditOperation, DeployOperation, HeldIntegrationState, LandingOperation, Operation, OperationEvent, OperationLog, OperationLogProjections, PublishedLanding, ReleaseOperation, ResetOperation, RunRecord, StoredEvent, VerificationOperation, WatchOperation } from "./runner-types.ts";

export function newOperationId(): string {
  return `op_${Date.now().toString(36).padStart(10, "0")}_${randomBytes(12).toString("hex")}`;
}

type EventRow = { seq: number; operation_id: string; at: string; data: string };

/** How long a repository's short-landing class stands before the sliding budget window is read again. */
const SHORT_CLASS_REFRESH_MS = 600_000;

/** What the queue admits by, so a queued operation names what it really waits for: `runnerLogOptions` derives it from the runner config. */
export type OperationLogOptions = {
  workers?: number; deployWorkers?: number; separateDeploys?: boolean; lane?: (repo: string) => string; depth?: (repo: string) => 1 | 2;
  /** The verify-stage p90 at or below which a repository's landings are short; absent, there is no short place. */
  shortLandingP90Ms?: number;
};

/**
 * How long the live ledger keeps all of a closed operation's events before only its lasting facts remain:
 * longer than the evidence windows, so nothing those windows still explain is forgotten first.
 */
export const LEDGER_HISTORY_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * How long the lasting facts themselves stay: a year, past every window in which something reads them (evidence,
 * repair claims, a resubmission, an audit, a landing an operation is reconciled against). Without this the ledger would
 * keep every fact it ever recorded, so each pass over them, and the ledger itself, would grow with the runner's age.
 */
export const LEDGER_FACT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The events a read across operations needs however old their operation is: what identifies it, what it
 * concluded and published, the holds, published commits and settlements another landing is reconciled
 * against, gate verdicts, audits, repair claims, delivery to Build, a submission's dedupe key, and the
 * evidence expiry a later pass reads. Everything else an operation recorded — its runs, stages, test
 * reports, progress and client traffic — explains what happened, and nothing reads it once the window ends.
 * `source_retained` is not here: it names files, and a pass drops it once its attempt is recorded expired,
 * so a scan for retained evidence stays bounded by the window instead of growing with every submission ever.
 */
const LASTING_EVENTS: ReadonlySet<OperationEvent["type"]> = new Set<OperationEvent["type"]>([
  ...TERMINAL_EVENT_TYPES, "submitted", "identity", "classified", "integrated", "publication_intent", "held",
  "integration_held", "integration_recovered", "integration_released", "verification_passed", "verification_skipped",
  "attempt_prepared", "attempt_invalidated", "audit_head", "audit_cause", "repair_claimed", "repair_released",
  "build_admitted", "build_receipt", "evidence_expired", "submission_request"]);

/**
 * Open the append-only ledger. `projections` are the interpretations its callers report: classification on
 * append, a landing's outcome, snapshot watch timing, Build's delivery state and short-landing classes. The
 * store imports none of them; a runner composes the ones it reports (see `runner-service`), and a caller that
 * reads only the ledger gets the bare facts.
 */
export function openOperationLog(path: string, { workers = RUNNER_DEFAULT_WORKERS, deployWorkers = RUNNER_DEFAULT_DEPLOY_WORKERS, separateDeploys = true, lane = (repo: string) => repo, depth = () => 1, shortLandingP90Ms }: OperationLogOptions = {}, projections: OperationLogProjections = {}): OperationLog {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    // A checkpoint returns the WAL to the pages still in use, but only truncates it within this limit; without
    // one it stays at its high-water mark forever, which is how a 18 MB ledger carried a 105 MB journal.
    db.exec("PRAGMA journal_size_limit = 16777216");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS events_operation_id ON events(operation_id); CREATE INDEX IF NOT EXISTS events_type ON events(type); CREATE INDEX IF NOT EXISTS events_at ON events(at);
    CREATE UNIQUE INDEX IF NOT EXISTS events_submission_request ON events(json_extract(data, '$.repo'), json_extract(data, '$.requestId')) WHERE type = 'submission_request';
    -- Keyed by the fact each read looks up, not by repository: a repository-first key also matches the landings join's
    -- repository predicate, and SQLite then prefers it to the exact operation id, which is far slower.
    CREATE INDEX IF NOT EXISTS events_change_key ON events(json_extract(data, '$.changeId')) WHERE type = 'submitted';
    CREATE INDEX IF NOT EXISTS events_kind_key ON events(json_extract(data, '$.kind')) WHERE type = 'submitted';
    -- A receipt is settled by the build_receipt naming its key event's sequence; without this, every owed-receipt read
    -- scans an operation's events for one.
    CREATE INDEX IF NOT EXISTS events_receipt_settled ON events(json_extract(data, '$.sequence')) WHERE type = 'build_receipt';
    -- An integration, and the settlement that reconciles it, are matched by commit; without this the match is a scan, and
    -- an integrated event names no repository of its own.
    CREATE INDEX IF NOT EXISTS events_integration ON events(json_extract(data, '$.commitId'))
      WHERE type IN ('integrated', 'integration_held', 'integration_recovered', 'integration_released')`);
  const listeners = new Set<(event: StoredEvent) => void>();
  const insert = db.prepare("INSERT INTO events (operation_id, at, type, data) VALUES (?, ?, ?, ?)");
  // Separate statements: an `OR operation_id = ?` would hide the index and scan the whole ledger per operation.
  const select = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE seq > ? ORDER BY seq LIMIT ?`);
  const selectOperation = db.prepare(`SELECT seq, operation_id, at, data FROM events
    WHERE operation_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events");
  const latestSeq = () => Number((maxSeq.get() as { seq: number }).seq);
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
    ids.flatMap((id) => { const operation = project(id, events({ operationId: id }), projections); return operation ? [operation] : []; });
  // Lanes in submission order: each repository lane's landings with its resets, its release
  // lane, and deploys. Queued work names the lane's running operation, or what else holds
  // it: a release publishing in its repository lane, and a release and a reset of one
  // repository, which never overlap. With none, the lane's first queued operation, while
  // every worker is busy, names the operations holding them.
  // Projected once per ledger revision: a read that asks per operation (retention, an outcome) would otherwise
  // re-read every open operation, and the whole ledger under them, once for each of them.
  let projection: { seq: number; open: Operation[] } | undefined;
  function queue(): Operation[] {
    const seq = latestSeq();
    if (projection?.seq === seq) return projection.open;
    const open = projectQueue();
    projection = { seq, open };
    return open;
  }
  function projectQueue(): Operation[] {
    const open = projectIds((openIds.all() as { operation_id: string }[]).map((row) => row.operation_id));
    const held = paused() !== null;
    // Until Build admits it, a Build-bound landing holds no place in any lane.
    for (const operation of open) if (operation.kind === "landing" && operation.admission === "pending" && operation.status === "queued") operation.waitingFor = operation.admissionUnavailable ? `Build admission: ${operation.admissionUnavailable.reason}` : "Build admission";
    // Nor does a candidate Build may yet replace with a newer one.
    const replaced = open.filter((operation) => awaitingReplacement(operation, open));
    for (const operation of replaced) operation.waitingFor = "Build admission of a newer candidate";
    const serial = open.filter((operation) => operation.kind !== "deploy" && !(operation.kind === "landing" && operation.admission === "pending") && !replaced.includes(operation));
    const deploys = open.filter((operation) => operation.kind === "deploy");
    const runningDeploys = deploys.filter((operation) => operation.status === "running");
    const runningAudits = serial.filter((operation) => operation.kind === "audit" && operation.status === "running");
    const busy = (separateDeploys ? serial : open).filter((operation) => operation.status === "running");
    const admittedTo = (operation: Operation) => admissionLane(lane(operation.repo), operation.repo, operation.kind);
    const holding = (first: Operation | undefined) => first && first.kind !== "deploy" ? busy.find((operation) => lane(operation.repo) === lane(first.repo) && (
      first.kind === "release" || first.kind === "verification" ? operation.kind === "reset"
        : (operation.kind === "release" || operation.kind === "verification") && (first.kind === "reset" || operation.stage === "publishing" || operation.stage === "finalizing"))) : undefined;
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
    for (const operation of deploys) {
      operation.position = deploys.indexOf(operation) + 1;
      if (operation.status !== "queued") continue;
      if (held) operation.stage = "paused";
      const same = runningDeploys.find((other) => repositoryKey(other.repo) === repositoryKey(operation.repo));
      // As the queue admits, no deploy starts beside a running audit.
      const blockers = same ? [same] : runningAudits.length ? runningAudits : runningDeploys.length >= deployWorkers ? runningDeploys : !separateDeploys ? busy : [];
      if (blockers.length) operation.waitingFor = blockers.map(label).join(", ");
    }
    for (const entries of lanes) {
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
    // As the queue admits, an audit that could otherwise start waits for every running deploy, without holding its lane;
    // the queue reads its own admitted deploys, which this ledger shows as running once their first stage is recorded.
    for (const operation of serial) if (operation.kind === "audit" && operation.status === "queued" && operation.waitingFor === undefined && runningDeploys.length)
      operation.waitingFor = runningDeploys.map(label).join(", ");
    // Nothing passes older work of its repository lane that waits for a place, as the queue admits.
    const waitingForPlace = new Map<string, Operation>();
    for (const operation of serial) {
      if (operation.status !== "queued" || operation.kind === "verification") continue;
      const older = waitingForPlace.get(lane(operation.repo));
      if (older && (operation.waitingFor === undefined || placeless.has(operation))) operation.waitingFor = label(older);
      else if (placeless.has(operation)) waitingForPlace.set(lane(operation.repo), operation);
    }
    // A pre-verification waits for staging to catch up with the latest landing, then for a place like any other operation.
    for (const operation of serial) if (operation.kind === "verification" && operation.status === "queued" && stagingDue(operation.repo))
      operation.waitingFor = "a staging deploy of the latest landing";
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
    if (shortLandingP90Ms === undefined || !projections.shortRepositories) return false;
    const now = Date.now();
    if (!shortClasses || now - shortClasses.at > SHORT_CLASS_REFRESH_MS) {
      // The window counts landings submitted in it, so no earlier event bears on it.
      const read = (since: Date): StoredEvent[] => (eventsSince.all(since.toISOString()) as EventRow[]).map((row) => ({
        seq: row.seq, operationId: row.operation_id, at: row.at, event: JSON.parse(row.data) as OperationEvent }));
      shortClasses = { at: now, short: new Set(projections.shortRepositories(read, new Date(now), shortLandingP90Ms)) };
    }
    return shortClasses.short.has(repositoryKey(repo));
  }
  function stagingDue(repo: string): boolean {
    const latest = lastLanded(repo);
    // A landing that declares no staging (a development-mode repository's) has no staging deploy to wait for.
    if (latest === null) return false;
    const declared = (JSON.parse((landed.get(repo) as { data: string }).data) as { declaredEnvironments?: string[] }).declaredEnvironments;
    if (declared && !declared.includes("staging")) return false;
    return !projectIds((deployIds.all(repo, "staging", "staging") as { operation_id: string }[]).map((row) => row.operation_id))
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
    const projected = project(id, events({ operationId: id }), projections);
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
  const heldHistory = db.prepare(`SELECT MIN(at) AS since, COUNT(*) - 1 AS retries, MAX(CASE WHEN json_extract(data, '$.targetReached') = 0 THEN 0 ELSE 1 END) AS targetReached FROM events
    WHERE type = 'integration_held' AND seq > ? AND seq <= ?
    AND json_extract(data, '$.repo') = ? AND json_extract(data, '$.commitId') = ?`);
  function held(): HeldIntegrationState[] {
    return (heldRows.all() as { seq: number; at: string; data: string; boundary: number | null }[]).map((row) => {
      const event = JSON.parse(row.data) as Extract<OperationEvent, { type: 'integration_held' }>;
      const history = heldHistory.get(row.boundary ?? 0, row.seq, event.repo, event.commitId) as { since: string; retries: number; targetReached: number };
      return { repo: event.repo, commitId: event.commitId, reason: event.reason, ...(event.branch ? { branch: event.branch } : {}), ...(event.remote ? { remote: event.remote } : {}), ...history, targetReached: history.targetReached !== 0 };
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
        // The caller's classifier derives the recorded cause from the event, its run context and the operation's history.
        const classification = projections.classify?.({ event: event as Extract<OperationEvent, { type: "failed" | "declined" | "cancelled" | "superseded" }>,
          operation: current, history, ...context });
        // A gate failure on a base that moved since an earlier passing attempt of the same commit names that interaction:
        // only this history knows it, so it stays with the store.
        if (classification && classification.cause === "gate" && current?.kind === "landing") {
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
        if (classification) append(operationId, classification);
      }
      const at = new Date().toISOString();
      const data = JSON.stringify(event);
      // The cached queue is stale only when this event could change an open operation or the placement of one;
      // a retention pass appends to closed operations while it reads, and must not pay for the queue each time.
      const touchesOpen = projection?.open.some((entry) => entry.id === operationId) ?? false;
      const result = insert.run(operationId, at, event.type, data);
      const stored = { seq: Number(result.lastInsertRowid), operationId, at, event: JSON.parse(data) as OperationEvent };
      // A finished operation may be a new verify sample.
      if ((TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)) shortClasses = undefined;
      if (projection && (touchesOpen || event.type === "submitted" || event.type === "paused" || event.type === "resumed")) projection = undefined;
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
    latestSeq,
    retainedEvidence: () => (db.prepare("SELECT DISTINCT operation_id FROM events WHERE type = 'source_retained' OR type = 'run_finished' AND json_extract(data, '$.artifact.status') = 'retained'").all() as { operation_id: string }[])
      .map((row) => row.operation_id),
    checkpoint: () => {
      // A reader holding a snapshot keeps the WAL from truncating; the next pass gets it instead.
      try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* left for the next pass */ }
    },
    unsettledReceipts: () => {
      const types = (list: readonly string[]) => list.map((type) => `'${type}'`).join(",");
      // Only a Build-bound attempt owes a receipt, and a receipt is identified by the attempt and the sequence it answers:
      // one of the attempt's own keys, or a settlement of the commit it integrated or held. These reads take columns only,
      // so a pass costs a scan of the key events rather than a parse of every payload behind them.
      const bound = new Set((db.prepare(`SELECT operation_id FROM events WHERE type = 'submitted'
        AND (json_extract(data, '$.admission') IS NOT NULL OR json_extract(data, '$.chore') IS NOT NULL)`).all() as { operation_id: string }[])
        .map((row) => row.operation_id));
      const settled = (operation: string, sequence: number) => latest.get(`${operation}\n${sequence}`) === true;
      // The latest settlement of each receipt stands: one an operator requeued is owed again.
      const latest = new Map<string, boolean>();
      for (const row of db.prepare("SELECT operation_id, json_extract(data, '$.sequence') AS sequence, json_extract(data, '$.state') AS state FROM events WHERE type = 'build_receipt' ORDER BY seq").all() as
        { operation_id: string; sequence: number; state: string }[]) latest.set(`${row.operation_id}\n${row.sequence}`, row.state !== "requeued");
      const ids = new Set<string>();
      for (const row of db.prepare(`SELECT operation_id, seq FROM events WHERE type IN (${types(RECEIPT_KEY_EVENT_TYPES)})`).all() as { operation_id: string; seq: number }[])
        if (bound.has(row.operation_id) && !settled(row.operation_id, row.seq)) ids.add(row.operation_id);
      // A settlement is matched to the attempt it reconciles by commit — an `integrated` event names its commit, and its
      // repository only through the submission — and an index keeps that lookup off a scan.
      const attempts = db.prepare("SELECT DISTINCT operation_id FROM events WHERE type IN ('integrated', 'integration_held') AND json_extract(data, '$.commitId') = ?");
      for (const settlement of db.prepare(`SELECT seq, json_extract(data, '$.commitId') AS commitId FROM events WHERE type IN (${types(RECEIPT_SETTLEMENT_EVENT_TYPES)})`).all() as
        { seq: number; commitId: string }[])
        for (const row of attempts.all(settlement.commitId) as { operation_id: string }[])
          if (bound.has(row.operation_id) && !settled(row.operation_id, settlement.seq)) ids.add(row.operation_id);
      return [...ids];
    },
    forgetHistory(now = new Date(), keep: ReadonlySet<string> = new Set()) {
      const lasting = [...LASTING_EVENTS].map((type) => `'${type}'`).join(",");
      // Each repository's newest landing is what a deploy, reset or audit reads, so it is never forgotten. A historic
      // `landed` may name no repository of its own, so the submission it belongs to names it.
      const newestLanding = new Map<string, { seq: number; operationId: string }>();
      for (const row of db.prepare(`SELECT landed.seq AS seq, landed.operation_id AS operation_id,
          COALESCE(json_extract(landed.data, '$.repo'), (SELECT json_extract(submitted.data, '$.repo') FROM events submitted
            WHERE submitted.operation_id = landed.operation_id AND submitted.type = 'submitted' LIMIT 1)) AS repo
        FROM events landed WHERE landed.type = 'landed'`).all() as { seq: number; operation_id: string; repo: string | null }[]) {
        if (row.repo === null) continue;
        const current = newestLanding.get(row.repo);
        if (!current || row.seq > current.seq) newestLanding.set(row.repo, { seq: row.seq, operationId: row.operation_id });
      }
      // An operation is whole while it is open, while any of it is inside the window, while its retained evidence is not yet
      // recorded as expired (a claim holding it open never expires, so its files are still there), and — for the facts, which
      // are what the horizon would take — while its caller names it or it is a repository's newest landing.
      const whole = (excluded: string[]) => `operation_id IN (SELECT operation_id FROM events WHERE type = 'submitted' AND at <= ?)
        AND operation_id NOT IN (SELECT operation_id FROM events WHERE at > ?)
        AND operation_id NOT IN (SELECT operation_id FROM events WHERE type = 'submitted' AND operation_id NOT IN (SELECT operation_id FROM events WHERE type IN ${terminalTypes}))
        AND operation_id NOT IN (SELECT operation_id FROM events WHERE type = 'source_retained' AND operation_id NOT IN (SELECT operation_id FROM events WHERE type = 'evidence_expired'))${excluded.length ? `\n        AND operation_id NOT IN (${excluded.map(() => "?").join(",")})` : ""}`;
      const anchored = [...keep, ...[...newestLanding.values()].map((entry) => entry.operationId)];
      const remove = (where: string, ...bindings: (string | number)[]) => {
        const found = Number((db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where}`).get(...bindings) as { count: number }).count);
        if (found) db.prepare(`DELETE FROM events WHERE ${where}`).run(...bindings);
        return found;
      };
      // What explained an operation goes once the window passes.
      const windowCutoff = new Date(now.getTime() - LEDGER_HISTORY_MS).toISOString();
      const trimWhere = `type NOT IN (${lasting}) AND ${whole([...keep])}`;
      let operations = Number((db.prepare(`SELECT COUNT(DISTINCT operation_id) AS count FROM events WHERE ${trimWhere}`)
        .get(windowCutoff, windowCutoff, ...keep) as { count: number }).count);
      let events = remove(trimWhere, windowCutoff, windowCutoff, ...keep);
      // Past the horizon the operation and its facts go too, unless another operation's surviving events still name one of its
      // commits: a hold, an integration and its settlement are read through the event that recorded them, and a commit is how
      // the two meet.
      const horizonCutoff = new Date(now.getTime() - LEDGER_FACT_MS).toISOString();
      const candidates = new Set((db.prepare(`SELECT DISTINCT operation_id FROM events WHERE ${whole(anchored)}`)
        .all(horizonCutoff, horizonCutoff, ...anchored) as { operation_id: string }[]).map((row) => row.operation_id));
      const commitsOf = db.prepare(`SELECT DISTINCT json_extract(data, '$.commitId') AS commitId FROM events
        WHERE operation_id = ? AND json_extract(data, '$.commitId') IS NOT NULL`);
      // A candidate goes only if nothing that survives names one of its commits, and a candidate that survives protects what
      // it names in turn: the check repeats until no more are protected, or retries of one commit would keep each other
      // forever while a settlement a survivor still needs was taken.
      const doomed = new Set(candidates);
      const referenced = (operationId: string, commits: readonly string[], excluded: readonly string[]) => !commits.length ? false
        : db.prepare(`SELECT 1 AS found FROM events WHERE operation_id <> ?
          AND operation_id NOT IN (${excluded.length ? excluded.map(() => "?").join(",") : "''"})
          AND json_extract(data, '$.commitId') IN (SELECT value FROM json_each(?)) LIMIT 1`)
          .get(operationId, ...excluded, JSON.stringify(commits)) !== undefined;
      const commitsNamed = (operationId: string) => (commitsOf.all(operationId) as { commitId: string }[]).map((row) => row.commitId);
      for (let protectedNow = true; protectedNow;) {
        protectedNow = false;
        for (const operationId of [...doomed]) {
          if (!referenced(operationId, commitsNamed(operationId), [...doomed])) continue;
          doomed.delete(operationId);
          protectedNow = true;
        }
      }
      for (const operationId of doomed) {
        const found = remove("operation_id = ?", operationId);
        if (found) { operations += 1; events += found; }
      }
      // The runner's own control events carry no submission: keep the newest pause, resume and delivery state, and forget the
      // rest once the horizon passes, unless a surviving operation still names the commit they settled.
      const newestOfType = db.prepare("SELECT seq FROM events WHERE operation_id = ? AND type = ? ORDER BY seq DESC LIMIT 1");
      const pinned = new Set(["paused", "resumed", "build_delivery"].flatMap((type) => {
        const row = newestOfType.get(RUNNER_CONTROL_ID, type) as { seq: number } | undefined;
        return row ? [row.seq] : [];
      }));
      for (const row of db.prepare("SELECT seq, json_extract(data, '$.commitId') AS commitId FROM events WHERE operation_id = ? AND at <= ?")
        .all(RUNNER_CONTROL_ID, horizonCutoff) as { seq: number; commitId: string | null }[]) {
        if (pinned.has(row.seq)) continue;
        // Only this settlement's own commit decides it: the control operation has recorded many, and one that a survivor
        // names must not keep every other settlement alive.
        if (row.commitId && referenced(RUNNER_CONTROL_ID, [row.commitId], [...doomed])) continue;
        events += remove("seq = ?", row.seq);
      }
      if (events) projection = undefined;
      return { events, operations };
    },
    snapshot(runner, now = new Date()) {
      db.exec("BEGIN");
      try {
        const seq = latestSeq();
        const all = (snapshotRows.all() as EventRow[]).map((row): StoredEvent => ({ seq: row.seq, operationId: row.operation_id, at: row.at, event: JSON.parse(row.data) as OperationEvent }));
        const open = queue().map((op) => projections.watch ? projections.watch(op, all, now) : unwatched(op));
        const repos = (db.prepare("SELECT DISTINCT json_extract(data, '$.repo') AS repo FROM events WHERE type = 'submitted'").all() as { repo: string }[]).map((row) => row.repo);
        return { version: 1, runner, seq, observedAt: now.toISOString(),
          lanes: { serial: open.filter((op) => op.kind !== "deploy"), deploy: open.filter((op) => op.kind === "deploy") },
          paused: paused(), held: held(),
          recentReleases: projectIds((db.prepare("SELECT operation_id FROM events WHERE type = 'submitted' AND json_extract(data, '$.kind') = 'release' ORDER BY seq DESC LIMIT 10").all() as { operation_id: string }[]).map((row) => row.operation_id)).filter((op): op is ReleaseOperation => op.kind === "release").sort((a, b) => b.lastSeq - a.lastSeq).slice(0, 10).map(withoutRuns),
          recentProductionDeploys: projectIds((db.prepare("SELECT operation_id FROM events WHERE type = 'submitted' AND json_extract(data, '$.kind') = 'deploy' AND json_extract(data, '$.environment') = 'production' ORDER BY seq DESC LIMIT 10").all() as { operation_id: string }[]).map((row) => row.operation_id)).filter((op): op is DeployOperation => op.kind === "deploy").map(withoutRuns),
          lastStagingDeploys: repos.flatMap((repo) => { const latest = projectIds((db.prepare(`SELECT e.operation_id FROM events e WHERE e.type = 'submitted' AND json_extract(e.data, '$.kind') = 'deploy' AND json_extract(e.data, '$.repo') = ? AND json_extract(e.data, '$.environment') = 'staging' AND EXISTS (SELECT 1 FROM events d WHERE d.operation_id = e.operation_id AND d.type IN ${terminalTypes}) ORDER BY e.seq DESC LIMIT 1`).all(repo) as { operation_id: string }[]).map((row) => row.operation_id)).find((op) => op.kind === "deploy"); return latest?.kind === "deploy" ? [withoutRuns(latest)] : []; }),
          lastSuite: { status: "unavailable" }, build: projections.deliveryState ? projections.deliveryState(log) : null };
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
      .flatMap(({ operation_id: id }) => { const history = events({ operationId: id }); const operation = project(id, history, projections);
        return operation?.kind === "landing" ? [{ operation, history }] : []; }),
    integrationSettlements: () => {
      const settlements = new Map<string, StoredEvent[]>();
      for (const row of db.prepare("SELECT seq, operation_id, at, data FROM events WHERE type IN ('integration_recovered', 'integration_released') ORDER BY seq").all() as EventRow[]) {
        const event = JSON.parse(row.data) as OperationEvent;
        if (event.type !== "integration_recovered" && event.type !== "integration_released") continue;
        const key = recoveryKey(event.repo, event.commitId);
        settlements.set(key, [...settlements.get(key) ?? [], { seq: row.seq, operationId: row.operation_id, at: row.at, event }]);
      }
      return settlements;
    },
    close: () => { listeners.clear(); db.close(); },
  };
  return log;
}

/** A snapshot lane for a log whose caller reports no watch timing: the operation as the ledger has it. */
const unwatched = (operation: Operation): WatchOperation => ({ ...operation,
  timing: { state: "unknown", medianMs: null, amberAfterMs: null, samples: 0, commandDeadlineAt: null },
  kill: { allowed: false, reason: "This log reports no watch timing" } });

/** A finished operation as the snapshot's history shows it: its result without its runs' evidence. */
const withoutRuns = <T extends Operation>({ runs: _runs, ...rest }: T): Omit<T, "runs"> => rest;

/** How a queued operation names the one running ahead of it. */
export const label = (operation: Operation): string =>
  operation.kind === "landing" ? `landing ${operation.changeId.slice(0, 12)}` : `${operation.kind} ${operation.commitId.slice(0, 12)}`;

function project(id: string, events: StoredEvent[], projections: OperationLogProjections): Operation | null {
  const submitted = events.find((stored) => stored.event.type === "submitted");
  if (!submitted || submitted.event.type !== "submitted")
    return null;
  const fields = {
    id, repo: submitted.event.repo, commitId: submitted.event.commitId, submittedBy: submitted.event.submittedBy,
    status: "queued" as const, stage: "queued" as const, submittedAt: submitted.at,
    runs: [], lastSeq: events.at(-1)!.seq,
  };
  const operation: Operation = submitted.event.kind === "release"
    ? { ...fields, kind: "release", migrationsReady: submitted.event.migrationsReady, ...submitted.event.automatic ? { automatic: submitted.event.automatic } : {} }
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
      case "admission_unavailable":
        if (operation.kind === "landing" && operation.admission === "pending") operation.admissionUnavailable = { reason: event.reason, at: stored.at };
        break;
      case "build_admitted":
        if (operation.kind === "landing") {
          operation.admission = "admitted";
          delete operation.admissionUnavailable;
        }
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
  if (operation.kind === "landing" && projections.landingOutcome) operation.outcome = projections.landingOutcome(operation, events);
  return operation;
}
