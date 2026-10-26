import { cancelThroughRunner, watchThroughRunner, runnerLocation, recordClientFacts, readMetricsEvents } from "../lib/runner/runner-client.ts";
import { pipelineMetrics, formatPipelineMetrics } from "../lib/runner/pipeline-metrics.ts";
import { workspaceContext } from "../lib/slipjay.ts";

export async function runMetrics(rest: string[]): Promise<void> {
  const usage = "Usage: slipjay metrics [--since <ISO date>] [--repo <owner/name>] [--json]";
  const flags: { since?: string; repo?: string; json?: true } = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--json" && !flags.json) flags.json = true;
    else if ((flag === "--since" || flag === "--repo") && rest[index + 1] !== undefined && flags[flag.slice(2) as "since" | "repo"] === undefined) flags[flag.slice(2) as "since" | "repo"] = rest[++index]!;
    else throw new Error(usage);
  }
  const since = flags.since ?? new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid metrics date");
  const location = runnerLocation();
  if (!location) throw new Error("Metrics requires a runner location");
  const metrics = pipelineMetrics(await readMetricsEvents(location), since, flags.repo ? { repo: flags.repo } : {});
  console.log(flags.json ? JSON.stringify(metrics, null, 2) : formatPipelineMetrics(metrics));
}

export async function runRecordPreview(rest: string[]): Promise<void> {
  const port = Number(rest[0]);
  if (rest.length !== 1 || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Usage: slipjay record-preview <port>");
  const context = await workspaceContext();
  if (!context) throw new Error("Preview record requires a workspace");
  await recordClientFacts(process.cwd(), [{ kind: "preview_start", workspace: context.current.name, port }]);
}

export async function runWatch(rest: string[]): Promise<void> {
  if (rest.length !== 1 || rest[0] !== "--json") throw new Error("Usage: slipjay watch --json");
  const location = runnerLocation();
  if (!location)
    throw new Error("No runner location: set SLIPJAY_RUNNER or runner in ~/.slipjay/config.json");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await watchThroughRunner(
      location,
      (envelope) => console.log(JSON.stringify(envelope)),
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runCancel(rest: string[]): Promise<void> {
  if (rest.length !== 1 || rest[0]!.startsWith("-"))
    throw new Error("Usage: slipjay cancel <id>");
  const location = runnerLocation();
  if (!location)
    throw new Error("No runner location: set SLIPJAY_RUNNER or runner in ~/.slipjay/config.json");
  const outcome = await cancelThroughRunner(location, rest[0]!);
  console.log(JSON.stringify(outcome.result));
  if (!outcome.ok) process.exitCode = 1;
}
