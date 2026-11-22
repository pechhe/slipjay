import { awaitHostBudget, hostShell, type HostBudgetClass } from "../lib/runner/host-budget.ts";
import { CAPACITY_CLASSES, CAPACITY_WAIT_DEFAULT_HOURS, formatCapacityWaits, parseCapacityMemoryMax, type CapacityClass, type CapacityRequest } from "../lib/runner/host-capacity.ts";
import { hostCapacityStatus, hostCapacityWaits, pollHostCapacity, recoverHostCapacity, runWithHostCapacity, sampleHostCapacity } from "../lib/runner/host-capacity-command.ts";
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
  if (args[0] === "waits") {
    const usage = "Usage: slipjay host-budget waits [--hours <n>] [--json]";
    let hours: number | undefined;
    let json = false;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === "--json" && !json) json = true;
      else if (args[index] === "--hours" && hours === undefined) {
        hours = Number(args[++index]);
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) { console.error(usage); return 2; }
      } else { console.error(usage); return 2; }
    }
    const waits = hostCapacityWaits(hours ?? CAPACITY_WAIT_DEFAULT_HOURS);
    const text = formatCapacityWaits(waits, hours ?? CAPACITY_WAIT_DEFAULT_HOURS);
    // A Champion metric reads `value` and shows `evidence` as text, so the report itself is the evidence.
    console.log(json ? JSON.stringify({ value: waits.value, evidence: text, lanes: waits.lanes }) : text);
    return 0;
  }
  if (args[0] === "sample") {
    if (args.length !== 2 || !/^[a-f0-9]{32}$/.test(args[1]!)) throw new Error("usage: slipjay host-budget sample <request id>");
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
    try { await sampleHostCapacity(args[1]!, undefined, stopping.signal); }
    catch (error) { if (!stopping.signal.aborted) throw error; }
    finally { for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeListener(signal, stop); }
    return 0;
  }
  if (args[0] === "poll") {
    if (args.length !== 2) throw new Error("usage: slipjay host-budget poll '<request JSON>'");
    const { memoryMaxBytes, ...request } = JSON.parse(args[1]!) as Omit<CapacityRequest, "bytes" | "queuedAt" | "admittedAt"> & { memoryMaxBytes?: unknown };
    if (memoryMaxBytes !== undefined && (typeof memoryMaxBytes !== "number" || !Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes <= 0 || memoryMaxBytes % 4096 !== 0)) throw new Error("invalid host capacity request");
    if (!request || !/^[a-f0-9]{32}$/.test(request.id) || !CAPACITY_CLASSES.includes(request.lane)
      || typeof request.job !== "string" || request.job.length > 500 || !request.owner || !["holder", "process"].includes(request.owner.kind)
      || !(request.cgroup === null || typeof request.cgroup === "string" && request.cgroup.startsWith("/") && !request.cgroup.includes("\0") && !request.cgroup.split("/").includes(".."))) throw new Error("invalid host capacity request");
    if (request.owner.kind === "holder" && (typeof request.owner.path !== "string" || !request.owner.path.startsWith("/") || request.owner.path.includes("\0")
      || typeof request.owner.identity !== "string" || !request.owner.identity || request.owner.identity.length > 128)) throw new Error("invalid host capacity holder identity");
    if (request.owner.kind === "process" && (!Number.isSafeInteger(request.owner.pid) || request.owner.pid < 1 || !/^\d+$/.test(request.owner.start)
      || typeof request.owner.boot !== "string" || !request.owner.boot)) throw new Error("invalid host capacity process identity");
    // A process owner's smaller claim comes only from `run --memory-max`, which caps its own group; through poll only a
    // preview holder may ask, and pollHostCapacity then checks the kernel cap on its exact cgroup.
    if (memoryMaxBytes !== undefined && (request.lane !== "preview" || request.owner.kind !== "holder")) throw new Error("memoryMaxBytes is only for a preview holder");
    console.log(JSON.stringify(pollHostCapacity(request, Date.now(), memoryMaxBytes as number | undefined)));
    return 0;
  }
  if (args[0] === "run") {
    // `run --help` prints this line and every option it accepts: callers probe it for an option before passing it.
    const runUsage = "usage: slipjay host-budget run [--class agent|image|landing|release|audit|preview] [--job name] [--memory-max bytes|size] [--measure-container name]... -- command [args]";
    if (args[1] === "--help") { console.log(runUsage); return 0; }
    let lane: CapacityClass = "agent", name = "Heavy command";
    let memoryMaxBytes: number | undefined;
    const measureContainers: string[] = [];
    let index = 1;
    for (; index < args.length && args[index] !== "--"; index += 2) {
      if (args[index] === "--class" && CAPACITY_CLASSES.includes(args[index + 1] as CapacityClass)) lane = args[index + 1] as CapacityClass;
      else if (args[index] === "--job" && args[index + 1]) name = args[index + 1]!;
      else if (args[index] === "--memory-max" && args[index + 1] && memoryMaxBytes === undefined) memoryMaxBytes = parseCapacityMemoryMax(args[index + 1]!);
      else if (args[index] === "--measure-container" && /^[\w][\w.-]*$/.test(args[index + 1] ?? "")) measureContainers.push(args[index + 1]!);
      else throw new Error(runUsage);
    }
    const command = args.slice(index + 1);
    if (args[index] !== "--" || !command.length) throw new Error("host-budget run requires -- followed by a command");
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
    try { return await runWithHostCapacity({ lane, job: name, command, memoryMaxBytes, measureContainers, signal: stopping.signal, onWait: (line) => console.error(line) }); }
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
