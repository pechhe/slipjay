import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { LEDGER_HISTORY_MS, metricsWindowSql, newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";

const DAY = 24 * 60 * 60 * 1000;
const submitted = (repo: string, changeId: string) => ({ type: "submitted" as const, repo, changeId, commitId: `c-${changeId}`, bookmark: candidateBookmark(changeId), submittedBy: "author" });
const finish = (log: ReturnType<typeof openOperationLog>, id: string) => log.append(id, { type: "landed", base: "b", commitId: "c", branch: "main", remote: "origin" });
/** The next instant, so a later append is strictly after the returned mark. */
async function mark(): Promise<string> {
  const before = new Date().toISOString();
  while (new Date().toISOString() === before) await new Promise((resolve) => setTimeout(resolve, 1));
  return new Date().toISOString();
}

test("a metrics window reads only the operations submitted in it, through an index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-window-"));
  const path = join(dir, "operations.sqlite");
  const log = openOperationLog(path);
  try {
    const old = newOperationId(), recent = newOperationId(), other = newOperationId();
    log.append(old, submitted("owner/repo", "a".repeat(32))); log.append(old, { type: "stage", stage: "verifying" });
    const since = await mark();
    log.append(recent, submitted("Owner/Repo", "b".repeat(32))); log.append(recent, { type: "stage", stage: "verifying" });
    log.append(other, submitted("owner/other", "c".repeat(32)));
    const operations = (rows: { operationId: string }[]) => [...new Set(rows.map((row) => row.operationId))].sort();
    assert.deepEqual(operations(log.events({ since })), [other, recent].sort());
    assert.deepEqual(operations(log.events({ since, repo: "OWNER/repo" })), [recent]);
    assert.equal(log.events({ since, limit: 2 }).length, 2);
    assert.equal(log.events({ since, afterSeq: log.latestSeq() }).length, 0);
    assert.ok(operations(log.events()).includes(old), "no window reads everything");

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const bindings = (repo: boolean) => repo ? [since, "x", since, "x", since, 0, 10] : [since, since, since, 0, 10];
      for (const repo of [false, true]) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${metricsWindowSql(repo)}`).all(...bindings(repo)) as { detail: string }[]).map((row) => row.detail);
        const outer = plan.filter((detail) => /events\b/.test(detail) && !/events_type_at/.test(detail) && !/events_type\b/.test(detail));
        assert.ok(plan.some((detail) => /USING (COVERING )?INDEX events_operation_id \(operation_id=/.test(detail)), plan.join("\n"));
        assert.ok(plan.every((detail) => !/^SCAN events/.test(detail) && !/USING INTEGER PRIMARY KEY/.test(detail)), plan.join("\n"));
        assert.ok(outer.length > 0);
      }
    } finally { db.close(); }
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

const progress = (line: string) => ({ type: "progress" as const, line });
const bloat = (log: ReturnType<typeof openOperationLog>) => {
  const big = "x".repeat(1024 * 1024);
  for (let index = 0; index < 80; index++) {
    const id = newOperationId();
    log.append(id, submitted("owner/repo", String(index).padStart(32, "0")));
    log.append(id, progress(big));
    finish(log, id);
  }
};
const pragma = (path: string, name: string) => Number(Object.values(new DatabaseSync(path, { readOnly: true }).prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);

test("a new ledger vacuums incrementally and gives pruned pages back", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-vacuum-"));
  const path = join(dir, "operations.sqlite");
  const log = openOperationLog(path);
  try {
    assert.equal(pragma(path, "auto_vacuum"), 2);
    bloat(log);
    log.checkpoint();
    const before = statSync(path).size;
    log.forgetHistory(new Date(Date.now() + LEDGER_HISTORY_MS + 10 * DAY));
    log.checkpoint();
    assert.ok(statSync(path).size < before, "an incremental vacuum shrinks the file");
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a ledger from before incremental vacuum is converted once it holds 64 MiB of free pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-convert-"));
  const path = join(dir, "operations.sqlite");
  const legacy = new DatabaseSync(path); legacy.exec("CREATE TABLE legacy (x)"); legacy.close();
  const log = openOperationLog(path);
  try {
    assert.equal(pragma(path, "auto_vacuum"), 0, "an existing ledger keeps its mode until pruned");
    bloat(log);
    log.checkpoint();
    const before = statSync(path).size;
    log.forgetHistory(new Date(Date.now() + LEDGER_HISTORY_MS + 10 * DAY));
    log.checkpoint();
    assert.equal(pragma(path, "auto_vacuum"), 2);
    assert.ok(statSync(path).size < before / 2, "the VACUUM returned the freed pages");
    assert.equal(log.events({}).filter((row) => row.event.type === "landed").length, 80, "what lasts survives");
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

test("a workspace that began before the window but reported inside it is read whole", async () => {
  const log = openOperationLog(":memory:");
  try {
    const workspace = newOperationId(), stale = newOperationId();
    log.append(workspace, { type: "client_operation", repo: "owner/repo", workspace: "w", machine: "m" });
    log.append(stale, { type: "client_operation", repo: "owner/repo", workspace: "old", machine: "m" });
    const since = await mark();
    log.append(workspace, { type: "client", id: "claim-1", fact: { kind: "pool_claim", durationMs: 5, spareCount: 1, hit: true } } as never);
    const rows = log.events({ since });
    assert.deepEqual([...new Set(rows.map((row) => row.operationId))], [workspace]);
    assert.deepEqual(rows.map((row) => row.event.type), ["client_operation", "client"], "its earlier origin row comes with it");
    const metrics = pipelineMetrics(rows, since);
    assert.equal(metrics.workspaceStarts.length, 1);
    assert.equal(metrics.workspaceStarts[0]?.starts, 1);
  } finally { log.close(); }
});
