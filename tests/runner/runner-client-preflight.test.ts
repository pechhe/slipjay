import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { LandingNotSubmitted, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

async function declare(f: Awaited<ReturnType<typeof fixture>>, landingPreflight: unknown): Promise<void> {
  const path = join(f.cwd, "slipjay.json");
  const policy = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...policy, landingPreflight }));
  jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
}

async function submits(f: Awaited<ReturnType<typeof fixture>>, skipPreflight = false): Promise<void> {
  const running = landThroughRunner(f.cwd, { ...f.options, skipPreflight });
  void running.catch(() => {});
  await waitFor(() => f.log.openOperations().length);
  const operation = f.log.openOperations()[0]!;
  f.append(operation.id, { type: "cancelled", reason: "fixture done" });
  await running;
  assert.equal(f.requestIds.length, 1);
}

test("an undeclared preflight leaves submission unchanged", async () => {
  const f = await fixture();
  try {
    await submits(f);
    assert.ok(!f.lines.some((line) => line.includes("[preflight]")));
  } finally { await f.dispose(); }
});

test("a passing preflight checks the committed candidate in the workspace root and submits", async () => {
  const f = await fixture();
  try {
    await declare(f, { command: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('change.txt', 'utf8'), 'candidate\\n')"] });
    jj(f.cwd, ["new"]); // Land @-: the empty working copy has the same source tree.
    await submits(f);
    assert.ok(f.lines.includes("[preflight] passed"));
  } finally { await f.dispose(); }
});

test("a failing preflight prints both output tails without contacting the runner or publishing a candidate", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await declare(f, { command: [process.execPath, "-e", "console.log('format failure'); console.error('lint failure'); process.exit(2)"] });
    await assert.rejects(landThroughRunner(f.cwd, f.options), (error) => error instanceof LandingNotSubmitted && /Landing refused: preflight .*exited 2; nothing submitted/.test(error.message));
    assert.ok(f.lines.includes("format failure"));
    assert.ok(f.lines.includes("lint failure"));
    assert.equal(fetch.mock.calls.length, 0);
    assert.equal(f.log.events().length, 0);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "pipe" }));
  } finally { fetch.mockRestore(); await f.dispose(); }
});

test("a preflight timeout refuses submission and shows its output", async () => {
  const f = await fixture();
  try {
    await declare(f, { command: [process.execPath, "-e", "console.log('waiting forever'); setInterval(() => {}, 1000)"], timeoutMs: 500 });
    await assert.rejects(landThroughRunner(f.cwd, f.options), /Landing refused: preflight .*timed out after 500ms; nothing submitted/);
    assert.ok(f.lines.includes("waiting forever"));
    assert.equal(f.requestIds.length, 0);
  } finally { await f.dispose(); }
});

test("skip-preflight bypasses a failing command, submits and reports the bypass", async () => {
  const f = await fixture();
  try {
    await declare(f, { command: [process.execPath, "-e", "process.exit(9)"] });
    await submits(f, true);
    assert.ok(f.lines.includes("[preflight] skipped (--skip-preflight)"));
    assert.ok(!f.lines.some((line) => line.includes("[preflight] running")));
  } finally { await f.dispose(); }
});

test("an invalid committed preflight refuses even with the escape hatch", async () => {
  const f = await fixture();
  try {
    await declare(f, { command: [] });
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, skipPreflight: true }), /landingPreflight must be/);
    assert.equal(f.requestIds.length, 0);
  } finally { await f.dispose(); }
});

test("a passing preflight that changes tracked source refuses instead of submitting stale files", async () => {
  const f = await fixture();
  try {
    await declare(f, { command: [process.execPath, "-e", "require('node:fs').writeFileSync('change.txt', 'formatted\\n')"] });
    await assert.rejects(landThroughRunner(f.cwd, f.options), /preflight .*changed tracked source/);
    assert.equal(await readFile(join(f.cwd, "change.txt"), "utf8"), "formatted\n");
    assert.equal(f.requestIds.length, 0);
  } finally { await f.dispose(); }
});
