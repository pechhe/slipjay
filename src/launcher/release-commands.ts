import { readAudits, recordAuditCause, deployThroughRunner, readDeploys, readPromotionState, requestVerificationThroughRunner, releaseThroughRunner, resetThroughRunner, runLogCommand, runnerLocation } from "../lib/runner/runner-client.ts";
import type { AutomaticPromotion, Operation } from "../lib/runner/runner-types.ts";
import { open } from "node:fs/promises";
import { confirmableCandidate } from "../lib/release/release.ts";
import { releaseIntegration } from "../lib/slipjay.ts";

/**
 * `promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]`: plan a release
 * here (of the newest staging-green commit, or of the older one `--candidate` names), or send
 * the candidate a human approved to the runner, which verifies and publishes it.
 * Progress goes to stderr; stdout is one JSON result.
 */
export async function runPromote(args: string[]): Promise<number> {
  const options: { migrationsReady: boolean; confirm?: string; candidate?: string } = { migrationsReady: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--migrations-ready") options.migrationsReady = true;
    else if (args[index] === "--confirm" && args[index + 1] && !args[index + 1]!.startsWith("-")) options.confirm = args[++index];
    else if (args[index] === "--candidate" && args[index + 1] && !args[index + 1]!.startsWith("-")) options.candidate = args[++index];
    else throw new Error("Usage: slipjay promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]");
  }
  if (options.candidate !== undefined && options.confirm !== undefined) throw new Error("slipjay promote takes --candidate to plan or --confirm to release, not both: confirm names the commit itself");
  const location = runnerLocation();
  if (options.confirm === undefined) {
    const plan = await releaseIntegration(process.cwd(), {
      ...options.candidate !== undefined ? { candidate: options.candidate } : {},
      ...location ? { readPromotion: () => readPromotionState(process.cwd(), { location }),
        requestVerification: (commit: string) => requestVerificationThroughRunner(process.cwd(), { commit, location }) } : {} });
    console.log(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }
  if (!location) throw new Error("slipjay promote --confirm runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const confirmable = await confirmableCandidate(process.cwd(), options.confirm, options.migrationsReady, () => readPromotionState(process.cwd(), { location }));
  if (confirmable.status !== "confirmable") {
    console.log(JSON.stringify(confirmable, null, 2));
    return 1;
  }
  const following = new AbortController();
  const stopFollowing = () => following.abort(new Error(`Stopped following; rerun slipjay promote --confirm ${options.confirm} to reattach`));
  process.once("SIGINT", stopFollowing);
  let followed: Awaited<ReturnType<typeof releaseThroughRunner>>;
  try {
    followed = await releaseThroughRunner(process.cwd(), { candidate: confirmable.candidate, remote: confirmable.remote,
      migrationsReady: options.migrationsReady, location, onLine: (line) => console.error(line), signal: following.signal });
  } finally {
    process.removeListener("SIGINT", stopFollowing);
  }
  const { operation, deploy, logUrl } = followed;
  const outcome = operation.result;
  const deployed = deploy?.result?.type === "deployed" ? deploy.result.record : deploy?.result?.type === "failed" ? deploy.result.deployment : undefined;
  let printed: Record<string, unknown>;
  if (outcome?.type === "released") {
    printed = { ...outcome.result, ...automaticOf(operation) ? { automatic: automaticOf(operation) } : {}, log: logUrl };
    if (deploy) {
      // The promotion's verdict is its production deploy's: `deployed`, or `deploy failed: <project> (<reason>)`, with any rollback.
      if (deploy.result?.type === "failed") console.error(`[runner] production ${deploy.result.reason}`);
      printed.production = { status: deploy.status, ...automaticOf(operation) ? { automatic: automaticOf(operation) } : {}, ...deploy.result?.type === "failed" ? { reason: deploy.result.reason } : {},
        ...deployed ? { record: deployed } : {}, log: runLogCommand(deploy.id) };
    }
  }
  else if (outcome?.type === "failed") {
    console.error(`[runner] release failed at ${outcome.stage}: ${outcome.reason}`);
    if (outcome.command) console.error(outcome.command);
    if (outcome.output !== undefined) console.error(outcome.output);
    printed = { ok: false, status: "failed", stage: outcome.stage, reason: outcome.reason, log: logUrl };
  } else printed = { ok: false, status: operation.status, ...outcome?.type === "cancelled" ? { reason: outcome.reason } : {}, log: logUrl };
  console.log(JSON.stringify(printed, null, 2));
  return outcome?.type !== "released" || (deploy && deploy.status !== "deployed") ? 1 : 0;
}

/** How a deploy line says the runner promoted it by itself, and why. */
const automaticOf = (operation: Operation): AutomaticPromotion | undefined => operation.kind === "release" ? operation.automatic : undefined;
const automaticNote = (automatic: AutomaticPromotion | undefined): string => automatic ? `  (automatic: ${automatic.setting} "${automatic.value}")` : "";

/** `deploy <environment>`: deploy the integration branch's latest commit now, through the runner, and follow it. */
export async function runDeploy(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("-")) throw new Error("Usage: slipjay deploy <environment>");
  const location = runnerLocation();
  if (!location) throw new Error("slipjay deploy runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const { operation, logUrl } = await deployThroughRunner(process.cwd(), { environment: args[0]!, location, onLine: (line) => console.error(line) });
  const outcome = operation.result;
  if (outcome?.type === "failed") console.error(`[runner] deploy failed: ${outcome.reason}`);
  const record = outcome?.type === "deployed" ? outcome.record : outcome?.type === "failed" ? outcome.deployment : undefined;
  console.log(JSON.stringify({ ok: outcome?.type === "deployed", status: operation.status,
    ...outcome?.type === "failed" ? { reason: outcome.reason } : {}, ...record ? { record } : {}, log: logUrl }, null, 2));
  return outcome?.type === "deployed" ? 0 : 1;
}

/** `reset`: reset the repository's declared target now, through the runner (or follow the open reset), to its verdict. */
export async function runReset(args: string[]): Promise<number> {
  if (args.length) throw new Error("Usage: slipjay reset");
  const location = runnerLocation();
  if (!location) throw new Error("slipjay reset runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const { operation, logUrl } = await resetThroughRunner(process.cwd(), { location, onLine: (line) => console.error(line) });
  const outcome = operation.result;
  if (outcome?.type === "failed") console.error(`[runner] reset failed: ${outcome.reason}`);
  console.log(JSON.stringify({ ok: outcome?.type === "reset", status: operation.status,
    ...outcome?.type === "reset" ? { target: outcome.target, source: outcome.source } : {},
    ...outcome?.type === "failed" || outcome?.type === "cancelled" ? { reason: outcome.reason } : {}, log: logUrl }, null, 2));
  return outcome?.type === "reset" ? 0 : 1;
}

/**
 * `audit [status]` shows the repository's nightly audits and what they say; `audit cause` records why its failing
 * audit failed, which lifts the promotion refusal: culprit landings (operation ids or published commits), or exactly
 * one of `--flake`, `--infrastructure`, `--unresolved`.
 */
export async function runAudit(args: string[]): Promise<number> {
  const usage = "Usage: slipjay audit [status] | slipjay audit cause <landing...|--flake|--infrastructure|--unresolved> [--audit <id>] [--note <text>]";
  const location = runnerLocation();
  if (!location) throw new Error("slipjay audit runs on the runner: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  if (!args.length || (args.length === 1 && args[0] === "status")) {
    const { operations, summary } = await readAudits(process.cwd(), { location });
    console.log(JSON.stringify({ summary, audits: operations.slice(0, 10).map((operation) => ({ id: operation.id, status: operation.status, slot: operation.slot,
      ...operation.head ? { head: operation.head } : {}, ...operation.finishedAt ? { finishedAt: operation.finishedAt } : {},
      ...operation.result?.type === "failed" ? { reason: operation.result.reason } : {}, ...operation.cause ? { cause: operation.cause.cause } : {} })) }, null, 2));
    return 0;
  }
  if (args[0] !== "cause") throw new Error(usage);
  const landings: string[] = [], kinds: ("flake" | "infrastructure" | "unresolved")[] = [];
  let audit: string | undefined, note: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--flake" || arg === "--infrastructure" || arg === "--unresolved") kinds.push(arg.slice(2) as "flake" | "infrastructure" | "unresolved");
    else if (arg === "--audit" && args[index + 1]) audit = args[++index];
    else if (arg === "--note" && args[index + 1]) note = args[++index];
    else if (!arg.startsWith("-")) landings.push(arg);
    else throw new Error(usage);
  }
  if (kinds.length + (landings.length ? 1 : 0) !== 1) throw new Error(`Name the cause exactly once: culprit landings, or one of --flake, --infrastructure, --unresolved\n${usage}`);
  const { operation, summary } = await recordAuditCause(process.cwd(), { location, ...audit ? { audit } : {}, ...note ? { note } : {},
    ...landings.length ? { landings } : { kind: kinds[0]! } });
  console.log(JSON.stringify({ ok: true, audit: operation.id, cause: operation.cause?.cause, openFailure: summary.openFailure, escapes: summary.escapes }, null, 2));
  return 0;
}

/** `deploys [--environment <name>] [--json]`: what each deploy put where, newest first. */
export async function runDeploys(args: string[]): Promise<number> {
  let environment: string | undefined;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") asJson = true;
    else if (args[index] === "--environment" && args[index + 1] && !args[index + 1]!.startsWith("-")) environment = args[++index];
    else throw new Error("Usage: slipjay deploys [--environment <name>] [--json]");
  }
  const location = runnerLocation();
  if (!location) throw new Error("No runner location: set SLIPJAY_RUNNER or \"runner\" in ~/.slipjay/config.json");
  const deploys = await readDeploys(process.cwd(), { location, ...environment ? { environment } : {} });
  if (asJson) {
    console.log(JSON.stringify(deploys.map((operation) => ({ id: operation.id, environment: operation.environment, commitId: operation.commitId,
      status: operation.status, submittedBy: operation.submittedBy, submittedAt: operation.submittedAt, finishedAt: operation.finishedAt,
      ...operation.promotion?.automatic ? { automatic: operation.promotion.automatic } : {},
      ...operation.result?.type === "deployed" ? { record: operation.result.record } : {},
      ...operation.result?.type === "failed" ? { reason: operation.result.reason, ...operation.result.deployment ? { record: operation.result.deployment } : {} } : {},
    })), null, 2));
    return 0;
  }
  for (const operation of deploys) {
    const record = operation.result?.type === "deployed" ? operation.result.record : operation.result?.type === "failed" ? operation.result.deployment : undefined;
    console.log(`${operation.submittedAt}  ${operation.environment}  ${operation.commitId.slice(0, 12)}  ${operation.status}${operation.result?.type === "failed" ? `: ${operation.result.reason}` : ""}${automaticNote(operation.promotion?.automatic)}`);
    for (const project of record?.projects ?? []) console.log(`  ${project.name}: ${project.ok ? project.url ?? "deployed" : `failed: ${project.reason}`}`);
    if (record) {
      console.log(`  ${record.changes.length} change${record.changes.length === 1 ? "" : "s"} since ${record.previous?.slice(0, 12) ?? "the first deploy"}`);
      for (const change of record.changes) console.log(`    ${change.commitId.slice(0, 12)} ${change.subject}`);
    }
  }
  if (!deploys.length) console.log("No deploys yet.");
  return 0;
}

export async function runRelease(): Promise<void> {
  console.error("slipjay release is retired; use slipjay promote [--confirm <commit>] [--migrations-ready]");
  process.exitCode = 2;
}
