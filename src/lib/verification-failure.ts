// Turns a failed verification command's output into a bounded summary an agent can
// act on without rerunning the check: which tests failed, the first error, whether
// it timed out, the first lint/type diagnostics, and a short output tail.

type VerificationFailureResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  timedOut?: boolean;
};

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const NOISE = /ExperimentalWarning|--trace-warnings|VITE_CONFIG_NATIVE_IGNORE_WARNING|configLoader: 'native'|ESM syntax in a file loaded as CommonJS/;
const MAX_TESTS = 10;
const MAX_ERROR_LINES = 8;
const MAX_DIAGNOSTICS = 8;
const TAIL_LINES = 30;
const MAX_LINE_CHARS = 300;
const MAX_SUMMARY_CHARS = 6_000;

const TIMEOUT = /\b(?:Test|Hook|this test) timed out\b|\btimed out after \d+ ?ms|\bexceeded timeout of\b|^TimeoutError\b/i;
// Package-runner epilogue ("error: script "test" exited with code 1"): kept in the tail only.
const SCRIPT_EXIT = /^error: script ".*" exited with code/;
const ASSERTION = /AssertionError|ERR_ASSERTION|^error: expect\(|expected .* to /;
const ERROR_START = /^(?:[A-Z]\w*(?:Error|Exception)(?: \[\w+\])?|Error|error|panic):/;
const DIAGNOSTIC = /\berror\b[^:]*:|\berror TS\d+|^\s*×\s|^Error: /;
const POSITION = /[\w./-]+\.[a-z]+(?::\d+:\d+|\(\d+,\d+\))/;

const clip = (line: string): string => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line);

function outputLines(result: VerificationFailureResult): string[] {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !NOISE.test(line));
}

/** Failing test identities from Vitest, Bun test and node:test (TAP or spec) output. */
function failingTests(lines: string[]): string[] {
  const found: string[] = [];
  let bunFile: string | null = null;
  let tapLocation: string | null = null;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let match: RegExpExecArray | null;
    if ((match = /^FAIL\s+(.+)$/.exec(trimmed))) found.push(match[1]!);
    else if (/^[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(trimmed)) bunFile = trimmed.slice(0, -1);
    else if ((match = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(trimmed))) found.push(bunFile ? `${bunFile} > ${match[1]!}` : match[1]!);
    else if ((match = /^not ok \d+ - (.+)$/.exec(trimmed))) {
      const location = lines.slice(index + 1, index + 8).map((next) => /location: '(.+?):\d+:\d+'/.exec(next)?.[1]).find(Boolean);
      found.push(location ? `${location} > ${match[1]!}` : match[1]!);
    } else if ((match = /^test at (.+?):\d+:\d+$/.exec(trimmed))) tapLocation = match[1]!;
    else if ((match = /^✖ (.+?) \([\d.]+m?s\)$/.exec(trimmed)) && tapLocation) {
      found.push(`${tapLocation} > ${match[1]!}`);
      tapLocation = null;
    }
  }
  return [...new Set(found)];
}

/** The first error block: its message line and the few lines that explain it. */
function firstError(lines: string[]): string[] {
  const start = lines.findIndex((line) => (ERROR_START.test(line.trim()) && !SCRIPT_EXIT.test(line.trim())) || /^\s+error: \|-?$/.test(line));
  if (start < 0) return [];
  const block = [lines[start]!.trim()];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (block.length >= MAX_ERROR_LINES || /^(?:❯|at |⎯|FAIL\b|\(fail\)|not ok |stack:|code: |\d+ \|)/.test(trimmed)) break;
    block.push(trimmed);
  }
  return block;
}

/** First compiler/linter diagnostics, with a preceding position line when the message has none. */
function diagnostics(lines: string[]): string[] {
  const found: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!DIAGNOSTIC.test(line) || SCRIPT_EXIT.test(line.trim()) || /^\s*(?:Tests?|Test Files)\b/.test(line)) continue;
    const previous = lines[index - 1]?.trim() ?? "";
    const withPosition = !POSITION.test(line) && POSITION.test(previous) ? `${previous} ${line.trim()}` : line.trim();
    found.push(withPosition);
    if (found.length >= MAX_DIAGNOSTICS) break;
  }
  return found;
}

/** "timeout", "assertion" (both when both occurred), else "diagnostics" or "error". */
function failureKind(result: VerificationFailureResult, lines: string[], tests: string[]): string {
  const kinds: string[] = [];
  if (result.timedOut || result.signal === "SIGTERM" || lines.some((line) => TIMEOUT.test(line))) kinds.push("timeout");
  if (lines.some((line) => ASSERTION.test(line.trim()))) kinds.push("assertion");
  if (kinds.length) return kinds.join(" and ");
  if (!tests.length && diagnostics(lines).length && !lines.some((line) => /^\s*Tests?\b.*\bfailed\b/.test(line))) return "diagnostics";
  return "error";
}

/**
 * A bounded, readable account of one failed verification command.
 * @param {{ stdout?: string, stderr?: string, code?: number | null, signal?: string | null, timedOut?: boolean }} result
 */
export function summarizeVerificationFailure(result: VerificationFailureResult): string {
  const lines = outputLines(result);
  const tests = failingTests(lines);
  const kind = failureKind(result, lines, tests);
  const sections = [`Failure: ${kind}${result.signal ? ` (signal ${result.signal})` : ""}`];
  if (tests.length) {
    sections.push([`Failing tests (${tests.length}):`, ...tests.slice(0, MAX_TESTS).map((test) => `  ${clip(test)}`),
      ...(tests.length > MAX_TESTS ? [`  … ${tests.length - MAX_TESTS} more`] : [])].join("\n"));
  }
  const error = kind === "diagnostics" ? [] : firstError(lines);
  if (error.length) sections.push(["First error:", ...error.map((line) => `  ${clip(line)}`)].join("\n"));
  else {
    const found = diagnostics(lines);
    if (found.length) sections.push(["First diagnostics:", ...found.map((line) => `  ${clip(line)}`)].join("\n"));
  }
  if (lines.length) sections.push([`Output tail (last ${Math.min(TAIL_LINES, lines.length)} of ${lines.length} lines):`,
    ...lines.slice(-TAIL_LINES).map(clip)].join("\n"));
  const summary = sections.join("\n");
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

/**
 * Redact sensitive values from verification output before persistence.
 * Paths containing the checkout root are replaced with [CHECKOUT].
 */
export function redactVerificationOutput(value: string, checkoutPath?: string): string {
  let redacted = value;
  if (checkoutPath) {
    const escaped = checkoutPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "g"), "[CHECKOUT]");
  }
  redacted = redacted.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
  redacted = redacted.replace(/(authorization\s*:\s*(?:bearer|basic)\s+|\bbearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(/\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIzaSy[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_TOKEN]");
  redacted = redacted.replace(/\b(?:cookie|set-cookie|session(?:id|_id)?|csrf(?:token|_token)?)\s*[:=]\s*[^\s;]+/gi, (match: string) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
  redacted = redacted.replace(/\b([A-Z0-9]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"'&,;]+["']?/gi, "$1=[REDACTED]");
  return redacted;
}

