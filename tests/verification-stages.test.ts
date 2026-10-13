import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runVerificationStages } from "../src/lib/verification-policy.ts";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("consecutive concurrent checks run together after the sequential checks before them", async () => {
  const events: string[] = [];
  const typecheckStarted = signal();
  const checks = [
    { name: "install" },
    { name: "lint", concurrent: true },
    { name: "typecheck", concurrent: true },
  ];
  const outcomes = await runVerificationStages(checks, async (check) => {
    events.push(`${check.name}:start`);
    // Lint can only finish once typecheck has started: they must overlap.
    if (check.name === "lint") await typecheckStarted.promise;
    if (check.name === "typecheck") typecheckStarted.resolve();
    events.push(`${check.name}:end`);
    return check.name;
  });
  assert.deepEqual(outcomes, ["install", "lint", "typecheck"]);
  assert.deepEqual(events.slice(0, 2), ["install:start", "install:end"]);
});

test("a failing concurrent check is reported only after its siblings settle, in declaration order", async () => {
  const settled: string[] = [];
  const checks = [
    { name: "slow", concurrent: true },
    { name: "fails", concurrent: true },
    { name: "later" },
  ];
  await assert.rejects(runVerificationStages(checks, async (check) => {
    if (check.name === "later") throw new Error("a later stage must not start");
    if (check.name === "fails") { settled.push("fails"); throw new Error("fails"); }
    await Promise.resolve();
    settled.push("slow");
    return check.name;
  }), /fails/);
  assert.deepEqual(settled.sort(), ["fails", "slow"]);
});
