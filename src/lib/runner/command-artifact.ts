import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { redactMigrationOutput } from "../landing/migration-command-evidence.ts";
import { truncateUtf8 } from "../infra/utf8.ts";
import { DIAGNOSTIC_STREAM_BYTES, FAILED_STREAM_BYTES, FAILED_TAIL_BYTES } from "../infra/verification-failure.ts";
import { OUTPUT_OMISSION } from "../infra/bounded-process.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import { COMMAND_ARTIFACT_LIMIT_BYTES, COMMAND_ARTIFACT_PAGE_BYTES } from "./runner-contract.ts";
import type { ArtifactChunk, CommandArtifact } from "./runner-types.ts";
import type { RetainedLog } from "./test-reports.ts";

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const artifactPath = (home: string, operationId: string, runId: string) => join(home, "command-artifacts", digest(operationId), `${digest(runId)}.json`);
const STREAM_BYTES = DIAGNOSTIC_STREAM_BYTES;
/** Each log a failed run keeps (see test-reports.ts): its head and its last FAILED_TAIL_BYTES beyond this. */
const LOG_BYTES = 1024 * 1024;
/** A passing command's serialised artifact. */
export const COMMAND_ARTIFACT_MAX_BYTES = 256 * 1024;
/** A failed command's: two full streams, the selected diagnostics and JSON escaping, which the halving below keeps within it. */
export const FAILED_COMMAND_ARTIFACT_MAX_BYTES = COMMAND_ARTIFACT_LIMIT_BYTES;
const PRIVATE_KEY_BEGIN = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/gi;
const PRIVATE_KEY_END = /-----END [^-\r\n]*PRIVATE KEY-----/gi;

/**
 * The collector's head and tail with every line the cut touched dropped, before redaction: a line split by the cut
 * can hold half of a credential that redaction would no longer recognise, and so can an unterminated private key.
 */
function completeEdges(value: string): string {
  const segments = value.split(OUTPUT_OMISSION);
  // Without the marker the capture was cut at its end (a prefix), so only its last line is suspect.
  const last = segments.length > 1 ? segments.length - 1 : 1;
  return segments.map((segment, index) => {
    let text = segment;
    if (index > 0) {
      text = text.slice(text.indexOf("\n") + 1 || text.length);
      const end = [...text.matchAll(PRIVATE_KEY_END)][0], begin = [...text.matchAll(PRIVATE_KEY_BEGIN)][0];
      if (end && (!begin || end.index < begin.index)) text = text.slice(text.indexOf("\n", end.index) + 1 || text.length);
    }
    if (index < last) {
      text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
      const begin = [...text.matchAll(PRIVATE_KEY_BEGIN)].at(-1), end = [...text.matchAll(PRIVATE_KEY_END)].at(-1);
      if (begin && (!end || begin.index > end.index)) text = text.slice(0, begin.index);
    }
    return text;
  }).join(OUTPUT_OMISSION);
}

/** At most `budget` bytes: the head, the omission marker and the last `tail` bytes, each cut at a line. */
function headAndTail(value: string, budget: number, tail: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= budget) return value;
  const tailBytes = Math.min(tail, budget);
  const end = bytes.subarray(bytes.length - tailBytes).toString("utf8");
  const head = truncateUtf8(value, Math.max(0, budget - tailBytes - Buffer.byteLength(OUTPUT_OMISSION)));
  return `${head.slice(0, Math.max(0, head.lastIndexOf("\n")))}${OUTPUT_OMISSION}${end.slice(end.indexOf("\n") + 1)}`;
}

const failedCommand = (result: BoundedProcessResult) => result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal !== null || Boolean(result.error);

/**
 * A passing command keeps at most 8 KiB of each stream and never a truncated capture. A failed one keeps each stream
 * up to FAILED_STREAM_BYTES, a truncated capture included once its cut lines are dropped; beyond that its head and its
 * last FAILED_TAIL_BYTES, marked `artifact-capacity`, so the command's closing summary always survives. A failed
 * command also keeps the logs it wrote for the runner, each redacted like its streams and bounded the same way.
 */
export async function retainCommandArtifact(input: {
  home: string; operationId: string; runId: string; request: BoundedProcessRequest; result: BoundedProcessResult; privateOutput?: boolean; logs?: RetainedLog[];
}): Promise<CommandArtifact> {
  if (input.privateOutput) return { status: "unavailable", reason: "private-output" };
  const { request, result } = input;
  const sanitize = (value: string) => redactMigrationOutput(request.redactOutput ? request.redactOutput(value) : value, request.cwd, request.env ?? {});
  const failed = failedCommand(result);
  const limit = failed ? FAILED_COMMAND_ARTIFACT_MAX_BYTES : COMMAND_ARTIFACT_MAX_BYTES;
  const passedStream = (value: string, truncated: boolean) => {
    if (truncated) return { text: "", complete: false, reason: "truncated-capture-withheld" };
    const safe = sanitize(value);
    const complete = Buffer.byteLength(safe) <= STREAM_BYTES;
    return { text: truncateUtf8(safe, STREAM_BYTES), complete, ...complete ? {} : { reason: "artifact-capacity" } };
  };
  const failedStream = (value: string, truncated: boolean, budget: number) => {
    const safe = sanitize(truncated ? completeEdges(value) : value);
    const complete = !truncated && Buffer.byteLength(safe) <= budget;
    return { text: headAndTail(safe, budget, FAILED_TAIL_BYTES), complete, ...complete ? {} : { reason: "artifact-capacity" } };
  };
  // A log read from its end starts mid-line: the omission marker leads it, so its cut first line is dropped like a stream's.
  const logs = failed ? (input.logs ?? []).map(({ path, content, truncated }) => {
    const safe = sanitize(truncated ? completeEdges(`${OUTPUT_OMISSION}${content}`) : content);
    const complete = !truncated && Buffer.byteLength(safe) <= LOG_BYTES;
    return { path, text: headAndTail(safe, LOG_BYTES, FAILED_TAIL_BYTES), complete, ...complete ? {} : { reason: "artifact-capacity" } };
  }) : [];
  const serialise = (budget: number) => {
    const stream = (value: string, truncated: boolean) => failed ? failedStream(value, truncated, budget) : passedStream(value, truncated);
    const stdout = stream(result.stdout, result.stdoutTruncated), stderr = stream(result.stderr, result.stderrTruncated);
    const selected = result.diagnosticOutput ? { stdout: passedStream(result.diagnosticOutput.stdout, false), stderr: passedStream(result.diagnosticOutput.stderr, false), incomplete: result.diagnosticOutput.incomplete } : null;
    const complete = stdout.complete && stderr.complete;
    return { complete, bytes: Buffer.from(JSON.stringify({ version: 1, operationId: input.operationId, runId: input.runId, complete, stdout, stderr, selected,
      ...(result.error ? { error: truncateUtf8(sanitize(result.error), 1024) } : {}),
      ...(logs.length ? { logs } : {}),
      diagnosticCapture: !selected ? "unavailable" : selected.incomplete || !selected.stdout.complete || !selected.stderr.complete ? "incomplete" : "selected" })) };
  };
  try {
    // JSON escaping may expand the bounded strings, so the serialised bound is enforced: a failed command's streams
    // halve until they fit, always keeping their tails.
    let budget = FAILED_STREAM_BYTES, serialised = serialise(budget);
    while (failed && serialised.bytes.length > limit && budget > STREAM_BYTES) serialised = serialise(budget = Math.floor(budget / 2));
    const { bytes, complete } = serialised;
    if (bytes.length > limit) return { status: "unavailable", reason: "capture-failed" };
    const path = artifactPath(input.home, input.operationId, input.runId);
    const dir = join(input.home, "command-artifacts", digest(input.operationId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await readFile(path)) !== digest(bytes)) throw error;
      }
      for (const directory of [dir, join(input.home, "command-artifacts"), input.home]) {
        const handle = await open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return { status: "retained", version: 1, sha256: digest(bytes), bytes: bytes.length, complete, retention: "runner-retention-policy",
      ...(logs.length ? { logs: logs.map(({ path }) => path) } : {}) };
  } catch { return { status: "unavailable", reason: "capture-failed" }; }
}

/** Caller resolves the reference from the authorized ledger, never from a client-supplied path. */
export async function readCommandArtifact(home: string, operationId: string, runId: string, reference: Extract<CommandArtifact, { status: "retained" }>, offset: number, limit: number): Promise<ArtifactChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > COMMAND_ARTIFACT_PAGE_BYTES) throw new Error("Invalid artifact range");
  if (reference.bytes > FAILED_COMMAND_ARTIFACT_MAX_BYTES || reference.bytes < 1) throw new Error("Invalid artifact reference");
  const bytes = await readFile(artifactPath(home, operationId, runId));
  if (bytes.length !== reference.bytes || digest(bytes) !== reference.sha256) throw new Error("Retained artifact no longer matches ledger evidence");
  if (offset > bytes.length) throw new Error("Artifact offset is past the end");
  const end = Math.min(bytes.length, offset + limit);
  return { version: 1, operationId, runId, sha256: reference.sha256, bytes: bytes.length, offset,
    nextOffset: end < bytes.length ? end : null, dataBase64: bytes.subarray(offset, end).toString("base64") };
}
