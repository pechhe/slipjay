import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import type { GatePlacement, RemoteAttempt, RemoteVerification } from "../../../src/lib/runner/runner-types.ts";
import { type fixture, until } from "./queue-verifier-fixture.ts";

/**
 * The gate: it holds while `<root>/hold-gates` exists, unless the candidate carries `unheld`; a candidate carrying `mutate` changes a tracked file; one
 * carrying `linger` leaves a detached process in the checkout and records its pid in `<root>/linger.pid`.
 */
export const holdingGate = (root: string) => `const fs=require("node:fs"),path=require("node:path"),at=(name)=>path.join(${JSON.stringify(root)},name);
while (fs.existsSync(at("hold-gates")) && !fs.existsSync("unheld")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
if (fs.existsSync("mutate")) fs.writeFileSync("mutate", "changed by the gate\\n");
if (fs.existsSync("linger")) { const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",cwd:process.cwd()}); child.unref(); fs.writeFileSync(at("linger.pid"), String(child.pid)); }`;

/** A boat verifier whose "VM" runs the gate on this host in the runner checkout, failing to open while `refuse` says so. */
export function fakeBoat(refuse: (input: Parameters<RemoteVerification["open"]>[0]) => Promise<Error | undefined> = async () => undefined) {
  const opened: { screening?: boolean; retrying?: boolean }[] = [];
  let opens = 0;
  /** Each VM's billed seconds so far: every attempt on it bills 60 s. */
  const billed = new Map<string, number>();
  const remote: RemoteVerification = {
    async open(input): Promise<RemoteAttempt> {
      opens++;
      const refusal = await refuse(input);
      if (refusal) throw refusal;
      opened.push({ screening: input.screening, retrying: input.retrying });
      const name = `slipjay-fixture-repo-${input.slot}${input.screening ? "-screen" : ""}`;
      return {
        executor: { host: `boat:${name}`, run: runBoundedProcess },
        machine: { verifier: "boat", id: `bx_${name}`, name, size: "large", image: "bx_image" },
        tree: "t".repeat(40), usage: { seconds: billed.get(name) ?? 0, dollars: 0 },
        finish: async () => {
          billed.set(name, (billed.get(name) ?? 0) + 60);
          return { tree: "t".repeat(40), trackedChanges: 0, usage: { seconds: billed.get(name)!, dollars: 0 } };
        },
        close: async () => {},
      };
    },
  };
  return { remote, opened, opens: () => opens };
}

export type HostPlaceFixture = Awaited<ReturnType<typeof fixture>>;
export const placements = (f: HostPlaceFixture, id?: string): GatePlacement[] => f.log.events(id ? { operationId: id } : {})
  .flatMap(({ event }) => event.type === "remote_verification" && event.phase === "ready" ? [event.placement ?? "boat"] : []);
/** How many gates hold the host place now: a host `ready` with no `finished` after it, per operation. */
export const hostGatesNow = (f: HostPlaceFixture) => {
  const open = new Set<string>();
  for (const { operationId, event } of f.log.events()) {
    if (event.type !== "remote_verification") continue;
    if (event.phase === "ready" && event.placement === "host") open.add(operationId);
    else if (event.machine.verifier === "host") open.delete(operationId);
  }
  return open.size;
};
export const hold = (f: HostPlaceFixture) => writeFile(join(f.root, "hold-gates"), "");
export const release = (f: HostPlaceFixture) => rm(join(f.root, "hold-gates"), { force: true });
export async function terminal(f: HostPlaceFixture, ...ids: string[]) {
  f.queue.wake();
  return Promise.all(ids.map((id) => until(() => f.result(id) || undefined)));
}

/** The failure `boat-verifier.ts` throws for a slot whose disk boat never restored. */
export const SLOT_NOT_READY = "Remote executor unavailable (boat): slipjay-fixture-repo-0-screen not reachable: state idle, disk still restoring after 300s";
