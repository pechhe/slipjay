import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({ land: vi.fn(), release: vi.fn(), policy: vi.fn() }));
vi.mock("../../src/lib/runner/runner-client.ts", () => ({
  runnerLocation: () => "http://fixture-runner",
  landThroughRunner: calls.land,
  releaseThroughRunner: calls.release,
}));
vi.mock("../../src/lib/slipjay.ts", () => ({ workspaceContext: async () => null }));
vi.mock("../../src/lib/release/release.ts", () => ({
  confirmableCandidate: async () => ({ status: "confirmable", candidate: "candidate", remote: "origin" }),
}));
vi.mock("../../src/lib/policy/policy-command.ts", () => ({ setPolicy: calls.policy }));

import { runLand } from "../../src/launcher/landing-commands.ts";
import { runPromote } from "../../src/launcher/release-commands.ts";
import { runPolicy } from "../../src/launcher/policy-commands.ts";

test("returning and failing land, promote and policy invocations remove their own signal listeners", async () => {
  const output: string[] = [], progress: string[] = [];
  const stdout = vi.spyOn(console, "log").mockImplementation((line) => { output.push(String(line)); });
  const stderr = vi.spyOn(console, "error").mockImplementation((line) => { progress.push(String(line)); });
  try {
    for (const fail of [false, true]) {
      for (const [kind, invoke, api, result] of [
        ["land", () => runLand([]), calls.land, { ok: true, operation: { kind: "landing", status: "landed" }, logUrl: "fixture-log" }],
        ["promote", () => runPromote(["--confirm", "candidate"]), calls.release, { operation: { kind: "release", status: "released", result: { type: "released", result: { ok: true } } }, logUrl: "fixture-log" }],
        ["policy", () => runPolicy(["set", "--base", "candidate", "--spares", "2"]), calls.policy, { ok: true, phase: "landed" }],
      ] as const) {
        output.length = 0;
        progress.length = 0;
        const before = process.listeners("SIGINT");
        const terms = process.listeners("SIGTERM");
        api.mockImplementationOnce(async (_cwd, options: { signal: AbortSignal; onLine: (line: string) => void }) => {
          const added = process.listeners("SIGINT").filter((listener) => !before.includes(listener));
          assert.equal(added.length, 1, `${kind} registers its listener during invocation`);
          assert.equal(options.signal.aborted, false);
          added[0]!("SIGINT");
          assert.equal(options.signal.aborted, true, `${kind} stops following on interrupt`);
          options.onLine("fixture progress");
          if (fail) throw new Error("fixture failure");
          return result;
        });
        if (fail && kind !== "policy") await assert.rejects(invoke(), /fixture failure/);
        else assert.equal(await invoke(), fail ? 2 : kind === "land" ? undefined : 0);
        assert.deepEqual(process.listeners("SIGINT"), before, `${kind} leaves existing listeners intact`);
        assert.deepEqual(process.listeners("SIGTERM"), terms);
        assert.ok(progress.includes("fixture progress"));
        if (!fail || kind === "policy") {
          assert.equal(output.length, 1);
          const printed = JSON.parse(output[0]!);
          assert.equal(printed.ok, !fail);
          if (fail) assert.equal(printed.reason, "fixture failure");
        } else assert.deepEqual(output, []);
      }
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});


test("land forwards --skip-preflight to the local landing client", async () => {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    calls.land.mockImplementationOnce(async (_cwd, options: { skipPreflight?: boolean }) => {
      assert.equal(options.skipPreflight, true);
      return { ok: true, operation: { kind: "landing", status: "landed" }, logUrl: "fixture-log" };
    });
    await runLand(["--skip-preflight"]);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});
