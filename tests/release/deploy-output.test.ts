import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import type { DeployOperation, DeployRecord } from "../../src/lib/runner/runner-types.ts";
const mocks = vi.hoisted(() => ({ readDeploys: vi.fn(), runnerLocation: vi.fn(() => ({ url: "http://fixture" })) }));
vi.mock("../../src/lib/runner/runner-client.ts", () => mocks);
import { runDeploys } from "../../src/launcher/release-commands.ts";

test("deploys prints timing outcomes and JSON carries the record, while old records still print", async () => {
  const record: DeployRecord = { environment: "staging", commitId: "a".repeat(40), previous: null, changes: [],
    startedAt: "2026-10-26T10:00:00.000Z", durationMs: 123,
    projects: [{ name: "app", ok: false, reason: "fixture failure", timings: {
      build: { startedAt: "2026-10-26T10:00:00.000Z", durationMs: 100, outcome: "passed" },
      health: { startedAt: "2026-10-26T10:00:00.100Z", durationMs: 23, outcome: "failed" },
    } }] };
  const operation = { id: "deploy", environment: "staging", commitId: record.commitId, status: "failed", submittedAt: record.startedAt,
    result: { type: "failed", stage: "deploying", reason: "fixture failure", deployment: record } } as DeployOperation;
  mocks.readDeploys.mockResolvedValue([operation]);
  const print = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    assert.equal(await runDeploys([]), 0);
    const output = print.mock.calls.flat().join("\n");
    assert.match(output, /elapsed: 123 ms/);
    assert.match(output, /build: passed, 100 ms/);
    assert.match(output, /health: failed, 23 ms/);
    print.mockClear();
    assert.equal(await runDeploys(["--json"]), 0);
    assert.deepEqual(JSON.parse(String(print.mock.calls[0]![0]))[0].record, record);
    delete record.startedAt; delete record.durationMs; delete record.projects[0]!.timings;
    print.mockClear();
    assert.equal(await runDeploys([]), 0);
    assert.match(print.mock.calls.flat().join("\n"), /app: failed: fixture failure/);
    assert.doesNotMatch(print.mock.calls.flat().join("\n"), /elapsed|undefined|NaN/);
  } finally { print.mockRestore(); }
});
