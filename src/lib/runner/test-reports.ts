/**
 * The test-report contract between a verification command and the runner. For each gate
 * run the runner makes an empty directory and names it in `SLIPJAY_TEST_REPORT_DIR`. A
 * command that wants per-file timings recorded writes its reports there, with a manifest
 * `slipjay-test-reports.json`:
 *
 *   { "version": 1, "selection": { "kind": "complete" | "related" | "none" },
 *     "reports": [{ "format": "vitest-json" | "bun-junit", "path": "<file in the directory>",
 *     "suite": "<name>", "cwd": "<repository-relative directory the runner ran in>" }] }
 *
 * `selection` is optional and additive: a writer that omits it, and a reader that predates it,
 * keep working exactly as before, so a new gate can describe itself without the runner that
 * reads it having to land first. `timing`, as additive, is where a gate that schedules suites of
 * its own says where its time went:
 *
 *   "timing": { "wallMs": n, "concurrency": n, "criticalSuite": "<name>", "serialTailMs": n,
 *     "unusedPermitMs": n, "idleMs": n, "lockWaitMs": n,
 *     "suites": [{ "name": "<suite>", "queueMs": n, "startMs": n, "finishMs": n, "permits": n }] }
 *
 * `outcomes`, also additive (SJ-192), is each suite's own verdict, so a failed run says which suites failed and a
 * rerun can be narrowed to them (`SLIPJAY_RELEASE_SUITES`); `missing` is a suite asked for that the command's selection
 * does not hold at this revision:
 *
 *   "outcomes": [{ "suite": "<name>", "outcome": "passed" | "failed" | "missing" }]
 *
 * Only `wallMs` and `suites` are required; a timing that does not fit this shape is dropped, never
 * a reason to refuse the run's rows. `suite` separates measurements that must never pool: a
 * landing's selected run, an audit's complete one, and the file-cost run that measures one
 * file at a time are three different suites.
 *
 * The runner reads them into `{ file, ms, status }` rows, files relative to the repository.
 * The command's exit status stays the verdict: a report never passes or fails a run, and a
 * missing or malformed one is recorded as such, never as rows.
 *
 * A command may also write diagnostic logs under `logs/` in the directory, such as the full
 * output of a sub-check it only summarises. When the run fails, the runner keeps them in the
 * run's output artifact (`slipjay runner artifact`); a passing run's logs are discarded.
 */
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const TEST_REPORT_DIR_ENV = "SLIPJAY_TEST_REPORT_DIR";
export const TEST_REPORT_MANIFEST = "slipjay-test-reports.json";
const REPORT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5_000;
/** The directory, under the report directory, whose files a failed run keeps. */
export const TEST_REPORT_LOGS = "logs";
const MAX_LOGS = 16;
/** A longer log is read from its end, where its failure is. */
const LOG_READ_BYTES = 4 * 1024 * 1024;

/** One log a run left under `logs/`: its path there, and its last LOG_READ_BYTES. */
export type RetainedLog = { path: string; content: string; truncated: boolean };

export type TestReportFormat = "vitest-json" | "bun-junit";
export type TestFileRow = { file: string; suite: string; ms: number; status: "passed" | "failed" | "skipped" };
/** How the gate chose the tests a landing verified: the whole suite, the import graph, or nothing. */
export const TEST_SELECTION_KINDS = ["complete", "related", "none"] as const;
export type TestSelectionKind = (typeof TEST_SELECTION_KINDS)[number];
/** One suite a gate scheduled: when it waited, started and finished, from the gate's start, and its permits. */
export type GateSuiteTiming = { name: string; queueMs: number; startMs: number; finishMs: number; permits: number };
/** Where a gate's time went: its wall time, its critical path (the suite that finished last) and its idle capacity. */
export type GateTiming = {
  wallMs: number; concurrency?: number; criticalSuite?: string; serialTailMs?: number;
  unusedPermitMs?: number; idleMs?: number; lockWaitMs?: number; suites: GateSuiteTiming[];
};
/** One suite's own verdict in a run (`outcomes`). */
export type SuiteOutcome = { suite: string; outcome: "passed" | "failed" | "missing" };
const SUITE_OUTCOMES = ["passed", "failed", "missing"] as const;
const MAX_OUTCOMES = 500;
/** What one run's reports said. */
export type TestReportReading =
  | { status: "recorded"; files: TestFileRow[]; truncated?: boolean; selection?: TestSelectionKind; timing?: GateTiming; outcomes?: SuiteOutcome[] }
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

const MAX_TIMED_SUITES = 1_000;
const TIMING_NUMBERS = ["concurrency", "serialTailMs", "unusedPermitMs", "idleMs", "lockWaitMs"] as const;
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const suiteName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** A manifest's `timing`, kept only when it fits the contract's shape; unknown fields are not kept. */
export function gateTiming(value: unknown): GateTiming | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const timing = value as Record<string, unknown>;
  if (!duration(timing.wallMs) || !Array.isArray(timing.suites) || timing.suites.length > MAX_TIMED_SUITES) return undefined;
  const suites: GateSuiteTiming[] = [];
  for (const entry of timing.suites) {
    const suite = (entry ?? {}) as Record<string, unknown>;
    if (!suiteName(suite.name) || !duration(suite.queueMs) || !duration(suite.startMs) || !duration(suite.finishMs) || !duration(suite.permits)) return undefined;
    suites.push({ name: suite.name, queueMs: Math.round(suite.queueMs), startMs: Math.round(suite.startMs), finishMs: Math.round(suite.finishMs), permits: suite.permits });
  }
  const kept: GateTiming = { wallMs: Math.round(timing.wallMs), suites };
  for (const key of TIMING_NUMBERS) {
    if (timing[key] === undefined) continue;
    if (!duration(timing[key])) return undefined;
    kept[key] = Math.round(timing[key]);
  }
  if (timing.criticalSuite !== undefined) {
    if (!suiteName(timing.criticalSuite)) return undefined;
    kept.criticalSuite = timing.criticalSuite;
  }
  return kept;
}

/** The manifest's `outcomes`, or undefined when absent or not of the contract's shape: never a reason to refuse the rows. */
function suiteOutcomes(value: unknown): SuiteOutcome[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OUTCOMES) return undefined;
  const kept: SuiteOutcome[] = [];
  for (const entry of value as { suite?: unknown; outcome?: unknown }[]) {
    if (!entry || !suiteName(entry.suite) || !(SUITE_OUTCOMES as readonly unknown[]).includes(entry.outcome)) return undefined;
    kept.push({ suite: entry.suite as string, outcome: entry.outcome as SuiteOutcome["outcome"] });
  }
  return kept;
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
  let selection: TestSelectionKind | undefined;
  let timing: GateTiming | undefined;
  let outcomes: SuiteOutcome[] | undefined;
  try {
    const manifest = JSON.parse(manifestText) as { version?: unknown; selection?: unknown; timing?: unknown; reports?: unknown; outcomes?: unknown };
    if (manifest.version !== 1) throw new Error("manifest is not version 1");
    if (!Array.isArray(manifest.reports)) throw new Error("manifest is not versioned with a reports list");
    // `selection` is additive to version 1, so a reader that predates it ignores it. A kind the contract
    // does not name is dropped rather than kept as a fourth one.
    if (manifest.selection !== undefined) {
      const kind = (manifest.selection as { kind?: unknown } | null)?.kind;
      if (typeof kind === "string" && (TEST_SELECTION_KINDS as readonly string[]).includes(kind)) selection = kind as TestSelectionKind;
    }
    timing = gateTiming(manifest.timing);
    outcomes = suiteOutcomes(manifest.outcomes);
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
  const described = { ...(selection ? { selection } : {}), ...(timing ? { timing } : {}), ...(outcomes ? { outcomes } : {}) };
  if (files.length > MAX_FILES) return { status: "recorded", files: files.slice(0, MAX_FILES), truncated: true, ...described };
  return { status: "recorded", files, ...described };
}

/** The regular files under `directory`'s `logs/`, in path order, at most MAX_LOGS of them. Never throws. */
export async function readRetainedLogs(directory: string): Promise<RetainedLog[]> {
  const base = join(directory, TEST_REPORT_LOGS);
  const paths: string[] = [];
  const walk = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(base, relativeDirectory), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      // Symbolic links are never followed, so a log can only be a file the command wrote here.
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await walk("");
  const logs: RetainedLog[] = [];
  for (const path of paths.slice(0, MAX_LOGS)) {
    try {
      const file = join(base, path);
      const { size } = await lstat(file);
      const handle = await open(file, "r");
      try {
        const length = Math.min(size, LOG_READ_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        logs.push({ path, content: buffer.toString("utf8"), truncated: size > length });
      } finally { await handle.close(); }
    } catch { /* A log that vanished or cannot be read is left out; the run's own output still stands. */ }
  }
  return logs;
}
