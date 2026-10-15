import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { redactMigrationOutput } from "./migration-command-evidence.ts";
import { truncateUtf8 } from "./utf8.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { ArtifactChunk, CommandArtifact } from "./runner-contract.ts";

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const artifactPath = (home: string, operationId: string, runId: string) => join(home, "command-artifacts", digest(operationId), `${digest(runId)}.json`);
const STREAM_BYTES = 8192;
export const COMMAND_ARTIFACT_MAX_BYTES = 256 * 1024;

/** Never persists truncated raw edges: a missing edge can be the other half of a secret. */
export async function retainCommandArtifact(input: {
  home: string; operationId: string; runId: string; request: BoundedProcessRequest; result: BoundedProcessResult; privateOutput?: boolean;
}): Promise<CommandArtifact> {
  if (input.privateOutput) return { status: "unavailable", reason: "private-output" };
  const { request, result } = input;
  const sanitize = (value: string) => redactMigrationOutput(request.redactOutput ? request.redactOutput(value) : value, request.cwd, request.env ?? {});
  const stream = (value: string, truncated: boolean) => {
    if (truncated) return { text: "", complete: false, reason: "truncated-capture-withheld" };
    const safe = sanitize(value);
    const complete = Buffer.byteLength(safe) <= STREAM_BYTES;
    return { text: truncateUtf8(safe, STREAM_BYTES), complete, ...complete ? {} : { reason: "artifact-capacity" } };
  };
  try {
    const stdout = stream(result.stdout, result.stdoutTruncated), stderr = stream(result.stderr, result.stderrTruncated);
    const selected = result.diagnosticOutput ? { stdout: stream(result.diagnosticOutput.stdout, false), stderr: stream(result.diagnosticOutput.stderr, false), incomplete: result.diagnosticOutput.incomplete } : null;
    const complete = stdout.complete && stderr.complete;
    const bytes = Buffer.from(JSON.stringify({ version: 1, operationId: input.operationId, runId: input.runId, complete, stdout, stderr, selected,
      ...(result.error ? { error: truncateUtf8(sanitize(result.error), 1024) } : {}),
      diagnosticCapture: !selected ? "unavailable" : selected.incomplete || !selected.stdout.complete || !selected.stderr.complete ? "incomplete" : "selected" }));
    // JSON escaping may expand the bounded strings. This is an enforced serialized bound.
    if (bytes.length > COMMAND_ARTIFACT_MAX_BYTES) return { status: "unavailable", reason: "capture-failed" };
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
    return { status: "retained", version: 1, sha256: digest(bytes), bytes: bytes.length, complete, retention: "runner-retention-policy" };
  } catch { return { status: "unavailable", reason: "capture-failed" }; }
}

/** Caller resolves the reference from the authorized ledger, never from a client-supplied path. */
export async function readCommandArtifact(home: string, operationId: string, runId: string, reference: Extract<CommandArtifact, { status: "retained" }>, offset: number, limit: number): Promise<ArtifactChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error("Invalid artifact range");
  if (reference.bytes > COMMAND_ARTIFACT_MAX_BYTES || reference.bytes < 1) throw new Error("Invalid artifact reference");
  const bytes = await readFile(artifactPath(home, operationId, runId));
  if (bytes.length !== reference.bytes || digest(bytes) !== reference.sha256) throw new Error("Retained artifact no longer matches ledger evidence");
  if (offset > bytes.length) throw new Error("Artifact offset is past the end");
  const end = Math.min(bytes.length, offset + limit);
  return { version: 1, operationId, runId, sha256: reference.sha256, bytes: bytes.length, offset,
    nextOffset: end < bytes.length ? end : null, dataBase64: bytes.subarray(offset, end).toString("base64") };
}
