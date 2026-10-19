import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { postIntegrationPolicy } from "../../src/lib/policy/post-integration-policy.ts";
import { runWorkspaceCommand } from "../../src/lib/infra/workspace-command.ts";

const declaring = (environmentKeys: string[]) => ({
  version: 1, target: "fixture-db", idempotency: "artifact-key", timeoutMs: 1000,
  command: { executable: "node", args: ["finalize.js"] },
  targetProbe: { executable: "node", args: ["probe.js"] },
  environmentKeys,
});

test("declared environment keys may not shadow the finalization prefix", () => {
  assert.deepEqual(postIntegrationPolicy(declaring(["DATABASE_URL"]))?.environmentKeys, ["DATABASE_URL"]);
  for (const key of ["SLIPJAY_FINALIZATION_COMMIT", "SLIPJAY_FINALIZATION_OTHER"]) {
    assert.throws(() => postIntegrationPolicy(declaring([key])), /environment declaration/, key);
  }
});

test("SLIPJAY_COMMAND_TIMEOUT_MS bounds workspace commands, and the retired PEACH_WORKSPACE_COMMAND_TIMEOUT_MS is ignored", async () => {
  const names = ["SLIPJAY_COMMAND_TIMEOUT_MS", "PEACH_WORKSPACE_COMMAND_TIMEOUT_MS"] as const;
  const hang = () => runWorkspaceCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  const timeoutOf = async (env: Partial<Record<(typeof names)[number], string>>) => {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    try {
      const result = await hang();
      assert.notEqual(result.code, 0);
      return /timed out after (\d+)s/.exec(result.stderr)?.[1];
    } finally {
      for (const name of names) delete process.env[name];
    }
  };
  assert.equal(await timeoutOf({ SLIPJAY_COMMAND_TIMEOUT_MS: "1000" }), "1");
  assert.equal(await timeoutOf({ SLIPJAY_COMMAND_TIMEOUT_MS: "2000", PEACH_WORKSPACE_COMMAND_TIMEOUT_MS: "1000" }), "2", "the retired name is not read");
}, 30_000);
