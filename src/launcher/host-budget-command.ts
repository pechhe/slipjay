import { awaitHostBudget, hostShell, type HostBudgetClass } from "../lib/runner/host-budget.ts";
import { CAPACITY_CLASSES, type CapacityClass, type CapacityRequest } from "../lib/runner/host-capacity.ts";
import { hostCapacityStatus, pollHostCapacity, recoverHostCapacity, runWithHostCapacity } from "../lib/runner/host-capacity-command.ts";
import { readCapacityPolicy } from "../lib/runner/host-capacity-local.ts";

export async function runHostBudget(args: string[]): Promise<number> {
  if (args[0] === "policy" && args.length === 1) {
    const policy = readCapacityPolicy();
    console.log(JSON.stringify(policy ? { configured: true, policy } : { configured: false }));
    return 0;
  }
  if (args[0] === "status" || args[0] === "recover") {
    if (args.length !== 1) throw new Error("usage: slipjay host-budget status|recover");
    console.log(JSON.stringify(args[0] === "status" ? hostCapacityStatus() : recoverHostCapacity()));
    return 0;
  }
  if (args[0] === "poll") {
    if (args.length !== 2) throw new Error("usage: slipjay host-budget poll '<request JSON>'");
    const request = JSON.parse(args[1]!) as Omit<CapacityRequest, "bytes" | "queuedAt" | "admittedAt">;
    if (!request || !/^[a-f0-9]{32}$/.test(request.id) || !CAPACITY_CLASSES.includes(request.lane)
      || typeof request.job !== "string" || request.job.length > 500 || !request.owner || !["holder", "process"].includes(request.owner.kind)
      || !(request.cgroup === null || typeof request.cgroup === "string" && request.cgroup.startsWith("/") && !request.cgroup.includes("\0") && !request.cgroup.split("/").includes(".."))) throw new Error("invalid host capacity request");
    if (request.owner.kind === "holder" && (typeof request.owner.path !== "string" || !request.owner.path.startsWith("/") || request.owner.path.includes("\0")
      || typeof request.owner.identity !== "string" || !request.owner.identity || request.owner.identity.length > 128)) throw new Error("invalid host capacity holder identity");
    if (request.owner.kind === "process" && (!Number.isSafeInteger(request.owner.pid) || request.owner.pid < 1 || !/^\d+$/.test(request.owner.start)
      || typeof request.owner.boot !== "string" || !request.owner.boot)) throw new Error("invalid host capacity process identity");
    console.log(JSON.stringify(pollHostCapacity(request)));
    return 0;
  }
  if (args[0] === "run") {
    let lane: CapacityClass = "agent", name = "Heavy command";
    let index = 1;
    for (; index < args.length && args[index] !== "--"; index += 2) {
      if (args[index] === "--class" && CAPACITY_CLASSES.includes(args[index + 1] as CapacityClass)) lane = args[index + 1] as CapacityClass;
      else if (args[index] === "--job" && args[index + 1]) name = args[index + 1]!;
      else throw new Error("usage: slipjay host-budget run [--class agent|image|landing|release|audit|preview] [--job name] -- command [args]");
    }
    const command = args.slice(index + 1);
    if (args[index] !== "--" || !command.length) throw new Error("host-budget run requires -- followed by a command");
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
    try { return await runWithHostCapacity({ lane, job: name, command, signal: stopping.signal, onWait: (line) => console.error(line) }); }
    catch (error) { if (stopping.signal.aborted) return 130; throw error; }
    finally { for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeListener(signal, stop); }
  }
  const usage = "Usage: slipjay host-budget wait --job <name> [--gate] [--max-wait-seconds <n>]";
  const [action, ...rest] = args;
  let job: string | undefined;
  let jobClass: HostBudgetClass = "background";
  let limitMs: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--job") job = rest[++index];
    else if (rest[index] === "--gate") jobClass = "gate";
    else if (rest[index] === "--max-wait-seconds") {
      limitMs = Number(rest[++index]) * 1000;
      if (!Number.isFinite(limitMs) || limitMs < 0) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  if (action !== "wait" || !job) { console.error(usage); return 2; }
  await awaitHostBudget({ shell: hostShell(), job, host: "this host", jobClass, onWait: (line) => console.error(line), ...limitMs === undefined ? {} : { limitMs } });
  return 0;
}
