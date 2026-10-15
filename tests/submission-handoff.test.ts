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
