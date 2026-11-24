#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

// Standalone: the installer copies only this file. Read the ledger's stable event
// fields rather than using the runner's writable operation-log API.
type LedgerRow = { seq: number; operation_id: string; at: string; type: string; data: string };
type Fact = { seq: number; at: number };
type Stage = Fact & { name: string };
type Verdict = Fact & { type: string; reason?: string };
type Batch = Fact & { outcome: string; verified?: boolean };
type Operation = {
  id: string; kind: string; environment?: string; stage?: Stage; verdict?: Verdict;
  batch?: Batch; automatic?: boolean; unassociated: string[];
};
/** Operations in submission order, with their latest facts in ledger order. */
type HealthInput = { runnerActive: boolean; operations: readonly Operation[] };
type Alert = { key: string; cooldownMs: number; operationId?: string; stage?: string };
const minute = 60_000;
const hour = 60 * minute;

// This script ships standalone; match staleAutomaticRelease in runner-queue.ts, including the legacy diagnostic.
function staleAutomaticRelease(operation: Operation): boolean {
  return operation.automatic === true && operation.verdict?.type === "failed"
    && /^Not promoted automatically: (?:no pre-verification of .* passed against (?!a readable release base)|Pre-verification of .* passed against .*?, not [0-9a-f]+$)/i.test(operation.verdict.reason ?? "");
}

export function evaluateReleaseHealth(input: HealthInput, nowMs: number): Alert[] {
  const { runnerActive, operations } = input;
  const alerts: Alert[] = [];
  if (!runnerActive) alerts.push({ key: "runner_inactive", cooldownMs: 30 * minute });

  for (const { id, kind, stage, verdict } of operations) {
    if (!stage || stage.name === "queued" || verdict || !["verification", "release", "deploy"].includes(kind)) continue;
    if (nowMs - stage.at > (kind === "deploy" ? 20 : 45) * minute)
      alerts.push({ key: `release_op_wedged:${id}`, cooldownMs: 2 * hour, operationId: id, stage: stage.name });
  }

  const completed = operations.flatMap(({ id, verdict, batch, unassociated }) =>
    verdict && batch && !["superseded", "cancelled"].includes(verdict.type) && batch.outcome !== "stopped"
      ? [{ id, ...batch, ...verdict, unassociated }] : []).sort((a, b) => b.seq - a.seq);
  const latest = completed[0];
  if (latest?.outcome === "red") {
    for (const shortCommit of new Set(latest.unassociated.map((commit) => commit.slice(0, 12))))
      alerts.push({ key: `unrouted_red_culprit:${shortCommit}`, cooldownMs: 24 * hour, operationId: latest.id });
    const firstNonRed = completed.findIndex(({ outcome }) => outcome !== "red");
    const firstRed = firstNonRed < 0 ? completed.at(-1)! : completed[firstNonRed - 1]!;
    if (nowMs - firstRed.at >= 20 * minute)
      alerts.push({ key: "red_batch_stalled", cooldownMs: 2 * hour, operationId: latest.id });
  }
  const recent = completed.slice(0, 2);
  if (recent.length === 2 && recent.every(({ at, outcome, verified }) => at >= nowMs - 3 * hour
    && (outcome === "infrastructure" || (outcome === "flaky" && !verified))))
    alerts.push({ key: "flaky_or_infra_burst", cooldownMs: 2 * hour, operationId: recent[0]!.id });

  // Submitted order matters: don't report an old failed attempt as the latest when a successor is running.
  const releases = operations.filter(({ kind }) => kind === "release");
  const release = releases.at(-1);
  if (release?.verdict?.type === "failed" && !staleAutomaticRelease(release)
    && !releases.some(({ verdict }) => verdict?.type === "released" && verdict.seq > release.verdict!.seq))
    alerts.push({ key: `release_failed:${release.id}`, cooldownMs: 2 * hour, operationId: release.id });
  const deploys = operations.filter(({ kind, environment }) => kind === "deploy" && environment === "production");
  const deploy = deploys.at(-1);
  if (deploy?.verdict?.type === "failed" && !deploys.some(({ verdict }) => verdict?.type === "deployed" && verdict.seq > deploy.verdict!.seq))
    alerts.push({ key: `production_deploy_failed:${deploy.id}`, cooldownMs: 2 * hour, operationId: deploy.id });
  const audit = operations.findLast(({ kind }) => kind === "audit");
  if (audit?.verdict?.type === "failed" && audit.verdict.at >= nowMs - 6 * hour)
    alerts.push({ key: `nightly_audit_failed:${audit.id}`, cooldownMs: 6 * hour, operationId: audit.id });
  return alerts;
}

const terminal = ["verified", "released", "deployed", "audited", "failed", "declined", "superseded", "cancelled", "landed", "reset"];
async function readOperations(path: string, repo: string): Promise<Operation[]> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const rows = db.query<LedgerRow, [string]>(`
      SELECT e.seq, e.operation_id, e.at, e.type, e.data
      FROM events submitted JOIN events e ON e.operation_id = submitted.operation_id
      WHERE submitted.type = 'submitted' AND lower(json_extract(submitted.data, '$.repo')) = lower(?)
      AND json_extract(submitted.data, '$.kind') IN ('verification','release','deploy','audit')
      AND e.type IN ('submitted','stage','yielded','batch_outcome','batch_unrouted',${terminal.map((type) => `'${type}'`).join(",")})
      ORDER BY e.seq`).all(repo);
    const operations = new Map<string, Operation>();
    for (const { operation_id: id, seq, at, type, data } of rows) {
      const fact = { seq, at: Date.parse(at) };
      if (type === "submitted") {
        const { kind, environment, automatic } = JSON.parse(data) as { kind: string; environment?: string; automatic?: unknown };
        operations.set(id, { id, kind, environment, automatic: Boolean(automatic), unassociated: [] });
        continue;
      }
      const operation = operations.get(id);
      if (!operation) continue;
      if (type === "stage") operation.stage = { ...fact, name: (JSON.parse(data) as { stage: string }).stage };
      else if (type === "yielded") delete operation.stage;
      else if (type === "batch_outcome") {
        const { outcome, verified } = JSON.parse(data) as { outcome: string; verified?: boolean };
        operation.batch = { ...fact, outcome, verified };
        operation.unassociated = [];
      } else if (type === "batch_unrouted") {
        const { reason, commitId } = JSON.parse(data) as { reason: string; commitId: string };
        if (/^batch_culprit_unassociated(?::|$)/.test(reason)) operation.unassociated.push(commitId);
      } else {
        const reason = operation.kind === "release" && type === "failed" ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        operation.verdict = { ...fact, type, reason };
      }
    }
    return [...operations.values()];
  } finally { db.close(); }
}

type Options = {
  dryRun?: boolean; repo?: string; db?: string; webhookFile?: string; cooldownFile?: string;
  nowMs?: number; runnerActive?: boolean; post?: (url: string, request: RequestInit) => Promise<Response>;
  print?: (line: string) => void;
};
async function readCooldown(path: string): Promise<Record<string, number>> {
  try {
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    if (state && typeof state === "object" && !Array.isArray(state))
      return Object.fromEntries(Object.entries(state).filter(([, at]) => Number.isFinite(at)));
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function saveCooldown(path: string, state: Record<string, number>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function runReleaseWatchdog(options: Options = {}): Promise<void> {
  const { dryRun, repo = "pechhe/yardsmith", nowMs = Date.now(), post = fetch, print = console.log } = options;
  const runnerHome = join(homedir(), ".slipjay", "runner");
  const db = options.db ?? join(runnerHome, "operations.sqlite");
  const webhookFile = options.webhookFile ?? join(homedir(), ".config", "slipjay", "release-watchdog-webhook.url");
  const cooldownFile = options.cooldownFile ?? join(runnerHome, "release-watchdog-cooldown.json");
  const runnerActive = options.runnerActive ?? (spawnSync("systemctl", ["--user", "is-active", "slipjay-runner.service"],
    { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "active");
  const ledgerMissing = !runnerActive && !existsSync(db);
  const operations = ledgerMissing ? [] : await readOperations(db, repo);
  const alerts = evaluateReleaseHealth({ runnerActive, operations }, nowMs);
  const state = await readCooldown(cooldownFile);
  const prefix = `${repo.toLowerCase()}:`;
  const due = alerts.filter(({ key, cooldownMs }) => state[prefix + key] === undefined || nowMs - state[prefix + key]! >= cooldownMs);
  const payload = { source: "slipjay-release-watchdog", repo, timestamp: new Date(nowMs).toISOString(),
    alerts: due.map(({ cooldownMs: _cooldownMs, ...alert }) => alert) };
  const json = JSON.stringify(payload);
  const activeKeys = new Set(alerts.map(({ key }) => prefix + key));
  const next = Object.fromEntries(Object.entries(state).filter(([key]) =>
    !key.startsWith(prefix) || activeKeys.has(key) || (ledgerMissing && key !== prefix + "runner_inactive")));
  if (!due.length) print(`HEALTHY ${JSON.stringify({ ...payload, suppressed: alerts.map(({ key }) => key) })}`);
  else if (dryRun) print(`DRY_RUN_ALERT ${json}`);
  else {
    let status: number | "unavailable" = "unavailable";
    let sent = false;
    try {
      const url = (await readFile(webhookFile, "utf8")).trim();
      if (!/^https?:\/\/[^/\\\s][^\\\s]*$/i.test(url) || !URL.canParse(url)) throw new Error("invalid webhook");
      const response = await post(url, { method: "POST", headers: { "content-type": "application/json" },
        body: json, signal: AbortSignal.timeout(10_000), redirect: "error" });
      status = response.status;
      sent = response.ok;
      if (response.body) void response.body.cancel().catch(() => undefined);
    } catch { /* The URL and transport error may contain a secret; print neither. */ }
    if (sent) for (const { key } of due) next[prefix + key] = nowMs;
    print(`${sent ? "ALERT_SENT" : "ALERT_FAILED"} ${status} ${json}`);
  }
  if (!dryRun && JSON.stringify(next) !== JSON.stringify(state)) await saveCooldown(cooldownFile, next);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      "dry-run": { type: "boolean" }, repo: { type: "string" }, db: { type: "string" },
      "webhook-file": { type: "string" }, "cooldown-file": { type: "string" },
    } });
    await runReleaseWatchdog({ dryRun: values["dry-run"], repo: values.repo, db: values.db,
      webhookFile: values["webhook-file"], cooldownFile: values["cooldown-file"] });
  } catch (error) {
    console.error("Release watchdog could not inspect the runner ledger or update cooldown state:", error);
    process.exitCode = 1;
  }
}
