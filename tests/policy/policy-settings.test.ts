import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseExecutionPolicy, retiredFieldsWarning } from "../../src/lib/policy/execution-policy.ts";
import { machineSpareLimit, runnerSetting, setConfiguredRunner, setMachineSpareLimit } from "../../src/lib/policy/machine-config.ts";
import { applyPolicyPatch, parsePolicyPatch, policyDigest, settingsLanding, settingsOnlyDifference, unresolvedExecutables } from "../../src/lib/policy/policy-settings.ts";
import type { SettingsLandingIO } from "../../src/lib/policy/policy-settings.ts";
import { machineConfigPath } from "../../src/lib/workspace/workspace-paths.ts";

const base = JSON.stringify({ version: 1, integrationBranch: "main", spares: 2, requiredLandingVerification: [{ executable: "node", args: ["-e", ""] }],
  migrationFinalization: { mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "node", args: [] }, verify: { executable: "node", args: [] } },
  parallelExecution: true, unattendedMergeToIntegration: true });

test("process round-trips, defaults to standard when absent, and refuses anything else", () => {
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1, process: "light" })).process, "light");
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1 })).process, undefined);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, process: "minimal" })), /process must be "standard", "light" or "development"/);
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1, process: "development" })).process, "development");
  assert.equal(parseExecutionPolicy(applyPolicyPatch(base, { process: "development" }).text).process, "development");
  const { text } = applyPolicyPatch(base, { process: "light" });
  assert.equal(parseExecutionPolicy(text).process, "light");
  assert.equal(parseExecutionPolicy(applyPolicyPatch(text, { process: null }).text).process, undefined);
});

test("budgets are a settings field of positive seconds, and anything else is refused", () => {
  const budgets = { verifyP50Seconds: 90, verifyP90Seconds: 180, testFileSeconds: 30 };
  const { text } = applyPolicyPatch(base, { budgets });
  assert.deepEqual(parseExecutionPolicy(text).budgets, budgets);
  assert.deepEqual(settingsOnlyDifference(base, text), ["budgets", "parallelExecution", "unattendedMergeToIntegration"]);
  assert.equal(parseExecutionPolicy(applyPolicyPatch(text, { budgets: null }).text).budgets, undefined);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, budgets: { verifyP50Seconds: 0 } })), /budgets.verifyP50Seconds must be a positive number of seconds/);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, budgets: { landingSeconds: 5 } })), /budgets declares unknown landingSeconds/);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, budgets: [90] })), /budgets must be an object/);
});

test("a patch sets only settings fields, drops the retired ones and keeps every other declaration", () => {
  assert.throws(() => parsePolicyPatch({ spares: 3, releaseBranch: "release" }), /refused releaseBranch/);
  assert.throws(() => parsePolicyPatch({ migrationFinalization: null }), /refused migrationFinalization/);
  assert.throws(() => parsePolicyPatch({}), /at least one/);
  const { text, policy } = applyPolicyPatch(base, parsePolicyPatch({ spares: 4, requiredLandingVerification: [] }));
  const declared = JSON.parse(text) as Record<string, unknown>;
  assert.equal(declared.parallelExecution, undefined);
  assert.equal(declared.unattendedMergeToIntegration, undefined);
  assert.deepEqual(declared.migrationFinalization, JSON.parse(base).migrationFinalization);
  assert.equal(policy.spares, 4);
  assert.deepEqual(policy.requiredLandingVerification, []);
  // An existing field keeps its place; removing a field restores its default.
  assert.deepEqual(Object.keys(declared).slice(0, 3), ["version", "integrationBranch", "spares"]);
  assert.equal(JSON.parse(applyPolicyPatch(text, { spares: null }).text).spares, undefined);
  // The patched policy must load as a landing would.
  assert.throws(() => applyPolicyPatch(base, { spares: 9 }), /spares must be an integer from 0 to 8/);
  assert.throws(() => applyPolicyPatch(base, { requiredLandingVerification: [{ executable: "bash", args: [] }] }), /unsafe for a landing gate/);
});

test("only a difference confined to settings fields is a settings change; formatting and key order are not differences", () => {
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(base) as Record<string, unknown>).reverse()), null, 2);
  assert.deepEqual(settingsOnlyDifference(base, reordered), []);
  assert.equal(policyDigest(base), policyDigest(reordered));
  assert.deepEqual(settingsOnlyDifference(base, applyPolicyPatch(base, { spares: 3, process: "light" }).text),
    ["spares", "process", "parallelExecution", "unattendedMergeToIntegration"]);
  const migration = { ...JSON.parse(base), migrationFinalization: { ...JSON.parse(base).migrationFinalization, triggerPaths: ["db"] } };
  assert.equal(settingsOnlyDifference(base, JSON.stringify({ ...migration, spares: 3 })), null);
  assert.equal(settingsOnlyDifference(base, JSON.stringify({ ...JSON.parse(base), postIntegration: { version: 1 } })), null);
  assert.equal(settingsOnlyDifference(base, "{not json"), null);
});

test("a settings landing needs its one changed path to be the policy, a current base and checks that resolve", async () => {
  const bin = await mkdtemp(join(tmpdir(), "settings-bin-"));
  try {
    await writeFile(join(bin, "present"), "#!/bin/sh\n");
    await chmod(join(bin, "present"), 0o755);
    assert.deepEqual(await unresolvedExecutables([{ executable: "present", args: [] }, { executable: "absent", args: [] }], bin), ["absent"]);
    const texts: Record<string, string> = { base, candidate: applyPolicyPatch(base, { requiredLandingVerification: [{ executable: "present", args: [] }] }).text };
    const io = (paths: string[], description = ""): SettingsLandingIO => ({
      changedPaths: async () => paths, policyText: async (commit) => texts[commit] ?? null, description: async () => description });
    const eligible = await settingsLanding(io(["slipjay.json"], `Set\n\nPolicy-Base: ${policyDigest(base)}\n`), "base", "candidate", bin);
    assert.deepEqual(eligible?.fields, ["requiredLandingVerification", "parallelExecution", "unattendedMergeToIntegration"]);
    assert.match(eligible!.reason, /proven only when a later landing runs it/);
    assert.equal(await settingsLanding(io(["slipjay.json", "scripts/x.ts"]), "base", "candidate", bin), null);
    assert.equal(await settingsLanding(io(["scripts/x.ts"]), "base", "candidate", bin), null);
    await assert.rejects(settingsLanding(io(["slipjay.json"], "Set\n\nPolicy-Base: sha256:0000\n"), "base", "candidate", bin), /refused as stale/);
    texts.candidate = applyPolicyPatch(base, { requiredLandingVerification: [{ executable: "absent", args: [] }] }).text;
    await assert.rejects(settingsLanding(io(["slipjay.json"]), "base", "candidate", bin), /names absent, which does not resolve on the runner host/);
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test("machine settings record the runner and lower-only spare limits, keeping other keys, and SLIPJAY_RUNNER overrides the file", async () => {
  await mkdir(join(machineConfigPath(), ".."), { recursive: true });
  const previous = await readFile(machineConfigPath(), "utf8").catch(() => null);
  try {
    await writeFile(machineConfigPath(), JSON.stringify({ other: "kept" }));
    await setConfiguredRunner("ssh://peach-box");
    assert.deepEqual(runnerSetting({}), { value: "ssh://peach-box", source: "file", file: "ssh://peach-box", overriddenByEnvironment: false });
    assert.deepEqual(runnerSetting({ SLIPJAY_RUNNER: "http://127.0.0.1:7777" }),
      { value: "http://127.0.0.1:7777", source: "environment", file: "ssh://peach-box", overriddenByEnvironment: true });
    await assert.rejects(setConfiguredRunner("peach-box"), /not a URL/);
    await setMachineSpareLimit("/repos/a", 2);
    await setMachineSpareLimit("/repos/b/", 0);
    assert.equal(machineSpareLimit("/repos/a"), 2);
    assert.equal(machineSpareLimit("/repos/b"), 0);
    await assert.rejects(setMachineSpareLimit("/repos/a", 9), /must be an integer from 0 to 8/);
    await setMachineSpareLimit("/repos/a", null);
    await setConfiguredRunner(null);
    assert.deepEqual(JSON.parse(await readFile(machineConfigPath(), "utf8")), { other: "kept", spares: { "/repos/b": 0 } });
    assert.equal(runnerSetting({}).source, "unset");
  } finally {
    if (previous === null) await rm(machineConfigPath(), { force: true });
    else await writeFile(machineConfigPath(), previous);
  }
});

test("a policy declaring retired fields still loads, and the warning names exactly those it declares", () => {
  assert.equal(parseExecutionPolicy(base).parallelExecution, true);
  assert.equal(retiredFieldsWarning(JSON.parse(base)), "slipjay.json declares parallelExecution and unattendedMergeToIntegration, which drive nothing; remove them (slipjay policy set drops them)");
  assert.match(retiredFieldsWarning({ parallelExecution: false }) ?? "", /declares parallelExecution, which drives nothing; remove it/);
  assert.equal(retiredFieldsWarning({ version: 1 }), null);
  assert.equal(retiredFieldsWarning(null), null);
});
