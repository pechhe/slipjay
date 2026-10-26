import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { redactMigrationOutput } from "../landing/migration-command-evidence.ts";
import type { BoundedProcessRequest } from "../infra/bounded-process.ts";
import type { CommandEvidence, RuntimeIdentity } from "./runner-types.ts";

const secretFlag = /^--?(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|cookie|credential|access[-_]?token)(?:=(.*))?$/i;

/** Configuration identity excludes environment values and input; it is not a reproduction credential. */
export function commandEvidence(request: BoundedProcessRequest, checkout: string, runtime?: RuntimeIdentity): CommandEvidence {
  const names = Object.keys(request.env ?? {}).filter((name) => request.env?.[name] !== undefined).sort();
  if (request.args.length > 256 || names.length > 256 || Buffer.byteLength(names.join("\0")) > 8192
    || Buffer.byteLength(request.executable) + request.args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) > 32_768)
    return { status: "unavailable", reason: "capacity" };
  let redacted = false;
  const redact = (value: string) => {
    const safe = redactMigrationOutput(value, checkout, request.env ?? {});
    if (safe !== value) redacted = true;
    return safe;
  };
  let withhold = false;
  const args = request.args.map((arg) => {
    if (withhold) { withhold = false; redacted = true; return "[REDACTED]"; }
    const flag = arg.match(secretFlag);
    if (flag) {
      if (flag[1] !== undefined) { redacted = true; return arg.slice(0, arg.indexOf("=")) + "=[REDACTED]"; }
      withhold = true;
    }
    return redact(arg);
  });
  const executable = redact(request.executable);
  const local = relative(checkout, request.cwd);
  const cwd = local === ".." || local.startsWith("../") || isAbsolute(local) ? null : local || ".";
  const selected = runtime ? { ...runtime, path: redact(runtime.path) } : undefined;
  const configuration = { executable, args, cwd, environmentNames: names, ...(selected ? { runtime: selected } : {}),
    timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes,
    maxOutputBytesPerStream: request.maxOutputBytesPerStream ?? null, maxStoredOutputBytes: request.maxStoredOutputBytes ?? null };
  return { status: "recorded", executable, args, cwd, environmentNames: names, redacted, ...(selected ? { runtime: selected } : {}),
    configurationSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex") };
}
