import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { primaryCheckoutDisposition } from "../../src/lib/landing/landing-candidate.ts";
import { refreshPrimaryDependencies } from "../../src/lib/workspace/primary-dependencies.ts";
import type { PrimaryDependencyHost } from "../../src/lib/workspace/primary-dependencies.ts";

function host(inputs: { value: string | null }, options: { fail?: boolean; editSource?: boolean } = {}) {
  const installs: string[] = [];
  let source = "source";
  const value: PrimaryDependencyHost = {
    fingerprint: async () => inputs.value,
    install: async (_root, installInputs) => {
      installs.push(installInputs);
      if (options.fail) throw new Error("registry unreachable");
      if (options.editSource) source = "edited";
    },
    sourceId: async () => source,
  };
  return { value, installs };
}

test("a primary checkout with no recorded install installs once, then only when its inputs change", async () => {
  const inputs = { value: "a" };
  const { value, installs } = host(inputs);
  const root = "/primary-record";
  assert.equal(await refreshPrimaryDependencies(root, value), undefined);
  assert.equal(await refreshPrimaryDependencies(root, value), undefined);
  assert.deepEqual(installs, ["a"]);
  inputs.value = "b";
  assert.equal(await refreshPrimaryDependencies(root, value), undefined);
  assert.deepEqual(installs, ["a", "b"]);
});

test("a failed install is a warning and is retried, not recorded", async () => {
  const inputs = { value: "a" };
  const root = "/primary-failure";
  const failing = host(inputs, { fail: true });
  assert.match((await refreshPrimaryDependencies(root, failing.value))!, /could not be installed: registry unreachable/);
  const working = host(inputs);
  assert.equal(await refreshPrimaryDependencies(root, working.value), undefined);
  assert.deepEqual(working.installs, ["a"]);
});

test("an install that edits tracked source is reported and not recorded", async () => {
  const inputs = { value: "a" };
  const root = "/primary-edits";
  const editing = host(inputs, { editSource: true });
  assert.match((await refreshPrimaryDependencies(root, editing.value))!, /changed its tracked source/);
  const retry = host(inputs);
  await refreshPrimaryDependencies(root, retry.value);
  assert.deepEqual(retry.installs, ["a"]);
});

test("a repository without install inputs installs nothing", async () => {
  const { value, installs } = host({ value: null });
  assert.equal(await refreshPrimaryDependencies("/primary-none", value), undefined);
  assert.deepEqual(installs, []);
});

function disposition(refresh: (root: string) => Promise<string | undefined>, state: "moved" | "current" | "conflict") {
  const facts = (revision: string) => ({ changeId: "c", commitId: revision === "@-" && state === "current" ? "tip" : revision === "main" ? "tip" : "old",
    empty: true, conflict: state === "conflict", description: "" });
  return primaryCheckoutDisposition({ integration: { name: "default", root: "/repo" }, integrationBranch: "main" },
    { revisionFacts: async (_cwd, revision) => facts(revision), jj: async () => "", refreshPrimaryDependencies: refresh }, { carryEdits: false });
}

test("a moved or current primary checkout refreshes dependencies and a failure leaves the move in place", async () => {
  const roots: string[] = [];
  assert.deepEqual(await disposition(async (root) => { roots.push(root); return undefined; }, "moved"), { action: "moved" });
  assert.deepEqual(await disposition(async (root) => { roots.push(root); return undefined; }, "current"), { action: "current" });
  assert.deepEqual(roots, ["/repo", "/repo"]);
  assert.deepEqual(await disposition(async () => "install failed", "moved"), { action: "moved", warning: "install failed" });
});

test("a primary checkout left in place installs nothing", async () => {
  let called = false;
  const outcome = await disposition(async () => { called = true; return undefined; }, "conflict");
  assert.equal(outcome.action, "left");
  assert.equal(called, false);
});
