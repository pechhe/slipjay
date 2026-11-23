import { releaseHeldIntegration, controlRunner, prioritizeOperation, resendReceipts, readRunLog, readRunArtifact, readLandingOutcome, readLandingHandoff, downloadSubmissionSource, manageRepairClaim, runnerLocation, operationRunnerLocation } from "../lib/runner/runner-client.ts";
import { startRunner } from "../lib/runner/runner-service.ts";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const PRIORITIZE_USAGE = "slipjay runner prioritize <operationId> [--while-paused] [--reason <text>] [--json]";

export async function runRunner(rest: string[]): Promise<void> {
  if (rest[0] === "release" && rest.length === 2 && /^[\w.-]+\/[\w.-]+$/.test(rest[1]!)) {
    const location = runnerLocation();
    if (!location) throw new Error("No runner location configured");
    const outcome = await releaseHeldIntegration(location, rest[1]!);
    console.log(outcome.line);
    if (!outcome.ok) process.exitCode = 1;
  } else if (rest[0] === "artifact" && rest.length === 3) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    console.log(JSON.stringify(await readRunArtifact(location, rest[1]!, rest[2]!), null, 2));
  } else if (["repair-claim", "repair-release", "repair-revoke"].includes(rest[0] ?? "") && rest.length === 2) {
    const location = runnerLocation();
    if (!location) throw new Error("No runner location configured");
    console.log(JSON.stringify(await manageRepairClaim(process.cwd(), location, rest[1]!, rest[0]!.slice(7) as "claim" | "release" | "revoke"), null, 2));
  } else if (rest[0] === "source" && rest.length === 3) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location configured");
    console.log(JSON.stringify(await downloadSubmissionSource(location, rest[1]!, resolve(rest[2]!)), null, 2));
  } else if (rest[0] === "handoff" && rest.length === 2) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location configured");
    console.log(JSON.stringify(await readLandingHandoff(location, rest[1]!), null, 2));
  } else if (rest[0] === "outcome" && rest.length === 2) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    console.log(JSON.stringify(await readLandingOutcome(location, rest[1]!), null, 2));
  } else if (rest[0] === "log" && rest.length === 2) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    process.stdout.write(await readRunLog(location, rest[1]!));
  } else if ((rest.length === 1 && (rest[0] === "kill" || rest[0] === "pause" || rest[0] === "resume")) || (rest.length === 2 && rest[0] === "kill" && !rest[1]!.startsWith("-"))) {
    const location = runnerLocation();
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    const outcome = await controlRunner(location, rest[0] as "kill" | "pause" | "resume", process.env, rest[1]);
    console.log(outcome.line);
    if (!outcome.ok) process.exitCode = 1;
  } else if (rest[0] === "prioritize") {
    const [, operationId, ...args] = rest;
    if (!operationId || operationId.startsWith("-")) throw new Error(`Usage: ${PRIORITIZE_USAGE}`);
    const { values } = parseArgs({ args, options: {
      "while-paused": { type: "boolean" },
      reason: { type: "string" },
      json: { type: "boolean" },
    } });
    const location = await operationRunnerLocation(operationId);
    if (!location) throw new Error("No runner location configured");
    const { ok, result } = await prioritizeOperation(location, operationId, { whilePaused: values["while-paused"], reason: values.reason });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else if (ok) console.log(`Prioritized landing ${operationId}${result.operation?.kind === "landing" && result.operation.prioritized?.whilePaused ? " (may run while paused)" : ""}`);
    else console.error(result.error ?? `Could not prioritize landing ${operationId}`);
    if (!ok) process.exitCode = 1;
  } else if (rest[0] === "resend" && rest.length === 2) {
    const location = await operationRunnerLocation(rest[1]!);
    if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
    const outcome = await resendReceipts(location, rest[1]!);
    console.log(outcome.line);
    if (!outcome.ok) process.exitCode = 1;
  } else if (rest.join(" ") === "serve") {
    const runner = await startRunner();
    console.error(`SlipJay runner listening on ${runner.url}`);
    // systemd stops the unit with SIGTERM. A restart, such as an upgrade's, waits for an operation that is integrating,
    // finalizing, publishing or recovering a held integration, and for a running deploy (the unit's TimeoutStopSec bounds it);
    // a gate still running is left to restart recovery.
    await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
    console.error("SlipJay runner stopping once no integration is being finished and no deploy is running");
    await runner.drain();
    process.exit(0);
  } else throw new Error("Usage: slipjay runner <serve|log <operation>|outcome <operation>|handoff <operation>|source <operation> <bundle-file>|repair-claim <operation>|repair-release <operation>|repair-revoke <operation>|artifact <operation> <run>|resend <operation>|kill [<operation>]|pause|resume|release <owner/repo>>" + `\n       ${PRIORITIZE_USAGE}`);
}
