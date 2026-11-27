import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import type { GatePlacement, MachineVerification, RemoteAttempt, RemoteVerification } from "../../../src/lib/runner/runner-types.ts";
import type { fixture } from "./queue-verifier-fixture.ts";

export function places() {
  let occupied = false;
  let quarantined = false;
  let max = 0;
  let opens = 0;
  let setupFailure = "";
  let boatFailure = false;
  let closeFailure = false;
  // Like a real place, a remote attempt works in its own copy of exactly the candidate, never in the runner's checkout
  // (which is narrowed for a machine-place repository, SJ-200).
  const attempt = async (machine: boolean, input: Parameters<RemoteVerification["open"]>[0]): Promise<RemoteAttempt> => {
    const copy = await mkdtemp(join(tmpdir(), "remote-place-"));
    const gitDirectory = execFileSync("jj", ["--ignore-working-copy", "git", "root"], { cwd: input.checkout, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git --git-dir "$1" archive "$2" | tar -x -C "$3"`, "sh", gitDirectory, input.candidate, copy]);
    const inCopy = (cwd: string) => cwd.startsWith(input.checkout) ? copy + cwd.slice(input.checkout.length) : cwd;
    return {
      machine: machine ? { verifier: "machine", name: "peach-box", id: "peach-box", size: "machine", image: "fixed SSH machine" }
        : { verifier: "boat", name: "slot", id: "boat", size: "large", image: "image" },
      executor: { host: machine ? "machine:peach-box" : "boat:slot", run: (request) => runBoundedProcess({ ...request, cwd: inCopy(request.cwd) }) },
      tree: "tree", usage: null,
      async finish() { const mutated = await readFile(join(copy, "mutate"), "utf8").then((value) => value === "changed by machine gate", () => false); return { tree: mutated ? null : "tree", trackedChanges: mutated ? 1 : 0, usage: null }; },
      async close() { await rm(copy, { recursive: true, force: true }); if (machine) { occupied = false; if (closeFailure) throw new Error("Remote executor unavailable (machine peach-box): cleanup unconfirmed"); } },
    };
  };
  const machine: MachineVerification = {
    available: () => !occupied && !quarantined,
    reason: () => quarantined ? "quarantined: earlier work alive" : "machine place busy",
    async recover() {},
    async open(input) {
      opens++;
      if (setupFailure) throw Object.assign(new Error(setupFailure), { remote: { machine: { verifier: "machine", name: "peach-box", id: "peach-box", size: "machine", image: "fixed SSH machine" }, usageBefore: null, usage: null } });
      assert.equal(occupied, false, "never share a machine, screening included"); occupied = true; max = Math.max(max, Number(occupied));
      return attempt(true, input);
    },
  };
  const boat: RemoteVerification = { async probe() { if (boatFailure) throw new Error("boat unavailable"); }, async open(input) {
    if (boatFailure) throw Object.assign(new Error("Remote executor unavailable (boat): API unreachable"), { boatUnavailable: true });
    return attempt(false, input);
  } };
  return { machine, boat, max: () => max, opens: () => opens, quarantine: (value: boolean) => { quarantined = value; }, fail: (reason: string) => { setupFailure = reason; }, holdBoat: () => { boatFailure = true; }, failClose: (value: boolean) => { closeFailure = value; } };
}

export const gate = (root: string) => `const fs=require('node:fs');while(fs.existsSync(${JSON.stringify(join(root, "hold"))}) && !fs.existsSync("unheld")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);if(fs.existsSync("mutate"))fs.writeFileSync("mutate","changed by machine gate");`;
export const placements = (f: Awaited<ReturnType<typeof fixture>>, id?: string): GatePlacement[] => f.log.events(id ? { operationId: id } : {}).flatMap(({ event }) => event.type === "remote_verification" && event.phase === "ready" ? [event.placement!] : []);
export const options = (p: ReturnType<typeof places>) => ({ screeningLanes: 3, workers: 2, gateMachine: "peach-box", machineVerifications: { "peach-box": p.machine }, remoteVerification: p.boat });
