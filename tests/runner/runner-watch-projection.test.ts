import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { projectWatchOperation } from "../../src/lib/runner/runner-watch-projection.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";

test("stage median and current command timeout use recorded evidence", () => {
  const log = openOperationLog(":memory:");
  try {
    const submit = { type: "submitted" as const, repo: "a", changeId: "c", commitId: "x", bookmark: "b", submittedBy: "author" };
    log.append("old", submit); log.append("old", { type: "stage", stage: "verifying" }); log.append("old", { type: "stage", stage: "publishing" });
    log.append("new", submit); log.append("new", { type: "stage", stage: "verifying" });
    const rows = log.events().map((row) => {
      const operationStart = row.operationId === "old" ? 0 : 3_000;
      const time = row.event.type === "stage"
        ? row.operationId === "old" ? row.event.stage === "verifying" ? 1_000 : 2_000 : 4_000
        : operationStart;
      return { ...row, at: new Date(time).toISOString() };
    });
    const operation = log.operation("new")!;
    const projected = projectWatchOperation(operation, rows, new Date(8000));
    assert.equal(projected.timing.medianMs, 1000); assert.equal(projected.timing.amberAfterMs, 2000); assert.equal(projected.timing.state, "amber");
    operation.runs.push({ runId: "r", host: "h", command: "check", startedAt: new Date(7000).toISOString(), timeoutMs: 500 });
    assert.equal(projectWatchOperation(operation, rows, new Date(8000)).timing.state, "red");
    assert.equal(projectWatchOperation(operation, [], new Date(7000)).timing.state, "unknown");
    assert.equal(projectWatchOperation(operation, [], new Date(7000)).timing.amberAfterMs, null);
  } finally { log.close(); }
});

test("an operation shows the Spec its submitter named", () => {
  const log = openOperationLog(":memory:");
  try {
    const submit = { type: "submitted" as const, repo: "a", changeId: "c", commitId: "x", bookmark: "b", submittedBy: "author" };
    const identity = { type: "identity" as const, submitterKind: "agent" as const, submitterId: "h:w", workspace: "w", machine: "h" };
    log.append("named", submit); log.append("named", { ...identity, spec: 189 });
    log.append("other", submit); log.append("other", { ...identity, spec: 7 });
    log.append("unnamed", submit); log.append("unnamed", identity);
    const now = new Date(0);
    assert.equal(projectWatchOperation(log.operation("named")!, log.events(), now).spec, 189);
    assert.equal(projectWatchOperation(log.operation("unnamed")!, log.events(), now).spec, undefined);
  } finally { log.close(); }
});
