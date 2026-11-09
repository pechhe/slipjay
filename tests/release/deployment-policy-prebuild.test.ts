import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { deploymentPolicy } from "../../src/lib/policy/deployment-policy.ts";

const command = { executable: "bun", args: ["scripts/images.ts", "build"] };
const environment = (extra: object) => ({ minIntervalMs: 0, timeoutMs: 1000, environmentKeys: [], projects: [{ name: "apps", command, activate: command }], ...extra });
const policy = (name: string, extra: object) => deploymentPolicy({ version: 1, environments: { [name]: environment(extra) } });

test("production with a machine may declare a prebuild", () => {
  assert.equal(policy("production", { machine: "images", prebuild: command })?.environments.production?.prebuild?.executable, "bun");
  assert.equal(policy("production", { machine: "images" })?.environments.production?.prebuild, undefined);
});

test("a prebuild needs production and a machine to build on", () => {
  assert.throws(() => policy("production", { prebuild: command }), /only production with a machine/);
  assert.throws(() => policy("staging", { machine: "images", prebuild: command }), /only production with a machine/);
});
