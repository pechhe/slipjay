import { landThroughRunner, runnerLocation } from "../lib/runner/runner-client.ts";
import { HANDOFF_MAX_BYTES, validSubmissionHandoff } from "../lib/landing/submission-handoff.ts";
import type { SubmissionHandoff } from "../lib/landing/submission-handoff.ts";
import { open } from "node:fs/promises";
import { landingPreview, workspaceContext } from "../lib/slipjay.ts";
import { retiredFieldsWarning } from "../lib/policy/execution-policy.ts";
import { landingTimingLine } from "../lib/landing/landing-timing.ts";
import { repairFailedLanding } from "../lib/landing/repair-workspace.ts";

const LAND_USAGE = "Usage: slipjay land [--direct] [--skip-preflight] [--handoff <json-file> | [--session <build-session-id>] [--ticket <n>]...]";

export async function runPreview(): Promise<void> {
  const preview = await landingPreview();
  console.log(preview.stat || "(no changed files)");
}

export async function runRepair(rest: string[]): Promise<void> {
  const json = rest.includes("--json"), args = rest.filter((arg) => arg !== "--json");
  if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("Usage: slipjay repair <failed-operation> [--json]");
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const setup = await repairFailedLanding(process.cwd(), args[0]!, { location });
  console.log(json ? JSON.stringify(setup) : [`${setup.resumed ? "Resumed" : "Ready"}: repair of ${setup.operationId} in ${setup.workspacePath}`,
    `Brief: ${setup.briefPath}`, "Fix it there, review it, then slipjay land from that workspace."].join("\n"));
}

export async function runLand(rest: string[]): Promise<void> {
  let handoff: SubmissionHandoff | undefined;
  const handoffIndex = rest.indexOf("--handoff");
  const flags = [...rest];
  if (handoffIndex >= 0) {
    const path = flags[handoffIndex + 1];
    if (!path || path.startsWith("--")) throw new Error(LAND_USAGE);
    const file = await open(path, "r");
    try {
      // Read one bounded buffer even if the file grows after stat.
      const bytes = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > HANDOFF_MAX_BYTES) throw new Error("Handoff exceeds 64KiB");
      let value: unknown;
      try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch { throw new Error("Handoff is not valid JSON"); }
      if (!validSubmissionHandoff(value)) throw new Error("Invalid version-1 handoff evidence");
      handoff = value;
    } finally { await file.close(); }
    flags.splice(handoffIndex, 2);
  }
  let session: string | undefined;
  const tickets: number[] = [];
  for (let index = flags.indexOf("--session"); index >= 0; index = flags.indexOf("--session")) {
    const value = flags[index + 1];
    if (!value || value.startsWith("--") || session !== undefined) throw new Error(LAND_USAGE);
    session = value;
    flags.splice(index, 2);
  }
  for (let index = flags.indexOf("--ticket"); index >= 0; index = flags.indexOf("--ticket")) {
    const value = Number(flags[index + 1]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(LAND_USAGE);
    tickets.push(value);
    flags.splice(index, 2);
  }
  if (flags.some((flag) => flag !== "--direct" && flag !== "--skip-preflight")) throw new Error(LAND_USAGE);
  // --direct lands the primary checkout itself, for a session explicitly working Direct.
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const retired = retiredFieldsWarning((await workspaceContext().catch(() => null))?.configuration);
  if (retired) console.error(retired);
  const timing: { startedAt: number; stages: [string, number][] } = { startedAt: Date.now(), stages: [] };
  // The landing may remove this very directory, after which process.cwd() throws.
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error("Stopped following; rerun slipjay land to reattach"));
  process.once("SIGINT", stopFollowing);
  try {
    const runner = await landThroughRunner(process.cwd(), {
      location, handoff, session, tickets, skipPreflight: flags.includes("--skip-preflight"), direct: flags.includes("--direct"), onLine: (line) => console.error(line), signal: following.signal,
      onStage: (stage) => timing.stages.push([stage, Date.now()]),
    });
    // stderr, so stdout stays the JSON result.
    const finished = { ...timing, finishedAt: Date.now() };
    console.error(landingTimingLine(finished));
    console.log(JSON.stringify({ ok: runner.ok, verdict: runner.operation.status, log: runner.logUrl,
      ...(runner.operation.kind === "landing" && runner.operation.outcome ? { outcome: runner.operation.outcome } : {}) }));
    if (!runner.ok) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stopFollowing);
  }
}
