import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vite-plus/test";
import { validSubmissionHandoff, sanitizedHandoff, prepareSubmissionHandoff, handoffDigest } from "../src/lib/submission-handoff.ts";
import type { SubmissionHandoff } from "../src/lib/submission-handoff.ts";

const example = (): SubmissionHandoff => ({ version: 1, source: "a".repeat(40), intent: "Keep restartable source", scope: ["src/lib"],
  spec: { ref: "owner/repo#57", snapshot: "Expected behaviour", bodySha256: createHash("sha256").update("Expected behaviour").digest("hex") },
  helpers: [{ revision: "b".repeat(40), base: "c".repeat(40), scope: "tests" }],
  checks: [{ revision: "a".repeat(40), command: "vp test run tests/example.test.ts", result: "passed", detail: "3 passed" }],
  reviews: [{ revision: "a".repeat(40), reference: "review:57", result: "incomplete", detail: "Unavailable reviewer" }],
  toolchain: [{ name: "bun", version: "1.4.3" }], gaps: ["Repair claim missing"] });

test("handoff validates exact snapshots and bounded structured evidence, preserving explicit incomplete reviews", () => {
  const handoff = example();
  assert.equal(validSubmissionHandoff(handoff), true);
  for (const invalid of [{ ...handoff, spec: { ...handoff.spec, snapshot: "changed" } }, { ...handoff, surprise: "ignored?" },
    { ...handoff, helpers: [{ revision: "mutable", base: "c".repeat(40), scope: "tests" }] },
    { ...handoff, gaps: Array(33).fill("gap") }, { ...handoff, intent: "x".repeat(2001) }]) assert.equal(validSubmissionHandoff(invalid), false);
  assert.equal(handoff.reviews[0]!.result, "incomplete");
  assert.equal(handoffDigest(handoff), handoffDigest(Object.fromEntries(Object.entries(handoff).reverse()) as SubmissionHandoff));
});

test("handoff redacts complete strings and gaps at both ends without mutating author evidence", () => {
  const handoff = example();
  handoff.intent = "Bearer credential-for-test --password \"quoted credential\"";
  handoff.spec!.snapshot = "secret-value-from-author";
  handoff.spec!.bodySha256 = createHash("sha256").update(handoff.spec!.snapshot).digest("hex");
  handoff.gaps = ["secret-value-from-author", "https://user:pass@example.invalid/private"];
  const prepared = prepareSubmissionHandoff(handoff, { APP_SECRET: "secret-value-from-author" });
  assert.equal(validSubmissionHandoff(prepared), true);
  assert.equal(JSON.stringify(prepared).includes("secret-value-from-author"), false);
  assert.equal(JSON.stringify(prepared).includes("user:pass"), false);
  assert.equal(prepared.intent.includes("credential-for-test"), false);
  assert.equal(prepared.intent.includes("quoted credential"), false);
  assert.equal(prepared.gaps.some((gap) => gap.includes("original Spec body SHA256")), true);
  assert.equal(handoff.spec!.snapshot, "secret-value-from-author");
  const server = sanitizedHandoff(prepared, {});
  assert.equal(server.redacted, false);
  assert.throws(() => prepareSubmissionHandoff({ ...handoff, gaps: Array(32).fill("Preserve this gap") }, { APP_SECRET: "secret-value-from-author" }), /capacity/);
});

const binding = (): NonNullable<SubmissionHandoff["build"]> => ({ specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
  ticketIds: ["11111111-2222-4333-8444-555555555555", "66666666-7777-4888-9999-aaaaaaaaaaaa"], bodyRevision: 7, bindGeneration: 2,
  sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" });

test("a Build binding is retained as supplied and changes the evidence digest; absence stays unknown", () => {
  const plain = example();
  assert.equal(validSubmissionHandoff(plain), true);
  assert.equal("build" in plain, false);
  const full = { ...plain, build: binding() };
  assert.equal(validSubmissionHandoff(full), true);
  assert.notEqual(handoffDigest(full), handoffDigest(plain));
  // Unknown stays null and no-Ticket work stays an empty list: neither is coerced to the other or to a default.
  const unknown = { ...plain, build: { ...binding(), ticketIds: [], bodyRevision: null } };
  assert.equal(validSubmissionHandoff(unknown), true);
  assert.deepEqual(prepareSubmissionHandoff(unknown, {}).build, { ...binding(), ticketIds: [], bodyRevision: null });
  assert.deepEqual(prepareSubmissionHandoff(full, {}).build, binding());
});

test("a malformed Build binding is refused", () => {
  const base = example();
  const bad: unknown[] = [null, "x", [], {}, { ...binding(), specId: "not-a-uuid" }, { ...binding(), sessionId: undefined },
    { ...binding(), ticketIds: ["nope"] }, { ...binding(), ticketIds: [binding().specId, binding().specId] },
    { ...binding(), ticketIds: [binding().specId, binding().specId.toUpperCase()] },
    { ...binding(), ticketIds: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) },
    { ...binding(), bodyRevision: undefined }, { ...binding(), bodyRevision: "7" }, { ...binding(), bodyRevision: -1 }, { ...binding(), bodyRevision: 1.5 },
    { ...binding(), bindGeneration: 0 }, { ...binding(), bindGeneration: null }, { ...binding(), bodySha256: "a".repeat(64) },
    { ...binding(), extra: true }];
  for (const build of bad) assert.equal(validSubmissionHandoff({ ...base, build }), false, JSON.stringify(build));
});
