import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { releaseIntegration } from "../../src/lib/release/release.ts";
import type { PromotionState } from "../../src/lib/release/release.ts";
import { promotionRefusal } from "../../src/lib/release/audit-ledger.ts";
import type { AuditSummary } from "../../src/lib/release/audit-ledger.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { runnerAuditApi } from "../../src/lib/runner/runner-api-audit.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import type { DeployOperation, OperationEvent, ReleaseOperation, VerificationOperation } from "../../src/lib/runner/runner-types.ts";
import { promotingProject } from "../release/fixtures/release-fixture.ts";

const token = "test-secret";
const REPO = "owner/repo";
const PROMOTION_BYTES = 32 * 1024;
const sha = (n: number) => n.toString(16).padStart(40, "0");

/** A runner with a long history of every kind, every operation carrying run detail the list routes trim. */
function runner() {
  const log = openOperationLog(":memory:");
  const handler = createRunnerHandler({ log, token, runnerName: "r", audit: runnerAuditApi, readLog: async () => null, onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe: () => () => {} });
  let ids = 0;
  const get = async (route: string): Promise<Response> => handler(new Request(`http://localhost/v1${route}`, { headers: { authorization: `Bearer ${token}` } }));
  const detail = (id: string) => {
    log.append(id, { type: "run_started", runId: "r1", command: "bun run verify", host: "runner" });
    log.append(id, { type: "run_finished", runId: "r1", exitCode: 0, signal: null, timedOut: false, durationMs: 5, diagnostics: Array.from({ length: 20 }, (_, n) => `diagnostic ${n} ${"x".repeat(200)}`) });
  };
  const summary = "x".repeat(4_000);
  const open = (event: OperationEvent, withDetail = false) => { const id = `op-${String((ids += 1)).padStart(6, "0")}`; log.append(id, event); if (withDetail) detail(id); return id; };
  return {
    log, get,
    deploy(commitId: string, green = true, withDetail = false) {
      const id = open({ type: "submitted", kind: "deploy", repo: REPO, environment: "staging", commitId, submittedBy: "runner" }, withDetail);
      log.append(id, green ? { type: "deployed", record: { projects: [] } as never } : { type: "failed", stage: "verifying", reason: "red" });
    },
    release(commitId: string, outcome: "released" | "failed" | "cancelled" | "open", withDetail = false) {
      const id = open({ type: "submitted", kind: "release", repo: REPO, commitId, migrationsReady: false, submittedBy: "author" }, withDetail);
      if (outcome === "released") log.append(id, { type: "released", result: { ok: true, status: "released", summary } as never });
      else if (outcome === "failed") log.append(id, { type: "failed", stage: "verifying", reason: "red" });
      else if (outcome === "cancelled") log.append(id, { type: "cancelled", reason: "no" });
    },
    verification(commitId: string, outcome: "verified" | "failed" | "queued" | "running" | "superseded", checks: unknown[] = [], base = sha(0), withDetail = false) {
      const id = open({ type: "submitted", kind: "verification", repo: REPO, commitId, submittedBy: "runner" }, withDetail);
      if (outcome === "running") log.append(id, { type: "stage", stage: "verifying" });
      if (outcome === "verified") log.append(id, { type: "verified", base, candidate: commitId, checks: checks as never });
      if (outcome === "failed") log.append(id, { type: "failed", stage: "verifying", reason: `exited 1 ${summary}`, command: "bun run verify:release" });
      if (outcome === "superseded") log.append(id, { type: "superseded", by: "someone" });
    },
    audit(outcome: "green" | "failed", withDetail = false) {
      const id = open({ type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "runner:schedule" }, withDetail);
      log.append(id, { type: "stage", stage: "verifying" });
      log.append(id, { type: "audit_head", commit: sha(1) });
      log.append(id, outcome === "green" ? { type: "audited", commit: sha(1), commands: ["test"], passed: ["test"], skipped: [], reused: [] }
        : { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run test" });
    },
  };
}

/** What the runner's four lists say, read as a client that has no `/v1/promotion` reads them. */
async function fromLists(r: ReturnType<typeof runner>): Promise<PromotionState> {
  const list = async <T>(route: string) => ((await (await r.get(route)).json()) as { operations: T[] }).operations;
  const staging = await list<DeployOperation>(`/deploys?repo=${REPO}&environment=staging`);
  const releases = await list<ReleaseOperation>(`/releases?repo=${REPO}`);
  const verifications = await list<VerificationOperation>(`/verifications?repo=${REPO}`);
  const { summary } = (await (await r.get(`/audits?repo=${REPO}`)).json()) as { summary: AuditSummary };
  const green = staging.filter((operation) => operation.result?.type === "deployed");
  return { verifications, auditRefusal: promotionRefusal(summary), stagingGreen: green[0]?.commitId ?? null, stagingGreenCommits: [...new Set(green.map((operation) => operation.commitId))],
    approved: releases.filter((operation) => operation.status !== "cancelled" && operation.status !== "superseded").map((operation) => operation.commitId) };
}

test("the promotion route answers in a size that history does not grow, and plans exactly as the full lists do", async () => {
  const f = await promotingProject();
  const r = runner();
  try {
    const policy = JSON.parse(await (await import("node:fs/promises")).readFile(`${f.repo}/slipjay.json`, "utf8"));
    await f.commit({ "slipjay.json": JSON.stringify({ ...policy, audit: { commands: [{ executable: "bun", args: ["-e", ""] }] } }) }, "Declare an audit");
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const b = await f.commit({ "b.txt": "b\n" }, "Add b");
    const c = await f.commit({ "c.txt": "c\n" }, "Add c");
    // Enough history before the commits under plan to push the full lists over 1 MiB.
    for (let n = 0; n < 200; n++) { r.deploy(sha(1000 + n), n % 5 !== 0, n < 5); r.verification(sha(1000 + n), n % 2 ? "verified" : "failed", [], sha(0), n < 5); r.audit("green", n < 5); }
    for (let n = 0; n < 200; n++) r.release(sha(1000 + n), "released", n < 5);
    for (const commit of [a, b, c]) r.deploy(commit, true, true);
    r.release(a, "failed", true); r.release(b, "cancelled", true);

    const plan = async (read: (commits: string[]) => Promise<PromotionState>, candidate?: string) => releaseIntegration(f.repo, { readPromotion: read, ...candidate ? { candidate } : {} });
    const viaRoute = async (commits: string[]): Promise<PromotionState> => {
      const response = await r.get(`/promotion?repo=${REPO}${commits.map((commit) => `&commit=${commit}`).join("")}`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.length < PROMOTION_BYTES, `the promotion answer is ${body.length} bytes`);
      sizes.push(body.length);
      return JSON.parse(body) as PromotionState;
    };
    const sizes: number[] = [];
    const lists = (await (await r.get(`/verifications?repo=${REPO}`)).text()).length + (await (await r.get(`/releases?repo=${REPO}`)).text()).length;
    const same = async (label: string, candidate?: string) => {
      const route = await plan(viaRoute, candidate);
      const full = await plan(async () => fromLists(r), candidate);
      assert.ok(route.ok && route.status === "planned", `${label}: ${JSON.stringify(route)}`);
      assert.deepEqual(route, full, label);
      return route;
    };

    const none = await same("no verification of the candidate");
    assert.ok(none.ok && none.status === "planned" && none.candidate === c && none.verification?.status === "none");
    assert.equal(none.delta?.since, a, "the newest approval that did not ship");
    r.verification(c, "failed");
    const failed = await same("a failed verification");
    assert.ok(failed.ok && failed.status === "planned" && failed.verification?.status === "failed");
    r.verification(c, "verified", f.checks, none.base);
    const passed = await same("a passed verification");
    assert.ok(passed.ok && passed.status === "planned" && passed.verification?.status === "passed");
    r.verification(c, "queued");
    const queued = await same("a queued verification");
    assert.ok(queued.ok && queued.status === "planned" && queued.verification?.status === "queued");
    r.verification(a, "running");
    await same("an older commit's running verification");
    const older = await same("an older candidate", b.slice(0, 14));
    assert.ok(older.ok && older.status === "planned" && older.candidate === b);

    // The latest batch check is picked from the compact verifications as from all of them.
    const batch = (state: PromotionState) => state.verifications.find((entry) => entry.status === "queued" || entry.status === "running")?.id
      ?? state.verifications.find((entry) => entry.status === "failed" || entry.status === "verified")?.id;
    assert.equal(batch(await viaRoute([c])), batch(await fromLists(r)));
    r.verification(sha(5), "failed");
    assert.equal(batch(await viaRoute([c])), batch(await fromLists(r)));

    r.audit("failed");
    const refused = await plan(viaRoute);
    assert.ok(!refused.ok && /latest audit failed/.test(refused.reason), JSON.stringify(refused));
    assert.deepEqual(refused, await plan(async () => fromLists(r)));

    assert.ok(lists > 1_000_000, `the lists a plan used to read are ${lists} bytes`);
  } finally { r.log.close(); await f.dispose(); }
}, 300_000);

test("the promotion route refuses a malformed commit and a missing repository, and names no approval older than the newest shipped release", async () => {
  const r = runner();
  try {
    assert.equal((await r.get("/promotion")).status, 400);
    assert.equal((await r.get(`/promotion?repo=${REPO}&commit=abc`)).status, 400);
    r.release(sha(1), "released"); r.release(sha(2), "released"); r.release(sha(3), "failed");
    const state = (await (await r.get(`/promotion?repo=${REPO}`)).json()) as PromotionState;
    assert.deepEqual(state.approved, [sha(3), sha(2)]);
    assert.equal(state.auditRefusal, null);
  } finally { r.log.close(); }
});
