import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { promotionRefusal } from "../../src/lib/release/audit-ledger.ts";
import type { AuditSummary } from "../../src/lib/release/audit-ledger.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { RUNNER_API } from "../../src/lib/runner/runner-contract.ts";
import type { AuditOperation } from "../../src/lib/runner/runner-types.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";

const token = "test-secret";
const sha = (name: string) => name.padEnd(40, "0");

async function fixture() {
  const log = openOperationLog(":memory:");
  const handler = createRunnerHandler({ log, token, runnerName: "test-runner", readLog: () => Promise.resolve(null), onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe: () => () => {} });
  const server = await serveRunner(handler, { host: "127.0.0.1", port: 0 });
  const request = (path: string, init: RequestInit = {}) => fetch(`${server.url}${RUNNER_API}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const cause = (body: Record<string, unknown>) => request("/audits/cause", { method: "POST", body: JSON.stringify({ repo: "Owner/Repo", by: "henry", ...body }) });
  let landings = 0, audits = 0, previous = sha("base");
  return {
    log, cause, request,
    landing(name: string, gate = true) {
      const id = `landing-${landings += 1}`;
      log.append(id, { type: "submitted", repo: "owner/repo", changeId: `change${name}`, commitId: sha(`src${name}`), bookmark: "slipjay/changes/x", submittedBy: "test" });
      if (gate) log.append(id, { type: "verification_passed", base: previous, candidate: sha(name) });
      log.append(id, { type: "landed", base: previous, commitId: sha(name), branch: "main", remote: "origin" });
      previous = sha(name);
      return id;
    },
    audit(outcome: "green" | "failed", head = previous) {
      const id = `op_${String(audits += 1).padStart(10, "0")}_${"a".repeat(24)}`;
      log.append(id, { type: "submitted", kind: "audit", repo: "owner/repo", commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
      log.append(id, { type: "audit_head", commit: head });
      log.append(id, outcome === "green" ? { type: "audited", commit: head, commands: ["t"], passed: ["t"], skipped: [], reused: [] }
        : { type: "failed", stage: "verifying", reason: "Required verification failed" });
      return id;
    },
    async close() { await server.close(); log.close(); },
  };
}
const read = async (response: Response) => await response.json() as { error?: string; operation?: AuditOperation; summary?: AuditSummary; operations?: AuditOperation[] };

test("the audits route needs a repository and reports the audits with what the ledger says of them", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/audits")).status, 400);
    f.landing("a1");
    const id = f.audit("failed");
    const body = await read(await f.request("/audits?repo=Owner/Repo"));
    assert.deepEqual(body.operations?.map((operation) => operation.id), [id]);
    assert.equal(body.operations?.[0]?.kind, "audit");
    assert.equal(body.summary?.openFailure?.cause, null);
    assert.deepEqual(body.summary?.openFailure?.suspects, [sha("a1")]);
  } finally { await f.close(); }
});

test("recording a cause refuses what names no failing audit, no landing, or more or less than one cause", async () => {
  const f = await fixture();
  try {
    f.landing("b1");
    for (const body of [{}, { kind: "flake", landings: ["x".repeat(12)] }, { kind: "bug" }, { landings: [] }, { landings: [1] }, { kind: "flake", audit: "audit-1" }, { kind: "flake", note: "" }])
      assert.equal((await f.cause(body)).status, 400, JSON.stringify(body));
    assert.equal((await f.request("/audits/cause", { method: "POST", body: "{" })).status, 400);
    const none = await f.cause({ kind: "flake" });
    assert.equal(none.status, 400);
    assert.match((await read(none)).error ?? "", /no open failure to explain/);
    const green = f.audit("green");
    assert.match((await read(await f.cause({ kind: "flake" }))).error ?? "", /no open failure/);
    assert.match((await read(await f.cause({ kind: "flake", audit: green }))).error ?? "", /did not fail/);
    f.audit("failed");
    const unknown = await read(await f.cause({ landings: [sha("unknown")] }));
    assert.match(unknown.error ?? "", /is not a landing this runner published for the repository/);
    assert.equal((await read(await f.request("/audits?repo=owner/repo"))).summary?.openFailure?.cause, null, "a refused cause records nothing");
  } finally { await f.close(); }
});

test("a recorded cause lifts the promotion refusal, and escapes count the culprits whose gate was green", async () => {
  const f = await fixture();
  try {
    f.landing("c1");
    f.landing("c2", false);
    f.landing("c3");
    const audit = f.audit("failed");
    const before = (await read(await f.request("/audits?repo=owner/repo"))).summary!;
    assert.ok(promotionRefusal(before));
    assert.deepEqual(before.openFailure?.suspects, [sha("c1"), sha("c2"), sha("c3")]);
    const response = await f.cause({ landings: [sha("c2").slice(0, 12), "landing-3"], note: "found by hand" });
    assert.equal(response.status, 200);
    const recorded = await read(response);
    assert.equal(recorded.operation?.id, audit);
    assert.deepEqual(recorded.operation?.cause?.cause, { kind: "culprits", landings: [sha("c2"), sha("c3")] });
    assert.equal(recorded.operation?.cause?.by, "henry");
    assert.equal(recorded.operation?.cause?.note, "found by hand");
    assert.equal(promotionRefusal(recorded.summary!), null);
    assert.equal(recorded.summary?.escapes, 1, "c3's gate was green; c2 was never gated");
    assert.deepEqual((await read(await f.request("/audits?repo=owner/repo"))).summary, recorded.summary);
  } finally { await f.close(); }
});

test("each of the other causes is recorded, and a failing audit named by id is explained even once a later audit passed", async () => {
  for (const kind of ["flake", "infrastructure", "unresolved"] as const) {
    const f = await fixture();
    try {
      f.landing("d1");
      const failed = f.audit("failed");
      const response = await read(await f.cause({ kind }));
      assert.deepEqual(response.operation?.cause?.cause, { kind });
      assert.equal(response.summary?.openFailure?.cause?.kind, kind);
      assert.equal(response.summary?.escapes, 0);
      f.audit("green");
      const late = await read(await f.cause({ audit: failed, landings: ["landing-1"] }));
      assert.deepEqual(late.operation?.cause?.cause, { kind: "culprits", landings: [sha("d1")] });
      assert.equal(late.summary?.escapes, 1);
      assert.equal(late.summary?.openFailure, null);
    } finally { await f.close(); }
  }
});
