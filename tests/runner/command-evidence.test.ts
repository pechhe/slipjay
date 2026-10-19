import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { commandEvidence } from "../../src/lib/runner/command-evidence.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import type { BoundedProcessRequest } from "../../src/lib/infra/bounded-process.ts";
import type { LandingOperation } from "../../src/lib/runner/runner-contract.ts";

const request: BoundedProcessRequest = { executable: "bun", args: ["test", "a file.test.ts", "", "--filter=quoted value"], cwd: "/fixture/apps/hq", env: { CI: "1", PATH: "/bin", API_SECRET: "super-secret-value" }, timeoutMs: 123, maxOutputBytes: 500 };

test("command evidence preserves argument boundaries and relative cwd, retaining only environment names", () => {
  const context = commandEvidence(request, "/fixture");
  assert.equal(context.status, "recorded");
  if (context.status !== "recorded") throw new Error("missing context");
  assert.deepEqual(context.args, request.args);
  assert.equal(context.cwd, "apps/hq");
  assert.equal(context.redacted, false);
  assert.deepEqual(context.environmentNames, ["API_SECRET", "CI", "PATH"]);
  assert.doesNotMatch(JSON.stringify(context), /super-secret-value/);
  assert.match(context.configurationSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(commandEvidence({ ...request, env: { ...request.env, CI: "different" } }, "/fixture"), context, "fingerprints do not hash environment values");
  assert.notDeepEqual(commandEvidence({ ...request, timeoutMs: 124 }, "/fixture"), context);
});

test("credential arguments and known environment values are redacted before persistence", () => {
  const context = commandEvidence({ ...request, executable: "/fixture/bin/tool", args: ["--password", "do-not-retain", "--token=inline-secret", "--api-key", "another-secret", "super-secret-value", "https://user:password@example.com/private"] }, "/fixture");
  assert.equal(context.status, "recorded");
  if (context.status !== "recorded") throw new Error("missing context");
  assert.equal(context.redacted, true);
  assert.doesNotMatch(JSON.stringify(context), /do-not-retain|inline-secret|another-secret|super-secret-value|user:password/);
  assert.deepEqual(context.args, ["--password", "[REDACTED]", "--token=[REDACTED]", "--api-key", "[REDACTED]", "[REDACTED]", "[REDACTED_URL]"]);
  assert.equal(context.executable, "[CHECKOUT]/bin/tool");
});

test("outside paths and excessive context are explicit without persisting large or partial arguments", () => {
  const context = commandEvidence({ ...request, cwd: "/other/private" }, "/fixture");
  assert.equal(context.status === "recorded" && context.cwd, null);
  for (const changed of [
    { args: Array.from({ length: 257 }, () => "small") },
    { args: ["x".repeat(32_769)] },
    { env: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"])) },
    { env: { ["NAME".repeat(2049)]: "value" } },
  ]) assert.deepEqual(commandEvidence({ ...request, ...changed }, "/fixture"), { status: "unavailable", reason: "capacity" });
});

test("structured context survives durable run projection and appears in the shared landing outcome", () => {
  const log = openOperationLog(":memory:");
  try {
    const changeId = "k".repeat(32);
    log.append("op_fixture", { type: "submitted", repo: "owner/repo", changeId, commitId: "a".repeat(40), bookmark: candidateBookmark(changeId), submittedBy: "author" });
    const context = commandEvidence(request, "/fixture");
    log.append("op_fixture", { type: "run_started", runId: "run", command: "bun test", host: "fixture", commandEvidence: context });
    const operation = log.operation("op_fixture") as LandingOperation;
    assert.deepEqual(operation.runs[0]?.commandEvidence, context);
    assert.deepEqual(operation.outcome?.runs[0]?.commandEvidence, context);
    assert.equal(operation.outcome?.evidence.gaps.some((gap) => gap.includes("lack structured")), false);
  } finally { log.close(); }
});
