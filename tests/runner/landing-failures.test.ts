import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatLandingFailures, landingFailures } from "../../src/lib/runner/landing-failures.ts";
import type { ClassifiedFact, OperationEvent, StoredEvent } from "../../src/lib/runner/runner-types.ts";

let seq = 0;
const rows: StoredEvent[] = [];
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 0, minute)).toISOString();
const emit = (operationId: string, minute: number, event: OperationEvent) => rows.push({ seq: ++seq, operationId, at: at(minute), event });
const fact = (cause: ClassifiedFact["cause"], extra: Partial<ClassifiedFact> = {}): ClassifiedFact =>
  ({ type: "classified", ruleVersion: 3, cause, failingTests: [], diagnostics: [], ...extra });
/** One landing attempt: submitted at `minute`, ending in `outcome`, with an optional classification and source identity. */
function attempt(id: string, minute: number, change: string, outcome: "landed" | "failed", options: { reason?: string; classified?: ClassifiedFact; identity?: string; commit?: string } = {}) {
  emit(id, minute, { type: "submitted", repo: "Acme/App", changeId: change, commitId: options.commit ?? `${id}-commit`, bookmark: `b-${id}`, submittedBy: "author" });
  if (options.identity) emit(id, minute, { type: "source_identity", digest: options.identity });
  if (options.classified) emit(id, minute + 1, options.classified);
  emit(id, minute + 1, outcome === "landed"
    ? { type: "landed", base: "base", commitId: `${id}-landed`, branch: "develop", remote: "origin" }
    : { type: "failed", stage: "screening", reason: options.reason ?? "Required verification failed (nonzero_exit)" });
}

const gate = (extra: Partial<ClassifiedFact>) => fact("gate", { command: "bun run test:landing:affected", ...extra });
// A flake: the same source (identity) fails, then lands after a rebase changed its commit.
attempt("flaky", 0, "c1", "failed", { identity: "same", classified: gate({ failingTests: ["a.test.ts > passes on a rerun"], firstErrors: [{ test: "a.test.ts > passes on a rerun", error: "AssertionError: expected 1 to be 2" }] }) });
attempt("flaky-landed", 10, "c1", "landed", { identity: "same" });
// A timeout the change outlived, though its source changed in between.
attempt("timeout", 20, "c2", "failed", { identity: "first", classified: gate({ failingTests: ["b.test.ts > slow"], firstErrors: [{ test: "b.test.ts > slow", error: "Error: Test timed out in 5000ms." }] }) });
attempt("timeout-landed", 30, "c2", "landed", { identity: "second" });
// Static checks a check before submission can run.
attempt("design", 40, "c3", "failed", { classified: fact("gate", { command: "bun run check:design --gate", diagnostics: ['12:4  error  "font-normal" is not allowed on <Button>'],
  failureCauses: ['design lint: apps/web/src/a.svelte:12:4 "font-normal" is not allowed on <Button>'] }) });
attempt("types", 50, "c4", "failed", { classified: gate({ failureCauses: ["yardsmith typecheck: typecheck failed: svelte-check found 1 error"], diagnostics: ["Error: Related landing tests failed: 1 suite failed without a named test (yardsmith typecheck)"] }) });
// A real defect the gate's tests found, fixed in a new source that then landed.
attempt("defect", 60, "c5", "failed", { identity: "broken", classified: gate({ failingTests: ["c.test.ts > adds"], firstErrors: [{ test: "c.test.ts > adds", error: "AssertionError: expected 3 to be 4" }] }) });
attempt("defect-landed", 70, "c5", "landed", { identity: "fixed" });
// A gate failure naming nothing the author can open.
attempt("unnamed", 80, "c6", "failed", { classified: gate({ failureCauses: ['app: app exited 1: error: script "test:release:prepared" exited with code 1'], diagnostics: ["Error: Related landing tests failed: 1 suite failed without a named test (app)"] }) });
// The runner and the author's rebase.
attempt("restart", 90, "c7", "failed", { reason: "runner restarted during fetching; land again", classified: fact("infrastructure") });
attempt("conflict", 100, "c8", "failed", { reason: "Rebase produced conflicts; resolve them", classified: fact("conflict") });
attempt("moved", 110, "c9", "failed", { classified: gate({ failureCauses: ["candidate or integration parent moved during verification"] }) });
attempt("clean", 120, "c10", "landed");

test("classifies each failed landing by what the ledger shows, first matching class winning", () => {
  const report = landingFailures(rows, "acme/app", { since: at(0) });
  const classOf = Object.fromEntries(report.failures.map((failure) => [failure.operationId, failure.class]));
  assert.deepEqual(classOf, { flaky: "flake", timeout: "flake", design: "catchable", types: "catchable", defect: "gate", unnamed: "gate",
    restart: "infrastructure", conflict: "conflict", moved: "infrastructure" });
  assert.deepEqual(report.byClass, { flake: 2, catchable: 2, gate: 2, infrastructure: 2, conflict: 1 });
  assert.deepEqual([report.attempts, report.landed, report.failed], [13, 4, 9]);
  // Eight of thirteen ended attempts failed other than on a conflict.
  assert.equal(report.failureRate, 8 / 13);
  // Only the gate failure that names no test or location, and the type check that names only an error count, not a place.
  assert.deepEqual(report.failures.filter((failure) => failure.unnamed).map((failure) => failure.operationId), ["types", "unnamed"]);
  assert.match(formatLandingFailures(report), /flake 2, catchable 2, gate 2, infrastructure 2, conflict 1; 2 named no test or location/);
});

test("a window reads the first N attempts from its start, and judges each by what landed after the window", () => {
  const first = landingFailures(rows, "acme/app", { since: at(20), first: 2 });
  assert.deepEqual(first.failures.map((failure) => [failure.operationId, failure.class]), [["timeout", "flake"]]);
  assert.equal(first.attempts, 2);
  const until = landingFailures(rows, "acme/app", { since: at(0), until: at(15) });
  assert.deepEqual(until.failures.map((failure) => [failure.operationId, failure.class]), [["flaky", "flake"]]);
  assert.equal(landingFailures(rows, "other/app", { since: at(0) }).attempts, 0);
});

test("without a recorded source identity, only the same commit landing later makes a failure a flake", () => {
  const events: StoredEvent[] = [];
  const add = (id: string, minute: number, event: OperationEvent) => events.push({ seq: events.length + 1, operationId: id, at: at(minute), event });
  add("one", 0, { type: "submitted", repo: "acme/app", changeId: "c", commitId: "same", bookmark: "b", submittedBy: "a" });
  add("one", 1, gate({ failingTests: ["x.test.ts > y"] }));
  add("one", 1, { type: "failed", stage: "screening", reason: "Required verification failed" });
  add("two", 2, { type: "submitted", repo: "acme/app", changeId: "c", commitId: "edited", bookmark: "b", submittedBy: "a" });
  add("two", 3, { type: "landed", base: "b", commitId: "l", branch: "develop", remote: "origin" });
  assert.equal(landingFailures(events, "acme/app", { since: at(0) }).failures[0]!.class, "gate");
  add("three", 4, { type: "submitted", repo: "acme/app", changeId: "c", commitId: "same", bookmark: "b", submittedBy: "a" });
  add("three", 5, { type: "landed", base: "b", commitId: "l2", branch: "develop", remote: "origin" });
  assert.equal(landingFailures(events, "acme/app", { since: at(0) }).failures[0]!.class, "flake");
});

test("counts the repository's recorded landing preflights in the window, naming each refusal", () => {
  const events: StoredEvent[] = [];
  const add = (id: string, minute: number, event: OperationEvent) => events.push({ seq: events.length + 1, operationId: id, at: at(minute), event });
  add("client-a", 0, { type: "client_operation", repo: "Acme/App", workspace: "ws", machine: "box" });
  add("client-a", 1, { type: "client", id: "1", fact: { kind: "preflight", workspace: "ws", commitId: "a".repeat(40), outcome: "refused", durationMs: 4000, reason: "landing preflight FAIL: 1 of 6 checks failed (design lint)" } });
  add("client-a", 2, { type: "client", id: "2", fact: { kind: "preflight", workspace: "ws", commitId: "b".repeat(40), outcome: "passed", durationMs: 3000 } });
  add("client-b", 3, { type: "client_operation", repo: "other/app", workspace: "ws2", machine: "box" });
  add("client-b", 4, { type: "client", id: "3", fact: { kind: "preflight", workspace: "ws2", commitId: "c".repeat(40), outcome: "refused", durationMs: 1000, reason: "elsewhere" } });
  const report = landingFailures(events, "acme/app", { since: at(0) });
  assert.deepEqual([report.preflight.passed, report.preflight.refused], [1, 1]);
  assert.match(report.preflight.refusals[0]!.reason, /design lint/);
  assert.match(formatLandingFailures(report), /Landing preflight: 1 passed, 1 refused before submission/);
});

test("a diagnostic that only echoes the failed command names nothing", () => {
  const events: StoredEvent[] = [];
  const add = (id: string, minute: number, event: OperationEvent) => events.push({ seq: events.length + 1, operationId: id, at: at(minute), event });
  add("echo", 0, { type: "submitted", repo: "acme/app", changeId: "e", commitId: "e1", bookmark: "b", submittedBy: "a" });
  add("echo", 1, gate({ diagnostics: ["Required verification failed (nonzero_exit): bun scripts/with-heavy-check-lock.ts bun run test"] }));
  add("echo", 1, { type: "failed", stage: "screening", reason: "Required verification failed" });
  assert.equal(landingFailures(events, "acme/app", { since: at(0) }).failures[0]!.unnamed, true);
});

test("a lint report's bare line and column, with no file, names nothing", () => {
  const events: StoredEvent[] = [];
  const add = (id: string, minute: number, event: OperationEvent) => events.push({ seq: events.length + 1, operationId: id, at: at(minute), event });
  add("bare", 0, { type: "submitted", repo: "acme/app", changeId: "d", commitId: "d1", bookmark: "b", submittedBy: "a" });
  add("bare", 1, fact("gate", { command: "bun run check:design --gate", diagnostics: ['12:4  error  "font-normal" is not allowed on <Button>: add a variant in packages/ui/src/button/button.svelte'] }));
  add("bare", 1, { type: "failed", stage: "screening", reason: "Required verification failed" });
  const [failure] = landingFailures(events, "acme/app", { since: at(0) }).failures;
  assert.deepEqual([failure!.class, failure!.unnamed], ["catchable", true]);
});
