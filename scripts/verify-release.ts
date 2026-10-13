#!/usr/bin/env bun
// Release verification. A landing runs only the fast static gate in
// the repository policy (slipjay.json); the complete suite, including the disposable-repository
// landing tests, runs here, once, against the exact commit being tagged. It prints
// the commit it verified and exits non-zero on failure. Trace a failure to its
// landing by bisecting `<last tag>..main` and reading the commit's `Issue:` trailer.
//
//   bun run verify:release
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** The complete suite: every Vitest file plus the runtime (node:test, bun:test) suites. */
export const RELEASE_SUITES = [{ name: "test", command: ["bun", "run", "test"] }];

const capture = (command: string[], cwd: string) => spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8" });

/**
 * The committed revision whose tree is the checkout: in JJ, the single parent of
 * an empty working-copy change; in Git, a clean HEAD.
 */
export function resolveVerifiedCommit(root = ROOT, run = capture) {
  if (existsSync(path.join(root, ".jj"))) {
    const state = run(["jj", "--color=never", "log", "--no-graph", "-r", "@", "-T", 'if(empty, "empty", "changed") ++ " " ++ parents.len()'], root);
    if (state.status !== 0) return { ok: false, reason: "jj could not read the working copy" };
    const [change, parents] = state.stdout.trim().split(" ");
    if (change !== "empty") return { ok: false, reason: "the jj working copy has changes; verify a clean checkout of the commit" };
    if (parents !== "1") return { ok: false, reason: "the jj working copy must have exactly one parent" };
    const parent = run(["jj", "--color=never", "log", "--no-graph", "--ignore-working-copy", "-r", "@-", "-T", "commit_id"], root);
    const commit = parent.stdout.trim();
    return parent.status === 0 && COMMIT_ID.test(commit) ? { ok: true, commit } : { ok: false, reason: "jj could not resolve the parent commit" };
  }
  const head = run(["git", "rev-parse", "HEAD"], root);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !COMMIT_ID.test(commit)) return { ok: false, reason: "neither jj nor git can identify the current commit" };
  const status = run(["git", "status", "--porcelain"], root);
  if (status.status !== 0) return { ok: false, reason: "git status failed" };
  if (status.stdout.trim()) return { ok: false, reason: "the git checkout has uncommitted changes; verify a clean checkout of the commit" };
  return { ok: true, commit };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = resolveVerifiedCommit();
  if (!before.ok) {
    console.error(`verify:release cannot verify: ${before.reason}`);
    process.exit(2);
  }
  console.log(`verify:release commit ${before.commit}`);
  const results = RELEASE_SUITES.map((suite) => {
    console.log(`verify:release running ${suite.command.join(" ")}`);
    const started = Date.now();
    const result = spawnSync(suite.command[0]!, suite.command.slice(1), { cwd: ROOT, stdio: "inherit" });
    const exitCode = result.status ?? 1;
    console.log(`verify:release ${suite.name} ${exitCode === 0 ? "passed" : `failed (exit ${exitCode})`} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return exitCode;
  });
  const after = resolveVerifiedCommit();
  if (!after.ok || after.commit !== before.commit) {
    console.error(`verify:release FAILED: the checkout changed during verification (${after.ok ? after.commit : after.reason})`);
    process.exit(1);
  }
  const passed = results.every((code) => code === 0);
  console.log(`verify:release ${passed ? "PASSED" : "FAILED"} for ${before.commit}`);
  process.exit(passed ? 0 : 1);
}
