import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeVerificationDeclaration, runVerificationStages } from "../../src/lib/policy/verification-policy.ts";

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

type Check = { name: string; concurrent?: boolean; stop?: boolean };
const stops = (outcome: { stop?: boolean }) => outcome.stop === true;

test("a failed outcome does not stop later stages unless it asks to", async () => {
  const ran: string[] = [];
  const outcomes = await runVerificationStages<Check, { name: string; stop?: boolean }>(
    [{ name: "a" }, { name: "b" }, { name: "c" }],
    async (check) => { ran.push(check.name); return { name: check.name }; }, stops);
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.equal(outcomes.length, 3);
});

test("a stopping outcome ends scheduling after its concurrent siblings settle", async () => {
  const ran: string[] = [];
  const outcomes = await runVerificationStages<Check, { name: string; stop?: boolean }>(
    [{ name: "install" }, { name: "fails", concurrent: true, stop: true }, { name: "sibling", concurrent: true }, { name: "later" }],
    async (check) => {
      ran.push(check.name);
      if (check.name === "sibling") await Promise.resolve();
      return { name: check.name, stop: check.stop };
    }, stops);
  assert.deepEqual(ran, ["install", "fails", "sibling"]);
  assert.deepEqual(outcomes.map((outcome) => outcome.name), ["install", "fails", "sibling"]);
});

test("a thrown error still propagates after its stage settles", async () => {
  await assert.rejects(runVerificationStages<Check, string>([{ name: "a" }, { name: "b" }],
    async (check) => { if (check.name === "a") throw new Error("boom"); return "b"; }), /boom/);
});

test("stopOnFailure is kept when true, absent by default, and refused when not a boolean", () => {
  const base = { executable: "bun", args: ["install"] };
  assert.equal(normalizeVerificationDeclaration({ ...base, stopOnFailure: true }).stopOnFailure, true);
  assert.equal("stopOnFailure" in normalizeVerificationDeclaration(base), false);
  assert.equal("stopOnFailure" in normalizeVerificationDeclaration({ ...base, stopOnFailure: false }), false);
  for (const bad of ["true", 1, {}]) assert.throws(() => normalizeVerificationDeclaration({ ...base, stopOnFailure: bad }), /Malformed/);
});
