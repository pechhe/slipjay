import { repositoryKey } from "./runner-contract.ts";
import type { StoredEvent } from "./runner-types.ts";
import type { MetricTiming } from "./pipeline-metrics.ts";

/**
 * What `slipjay metrics` reports of a repository's batch checks (SJ-192) and of the landing gate they let narrow:
 * the checks run and how each ended, the culprits they found with the Forge items they were routed to, the red
 * batches no later green one answered, the time from a red batch to the next green one, the setup of scheduled checks,
 * how often a culprit had passed its own landing gate, and the landing gate's own time (its authoritative verifying
 * stage, or screening where it published without one, plus that attempt's remote setup).
 */
export type BatchMetrics = {
  repo: string;
  checks: { run: number; green: number; red: number; flaky: number; infrastructure: number };
  culprits: { commitId: string; operationId: string; batch: string; forge: number | null; routed: "routed" | "unrouted" | "pending" }[];
  unresolvedRed: string[];
  redToGreen: MetricTiming | null;
  scheduledSetup: MetricTiming | null;
  /** Red batches with a culprit whose landing passed its own gate, of all red batches. */
  redPastGate: { red: number; pastGate: number };
  landingGate: MetricTiming | null;
};

type Timing = (values: number[]) => MetricTiming | null;

export function batchMetrics(events: readonly StoredEvent[], since: number, timing: Timing, only?: string): BatchMetrics[] {
  const byOperation = new Map<string, StoredEvent[]>();
  for (const row of events) {
    const rows = byOperation.get(row.operationId) ?? [];
    rows.push(row);
    byOperation.set(row.operationId, rows);
  }
  type Batch = { id: string; repo: string; startedAt: number; endedAt: number | null; outcome?: string; scheduled: boolean; setupMs?: number;
    culprits: BatchMetrics["culprits"] };
  const batches: Batch[] = [];
  const gates = new Map<string, number[]>();
  const passedGate = new Set<string>();
  for (const [id, rows] of byOperation) {
    const submitted = rows.find((row) => row.event.type === "submitted")?.event;
    if (submitted?.type !== "submitted") continue;
    const repo = repositoryKey(submitted.repo);
    if (only && repo !== only) continue;
    const kind = "kind" in submitted ? submitted.kind ?? "landing" : "landing";
    if (kind === "landing") {
      const landed = rows.find((row) => row.event.type === "landed");
      if (!landed) continue;
      if (!rows.some((row) => row.event.type === "verification_skipped")) passedGate.add(id);
      if (Date.parse(landed.at) < since) continue;
      const verifying = rows.findLast((row) => row.event.type === "stage_detail" && row.event.stage === "verifying")?.event;
      const screening = rows.findLast((row) => row.event.type === "stage_detail" && row.event.stage === "screening")?.event;
      const stage = verifying ?? screening;
      if (stage?.type !== "stage_detail") continue;
      const setup = rows.findLast((row) => row.event.type === "remote_verification" && row.event.phase === "ready")?.event;
      const values = gates.get(repo) ?? [];
      values.push(stage.durationMs + (setup?.type === "remote_verification" && setup.phase === "ready" ? setup.setupMs : 0));
      gates.set(repo, values);
      continue;
    }
    const started = rows.find((row) => row.event.type === "batch_started");
    if (kind !== "verification" || started?.event.type !== "batch_started" || Date.parse(started.at) < since) continue;
    const ended = rows.findLast((row) => row.event.type === "batch_outcome");
    const outcome = ended?.event.type === "batch_outcome" ? ended.event : undefined;
    const complete = rows.find((row) => row.event.type === "batch_run" && row.event.phase === "complete")?.event;
    const routed = new Map(rows.flatMap((row) => row.event.type === "batch_routed" ? [[row.event.commitId, row.event.number] as const] : []));
    const unrouted = new Set(rows.flatMap((row) => row.event.type === "batch_unrouted" ? [row.event.commitId] : []));
    batches.push({ id, repo, startedAt: Date.parse(started.at), endedAt: ended ? Date.parse(ended.at) : null, ...outcome ? { outcome: outcome.outcome } : {},
      scheduled: started.event.scheduled, ...complete?.type === "batch_run" && complete.setupMs !== undefined ? { setupMs: complete.setupMs } : {},
      culprits: (outcome?.culprits ?? []).map((culprit) => ({ commitId: culprit.commitId, operationId: culprit.operationId, batch: id,
        forge: routed.get(culprit.commitId) ?? null, routed: routed.has(culprit.commitId) ? "routed" : unrouted.has(culprit.commitId) ? "unrouted" : "pending" })) });
  }
  const repos = new Set([...batches.map((batch) => batch.repo), ...gates.keys()]);
  return [...repos].sort().map((repo) => {
    const own = batches.filter((batch) => batch.repo === repo).sort((a, b) => a.startedAt - b.startedAt);
    const count = (outcome: string) => own.filter((batch) => batch.outcome === outcome).length;
    const red = own.filter((batch) => batch.outcome === "red");
    const nextGreen = (batch: Batch) => own.find((other) => other.outcome === "green" && other.endedAt !== null && batch.endedAt !== null && other.endedAt > batch.endedAt);
    return {
      repo,
      checks: { run: own.length, green: count("green"), red: red.length, flaky: count("flaky"), infrastructure: count("infrastructure") },
      culprits: red.flatMap((batch) => batch.culprits),
      unresolvedRed: red.filter((batch) => !nextGreen(batch)).map((batch) => batch.id),
      redToGreen: timing(red.flatMap((batch) => { const green = nextGreen(batch); return green ? [green.endedAt! - batch.endedAt!] : []; })),
      scheduledSetup: timing(own.flatMap((batch) => batch.scheduled && batch.setupMs !== undefined ? [batch.setupMs] : [])),
      redPastGate: { red: red.length, pastGate: red.filter((batch) => batch.culprits.some((culprit) => passedGate.has(culprit.operationId))).length },
      landingGate: timing(gates.get(repo) ?? []),
    };
  });
}

const median = (value: MetricTiming | null) => value ? `median ${(value.medianMs / 1000).toFixed(1)}s, p90 ${(value.p90Ms / 1000).toFixed(1)}s over ${value.samples}` : "no samples";

export function formatBatchMetrics(entries: readonly BatchMetrics[]): string[] {
  return entries.flatMap((entry) => [
    `${entry.repo} landing gate (verifying or screening, plus remote setup): ${median(entry.landingGate)}`,
    ...entry.checks.run ? [
      `${entry.repo} batch checks: ${entry.checks.run} run, ${entry.checks.green} green, ${entry.checks.red} red, ${entry.checks.flaky} flaky, ${entry.checks.infrastructure} infrastructure; scheduled setup ${median(entry.scheduledSetup)}`,
      `  Culprits: ${entry.culprits.length ? entry.culprits.map((culprit) => `${culprit.commitId.slice(0, 12)} (${culprit.operationId}, ${culprit.forge === null ? culprit.routed === "routed" ? "Forge item unknown" : `${culprit.routed}, no Forge item` : `Forge #${culprit.forge}`})`).join("; ") : "none"}`,
      `  Red batches unresolved: ${entry.unresolvedRed.length ? entry.unresolvedRed.join(", ") : "none"}; red to next green ${median(entry.redToGreen)}; red batches whose culprit passed its landing gate ${entry.redPastGate.pastGate} of ${entry.redPastGate.red}`,
    ] : [],
  ]);
}
