/**
 * The test-report contract between a verification command and the runner. For each gate
 * run the runner makes an empty directory and names it in `SLIPJAY_TEST_REPORT_DIR`. A
 * command that wants per-file timings recorded writes its reports there, with a manifest
 * `slipjay-test-reports.json`:
 *
 *   { "version": 1, "reports": [{ "format": "vitest-json" | "bun-junit", "path": "<file in the directory>",
 *     "suite": "<name>", "cwd": "<repository-relative directory the runner ran in>" }] }
 *
 * The runner reads them into `{ file, ms, status }` rows, files relative to the repository.
 * The command's exit status stays the verdict: a report never passes or fails a run, and a
 * missing or malformed one is recorded as such, never as rows.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const TEST_REPORT_DIR_ENV = "SLIPJAY_TEST_REPORT_DIR";
export const TEST_REPORT_MANIFEST = "slipjay-test-reports.json";
const REPORT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5_000;

export type TestReportFormat = "vitest-json" | "bun-junit";
export type TestFileRow = { file: string; suite: string; ms: number; status: "passed" | "failed" | "skipped" };
/** What one run's reports said. */
export type TestReportReading =
  | { status: "recorded"; files: TestFileRow[]; truncated?: boolean }
  /** The command wrote no manifest, as an install or a type check does: no rows, and no zero-duration samples. */
  | { status: "missing" }
  /** A malformed report keeps no rows, so a partial one never reads as a complete run. */
  | { status: "malformed"; reason: string };

type ParsedRow = { file: string; ms: number; status: TestFileRow["status"] };

const decode = (value: string) => value.replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => String.fromCodePoint(code.startsWith("x") ? parseInt(code.slice(1), 16) : Number(code)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const fileStatus = (value: unknown): ParsedRow["status"] => value === "passed" || value === "pass" ? "passed" : value === "skipped" || value === "pending" || value === "todo" ? "skipped" : "failed";

/** Vitest's built-in JSON reporter and Bun's JUnit reporter; nested Bun suites describe the same file. */
export function parseTestReport(source: string, format: TestReportFormat): ParsedRow[] {
  if (format === "vitest-json") {
    const report = JSON.parse(source) as { testResults?: unknown };
    if (!Array.isArray(report.testResults)) throw new Error("no testResults");
    return report.testResults.map((entry) => {
      const file = entry as { name?: unknown; startTime?: unknown; endTime?: unknown; status?: unknown };
      if (typeof file.name !== "string" || typeof file.startTime !== "number" || typeof file.endTime !== "number") throw new Error("a test result lacks name, startTime or endTime");
      return { file: file.name, ms: file.endTime - file.startTime, status: fileStatus(file.status) };
    });
  }
  const root = /<(testsuites?)[\s>]/.exec(source)?.[1];
  if (!root) throw new Error("no testsuite element");
  // A writer stopped partway leaves an open element: such a report is partial, never a short run.
  const opened = source.match(/<testsuite[\s>](?![^>]*\/>)/g)?.length ?? 0;
  if (!new RegExp(`</${root}>\\s*$`).test(source) || opened !== (source.match(/<\/testsuite>/g)?.length ?? 0)) throw new Error("partial report: an element is not closed");
  const files = new Map<string, ParsedRow>();
  for (const match of source.matchAll(/<testsuite\s+([^>]+)>/g)) {
    const attributes = Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((attribute) => [attribute[1], decode(attribute[2]!)]));
    const file = attributes.file;
    if (!file || files.has(file)) continue;
    const tests = Number(attributes.tests);
    files.set(file, { file, ms: Number(attributes.time) * 1000,
      status: Number(attributes.failures) > 0 || Number(attributes.errors) > 0 ? "failed" : tests > 0 && Number(attributes.skipped) === tests ? "skipped" : "passed" });
  }
  return [...files.values()];
}

/** A path the manifest names, refused when it leaves `base`. */
function contained(base: string, path: unknown, label: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path)) throw new Error(`${label} must be a relative path`);
  const resolved = resolve(base, path);
  if (resolved !== base && !resolved.startsWith(base + sep)) throw new Error(`${label} leaves its directory`);
  return resolved;
}

/** One run's reports from `directory`. Never throws. */
export async function readTestReports(directory: string, root: string): Promise<TestReportReading> {
  let manifestText: string;
  try { manifestText = await readFile(join(directory, TEST_REPORT_MANIFEST), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "malformed", reason: `manifest unreadable: ${(error as Error).message}` };
  }
  const files: TestFileRow[] = [];
  try {
    const manifest = JSON.parse(manifestText) as { version?: unknown; reports?: unknown };
    if (manifest.version !== 1 || !Array.isArray(manifest.reports)) throw new Error("manifest is not version 1 with a reports list");
    for (const [index, entry] of manifest.reports.entries()) {
      const report = entry as { format?: unknown; path?: unknown; suite?: unknown; cwd?: unknown };
      const label = `report ${index + 1}`;
      if (report.format !== "vitest-json" && report.format !== "bun-junit") throw new Error(`${label} has an unknown format`);
      if (typeof report.suite !== "string" || !report.suite) throw new Error(`${label} names no suite`);
      const path = contained(directory, report.path, `${label} path`);
      const cwd = report.cwd === undefined || report.cwd === "." ? root : contained(root, report.cwd, `${label} cwd`);
      const source = await readFile(path, "utf8");
      if (Buffer.byteLength(source, "utf8") > REPORT_BYTES) throw new Error(`${label} exceeds ${REPORT_BYTES} bytes`);
      for (const row of parseTestReport(source, report.format)) {
        if (!Number.isFinite(row.ms) || row.ms < 0) throw new Error(`${label} has an invalid duration for ${row.file}`);
        const file = normalize(relative(root, isAbsolute(row.file) ? row.file : resolve(cwd, row.file))).split(sep).join("/");
        files.push({ file, suite: report.suite, ms: Math.round(row.ms), status: row.status });
      }
    }
  } catch (error) {
    return { status: "malformed", reason: (error as Error).message };
  }
  return files.length > MAX_FILES ? { status: "recorded", files: files.slice(0, MAX_FILES), truncated: true } : { status: "recorded", files };
}
