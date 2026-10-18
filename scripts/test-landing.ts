#!/usr/bin/env bun
// The landing gate's tests: only those the candidate can affect. The complete suite runs at
// release (`bun run verify:release`) against the exact commit to be tagged.
//
// Reads the candidate's changed paths with JJ against the integration branch, then runs
// `vp test related <changed files>`, which follows the import graph to every test reaching
// them. It runs the complete suite instead when a change can reach every test (toolchain,
// dependencies, Vitest setup, the hermetic HOME harness), deletes a file (the graph no longer
// shows who imported it), or the candidate cannot be read. The runtime suites always run.
//
//   bun run test:landing
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE = /\.[cm]?[jt]s$/;
/** Paths every test depends on: a change here runs the complete suite. */
const GLOBAL = /^(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|vite\.config\.ts|slipjay\.json|scripts\/(?:vitest-|hermetic-|with-hermetic-home)[^/]*)$/;

export type LandingTests = { kind: "complete"; reason: string } | { kind: "related"; files: string[] } | { kind: "none" };

/** Which tests a candidate's changes need; `deleted` paths existed on the integration branch only. */
export function selectLandingTests(changed: string[], deleted: string[]): LandingTests {
  const global = changed.find((file) => GLOBAL.test(file));
  if (global) return { kind: "complete", reason: `${global} can affect every test` };
  const removed = deleted.find((file) => CODE.test(file));
  if (removed) return { kind: "complete", reason: `${removed} was deleted, so its importers cannot be traced` };
  const files = changed.filter((file) => CODE.test(file) && (file.startsWith("src/") || file.startsWith("tests/")));
  return files.length ? { kind: "related", files } : { kind: "none" };
}

function jj(args: string[]): string {
  const result = spawnSync("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`jj ${args.join(" ")} failed: ${result.stderr || result.error}`);
  return result.stdout;
}

/** The candidate's changes against the integration branch; a retry's empty continuation child stands for its parent. */
function candidateChanges(): { changed: string[]; deleted: string[] } {
  const { integrationBranch } = JSON.parse(readFileSync(path.join(ROOT, "slipjay.json"), "utf8")) as { integrationBranch: string };
  if (!/^[A-Za-z0-9._/-]+$/.test(integrationBranch)) throw new Error("Invalid integration branch in slipjay.json");
  const candidate = jj(["log", "--no-graph", "-r", "@", "-T", "empty"]).trim() === "true" ? "@-" : "@";
  const entries = jj(["diff", "--from", integrationBranch, "--to", candidate, "-T", '"[" ++ json(status) ++ "," ++ json(source.path()) ++ "," ++ json(path) ++ "]\\n"'])
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, string, string]);
  // A rename removes its source path, so it counts as a deletion too.
  const deleted = entries.flatMap(([status, source, target]) => status === "removed" ? [target] : status === "renamed" ? [source] : []);
  return { changed: [...new Set(entries.flatMap(([, source, target]) => [source, target]))], deleted };
}

function run(command: string[]): number {
  console.log(`$ ${command.join(" ")}`);
  return spawnSync(command[0]!, command.slice(1), { cwd: ROOT, stdio: "inherit" }).status ?? 1;
}

if (import.meta.main) {
  let tests: LandingTests;
  try {
    const { changed, deleted } = candidateChanges();
    tests = selectLandingTests(changed, deleted);
  } catch (error) {
    tests = { kind: "complete", reason: `the candidate could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const vitest = tests.kind === "complete" ? (console.log(`Complete suite: ${tests.reason}`), run(["bunx", "vp", "test"]))
    : tests.kind === "related" ? (console.log(`Tests related to ${tests.files.length} changed file(s)`), run(["bunx", "vp", "test", "related", ...tests.files, "--run", "--passWithNoTests"]))
    : (console.log("No source or test changes: no Vitest suites to run"), 0);
  const runtimes = run(["bun", "run", "test:runtimes"]);
  process.exit(vitest || runtimes);
}
