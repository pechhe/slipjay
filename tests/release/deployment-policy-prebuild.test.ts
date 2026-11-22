import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { deploymentPolicy } from "../../src/lib/policy/deployment-policy.ts";

const command = { executable: "bun", args: ["scripts/images.ts", "build"] };
const environment = (extra: object) => ({ minIntervalMs: 0, timeoutMs: 1000, environmentKeys: [], projects: [{ name: "apps", command, activate: command }], ...extra });
const policy = (name: string, extra: object) => deploymentPolicy({ version: 1, environments: { [name]: environment(extra) } });

test("a deploy may declare a preflight command but cannot escape its source view", () => {
  assert.deepEqual(policy("production", { preflight: command })?.environments.production?.preflight, { ...command, cwd: "." });
  assert.equal(policy("staging", {})?.environments.staging?.preflight, undefined);
  assert.throws(() => policy("staging", { preflight: { executable: "bun" } }), /Invalid preflight command/);
  assert.throws(() => policy("production", { preflight: { ...command, cwd: ".." } }), /Preflight cwd must stay within/);
});

test("production with a machine may declare a prebuild", () => {
  assert.equal(policy("production", { machine: "images", prebuild: command })?.environments.production?.prebuild?.executable, "bun");
  assert.equal(policy("production", { machine: "images" })?.environments.production?.prebuild, undefined);
});

test("a prebuild needs production and a machine to build on", () => {
  assert.throws(() => policy("production", { prebuild: command }), /only production with a machine/);
  assert.throws(() => policy("staging", { machine: "images", prebuild: command }), /only production with a machine/);
});

test("a prebuild may name exit codes that say it could not build, bounded as an audit command's are", () => {
  assert.deepEqual(policy("production", { machine: "images", prebuild: { ...command, inconclusiveExitCodes: [2, 2] } })?.environments.production?.prebuild?.inconclusiveExitCodes, [2]);
  for (const codes of [[], [1], [126], ["2"]])
    assert.throws(() => policy("production", { machine: "images", prebuild: { ...command, inconclusiveExitCodes: codes } }), /inconclusiveExitCodes/);
});
