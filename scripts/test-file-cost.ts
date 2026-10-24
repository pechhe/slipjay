#!/usr/bin/env bun
// What one test file costs on its own, for the nightly audit.
//
// A landing or audit run executes many files at once, so a file's duration there is mostly contention:
// the same file took 27.6 s alone and 74 s inside a 196-file run. This command measures the files the
// current metrics flag, one process at a time, and writes them under the `file-cost` suite. The runner
// keeps that suite separate from every parallel run, and judges the per-file budget on it alone.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_COST_SUITE } from "../src/lib/runner/pipeline-metrics.ts";
import { TEST_REPORT_DIR_ENV, TEST_REPORT_MANIFEST } from "../src/lib/runner/test-reports.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 40;

/** `owner/name` from a git remote URL: scp-style, ssh:// and http(s):// forms. */
export function repositoryKeyFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  const scp = /^[^@/\s]+@[^:/\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (scp) return scp[1]!;
  const parsed = /^(?:ssh|https?|git):\/\/[^/]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(trimmed);
  return parsed ? parsed[1]! : null;
}

type MetricsFile = { file: string; suite: string; samples: number; medianMs: number };
type MetricsRepo = { testFilesOverBudget?: MetricsFile[]; slowestTestFiles?: MetricsFile[]; costCandidates?: MetricsFile[] };

/**
 * The files to measure: the metrics' cost candidates first, then anything it already flags, then the
 * slowest, deduplicated and capped. A path the checkout lacks, a non-test path, and a `file-cost` sample
 * are dropped: the list must be real work that a serial run can measure.
 */
export function chooseFiles(repo: MetricsRepo | undefined, exists: (file: string) => boolean, limit = DEFAULT_LIMIT): string[] {
  const ranked = [...(repo?.costCandidates ?? []), ...(repo?.testFilesOverBudget ?? []), ...(repo?.slowestTestFiles ?? [])];
  const files: string[] = [];
  for (const entry of ranked) {
    if (entry.suite === FILE_COST_SUITE) continue;
    if (!/^(?:tests|scripts)\/.*\.test\.ts$/.test(entry.file) || !exists(entry.file)) continue;
    if (!files.includes(entry.file)) files.push(entry.file);
    if (files.length >= limit) break;
  }
  return files;
}

/** One Vitest JSON report holding every measured Vitest file's results, so the manifest names one report. */
export function mergeVitestReports(sources: string[]): string {
  const testResults: unknown[] = [];
  for (const source of sources) {
    const parsed = JSON.parse(source) as { testResults?: unknown };
    if (!Array.isArray(parsed.testResults)) throw new Error("a measured run wrote no testResults");
    testResults.push(...parsed.testResults);
  }
  return JSON.stringify({ numTotalTestSuites: testResults.length, testResults });
}

/** The repository's runtime lane: the Bun test files `test:runtimes` names. */
export function runtimeFiles(manifest: { scripts?: Record<string, string> }): string[] {
  return (manifest.scripts?.["test:runtimes"] ?? "").trim().split(/\s+/).filter((part) => /^scripts\/.*\.test\.ts$/.test(part));
}

/**
 * One JUnit document holding every measured runtime file's suites. Bun writes one report per run, so each
 * file's report must be kept: merging lets the manifest name one report without losing an earlier file.
 */
export function mergeJunitReports(sources: string[]): string {
  const parts: string[] = [];
  for (const source of sources) {
    const text = source.trim();
    // A wrapper is unwrapped, a bare suite is kept whole; either way the suite XML is never re-split, so a
    // nested suite (Bun emits one per describe) keeps its closing tag.
    const wrapped = /<testsuites(?:\s[^>]*)?>([\s\S]*)<\/testsuites>\s*$/.exec(text);
    if (wrapped) { const inner = wrapped[1]!.trim(); if (inner) parts.push(inner); continue; }
    if (/^<testsuite\s[\s\S]*<\/testsuite>\s*$/.test(text)) { parts.push(text); continue; }
    throw new Error("a measured runtime run wrote no testsuite");
  }
  if (!parts.length) throw new Error("a measured runtime run wrote no testsuite");
  return `<testsuites>\n${parts.join("\n")}\n</testsuites>\n`;
}

/** The repo's key, from `--repo` or the checkout's origin remote; null when neither yields one. */
function repositoryKey(argument: string | undefined): string | null {
  if (argument) return argument;
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" });
  return remote.status === 0 ? repositoryKeyFromRemote(remote.stdout) : null;
}

/** The current metrics' file lists, read through the installed CLI; null when the repository is not in it. */
function metricsRepo(key: string): MetricsRepo | null {
  const result = spawnSync("slipjay", ["metrics", "--json", "--repo", key], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { repositories?: MetricsRepo[] };
    // An empty list is a key the ledger does not hold, not a repository with nothing to measure.
    return parsed.repositories?.[0] ?? null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const flags = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = flags.indexOf(name);
    return index >= 0 && index + 1 < flags.length ? flags[index + 1] : undefined;
  };
  const rawLimit = option("--limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit must be a positive whole number");
  const key = repositoryKey(option("--repo"));
  const reportDir = process.env[TEST_REPORT_DIR_ENV] ? path.resolve(process.env[TEST_REPORT_DIR_ENV]!) : undefined;
  if (!reportDir) {
    console.log(`No ${TEST_REPORT_DIR_ENV}: nothing to measure.`);
    process.exit(0);
  }
  if (!key) throw new Error("No repository key: pass --repo <owner/name> or check out a repository with an origin remote");
  const metrics = metricsRepo(key);
  // A missing list is a broken measurement, not a quiet pass: the nightly audit should say so.
  if (!metrics) throw new Error(`Cannot read ${key}'s metrics: the file-cost run needs them to choose files`);
  const files = chooseFiles(metrics, (file) => existsSync(path.join(ROOT, file)), limit);
  if (!files.length) {
    console.log(`No file is near ${key}'s per-file budget: nothing to measure.`);
    process.exit(0);
  }
  const runtimes = new Set(runtimeFiles(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }));
  console.log(`Measuring ${files.length} files one at a time (from ${key}'s metrics).`);
  const scratch = mkdtempSync(path.join(tmpdir(), "slipjay-file-cost-"));
  const vitest: string[] = [];
  const junit: string[] = [];
  let failed = 0;
  try {
    for (const [index, file] of files.entries()) {
      const started = Date.now();
      let result: { status: number | null };
      if (runtimes.has(file)) {
        // One report per run: Bun writes the file at the end of each, so a shared path would lose the earlier one.
        const output = path.join(scratch, `runtimes-${index}.xml`);
        result = spawnSync("bun", ["test", file, "--reporter=junit", `--reporter-outfile=${output}`], { cwd: ROOT, stdio: "inherit" });
        if (existsSync(output) && statSync(output).size > 0) junit.push(readFileSync(output, "utf8"));
      } else {
        const output = path.join(scratch, `${index}.json`);
        result = spawnSync("bunx", ["vp", "test", "run", file, "--maxWorkers=1", "--no-file-parallelism", "--passWithNoTests", "--reporter=json", `--outputFile.json=${output}`], { cwd: ROOT, stdio: "inherit" });
        if (existsSync(output) && statSync(output).size > 0) vitest.push(readFileSync(output, "utf8"));
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.status !== 0) {
        console.error(`FAILED ${file} after ${seconds}s`);
        failed = result.status ?? 1;
        break;
      }
      console.log(`ok ${file} ${seconds}s`);
    }
    const outputs: { format: "vitest-json" | "bun-junit"; path: string }[] = [];
    mkdirSync(reportDir, { recursive: true });
    if (vitest.length) {
      writeFileSync(path.join(reportDir, "file-cost.json"), mergeVitestReports(vitest));
      outputs.push({ format: "vitest-json", path: "file-cost.json" });
    }
    const junitPath = path.join(reportDir, "file-cost-runtimes.xml");
    if (junit.length) {
      writeFileSync(junitPath, mergeJunitReports(junit));
      outputs.push({ format: "bun-junit", path: "file-cost-runtimes.xml" });
    }
    if (outputs.length) {
      writeFileSync(path.join(reportDir, TEST_REPORT_MANIFEST), JSON.stringify({
        version: 1,
        reports: outputs.map((output) => ({ ...output, suite: FILE_COST_SUITE, cwd: "." })),
      }));
      console.log(`Wrote ${outputs.length} file-cost report(s) covering ${files.length} measured file(s).`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exitCode = failed;
}
