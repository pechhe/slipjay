import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import { repairAuthority } from "../src/lib/repair-claim.ts";
import type { OperationLog, SubmitRequest } from "../src/lib/runner-contract.ts";

const changeId = "k".repeat(32), source = "a".repeat(40), token = "b".repeat(64);
function failed(log: OperationLog, id = "op_failed") {
  log.append(id, { type: "submitted", repo: "owner/repo", changeId, commitId: source, bookmark: candidateBookmark(changeId), submittedBy: "author" });
  log.append(id, { type: "source_retained", commitId: source, sourceRef: "retained", manifestSha256: "d".repeat(64), handoffComplete: false });
  log.append(id, { type: "failed", stage: "verifying", reason: "gate failed" });
  log.append(id, { type: "classified", ruleVersion: 1, cause: "gate", failingTests: [], diagnostics: [] });
}
function handler(log: OperationLog, hooks: Partial<Parameters<typeof createRunnerHandler>[0]> = {}) {
  return createRunnerHandler({ log, token: "api-token", runnerName: "fixture", readLog: async () => "", readManifest: async () => ({}),
    onSubmitted: () => {}, kill: () => ({ status: "idle" }), subscribe: log.subscribe, ...hooks });
}
const call = (h: ReturnType<typeof handler>, path: string, body: unknown) => h(new Request(`http://runner/v1/${path}`, {
  method: "POST", headers: { authorization: "Bearer api-token", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const claim = { action: "claim", token, workspace: "isolated-repair", by: "worker" };
const submission = (): SubmitRequest => ({ repo: "owner/repo", changeId, commitId: "c".repeat(40), bookmark: candidateBookmark(changeId), submittedBy: "repairer", requestId: "repair-submit-identity" });

test("repair claim survives restart, rejects double claimant and stale author, and links one new attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repair-claim-"));
  let log = openOperationLog(join(dir, "ledger.sqlite"));
  try {
    failed(log);
    let h = handler(log);
    const response = await call(h, "operations/op_failed/repair", claim);
    assert.equal(response.status, 200);
    const body = await response.json() as { claim: { claimId: string } };
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal((await call(h, "operations/op_failed/repair", { ...claim, token: "f".repeat(64) })).status, 409);
    assert.equal((await call(h, "operations", submission())).status, 409);
    log.close(); log = openOperationLog(join(dir, "ledger.sqlite")); h = handler(log);
    assert.equal((await (await call(h, "operations/op_failed/repair", claim)).json() as typeof body).claim.claimId, body.claim.claimId);
    const repair = { operationId: "op_failed", claimId: body.claim.claimId, token };
    const submitted = await call(h, "operations", { ...submission(), repair });
    assert.equal(submitted.status, 200);
    const result = await submitted.json() as { operation: { id: string } };
    assert.ok(log.events({ operationId: result.operation.id }).some((row) => row.event.type === "repair_proposed" && row.event.operationId === "op_failed"));
    assert.equal((await (await call(h, "operations", { ...submission(), repair })).json() as typeof result).operation.id, result.operation.id);
    assert.equal((await call(h, "operations", { ...submission(), requestId: "stale-author-request", commitId: "e".repeat(40) })).status, 409);
    assert.equal((await call(h, "operations/op_failed/repair", { action: "revoke", by: "owner" })).status, 409);
    log.append(result.operation.id, { type: "failed", stage: "verifying", reason: "still broken" });
    assert.equal((await call(h, "operations/op_failed/repair", { action: "revoke", by: "owner" })).status, 200);
    assert.equal(repairAuthority(log, "owner/repo", changeId).active, null);
    assert.equal((await call(h, "operations", { ...submission(), repair, requestId: "revoked-repair-request", commitId: "e".repeat(40) })).status, 409);
    assert.equal((await call(h, "operations", { ...submission(), requestId: "unclaimed-repair-request", commitId: "e".repeat(40) })).status, 409);
    assert.equal(JSON.stringify(log.events()).includes(token), false);
  } finally { log.close(); await rm(dir, { recursive: true, force: true }); }
});

test("repair admission rechecks a claim revoked during retained-source capture", async () => {
  const log = openOperationLog(":memory:");
  let capturing!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { capturing = resolve; });
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  try {
    failed(log);
    const h = handler(log, { retainSubmission: async () => { capturing(); await waiting; return { type: "source_retained", commitId: "c".repeat(40), sourceRef: "retained", manifestSha256: "d".repeat(64), handoffComplete: false }; } });
    const body = await (await call(h, "operations/op_failed/repair", claim)).json() as { claim: { claimId: string } };
    const pending = call(h, "operations", { ...submission(), repair: { operationId: "op_failed", claimId: body.claim.claimId, token } });
    await started;
    assert.equal((await call(h, "operations/op_failed/repair", { action: "revoke", by: "owner" })).status, 200);
    finish();
    assert.equal((await pending).status, 409);
    assert.equal(log.operationsForChange("owner/repo", changeId).length, 1);
  } finally { finish?.(); log.close(); }
});

test("held, published, killed, migration and paused histories never grant a coding repair claim", async () => {
  for (const mode of ["held", "published", "killed", "migration", "paused"] as const) {
    const log = openOperationLog(":memory:");
    try {
      failed(log);
      if (mode === "held") log.append("op_failed", { type: "publication_intent", attempt: 1, base: "d".repeat(40), candidate: source });
      if (mode === "published") log.append("op_failed", { type: "landed", base: "d".repeat(40), commitId: source, branch: "main", remote: "origin" });
      if (mode === "killed") log.append("op_failed", { type: "classified", ruleVersion: 1, cause: "killed", failingTests: [], diagnostics: [] });
      if (mode === "migration") log.append("op_failed", { type: "run_started", runId: "migration", command: "migrate", host: "fixture", purpose: "migration_verify" });
      if (mode === "paused") log.append("runner", { type: "paused", by: "owner" });
      assert.equal((await call(handler(log), "operations/op_failed/repair", claim)).status, 409, mode);
      assert.equal(repairAuthority(log, "owner/repo", changeId).active, null);
    } finally { log.close(); }
  }
});
