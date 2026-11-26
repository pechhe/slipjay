import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./runner-queue-fixture.ts";
import { REPO } from "./automatic-promotion.ts";
import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import type { LeaseBuildMachine, MachineLease, RemoteVerification } from "../../../src/lib/runner/runner-types.ts";

/** Records each lease, and what the prebuild command was given in a file it writes. */
export function stand() {
  const directory = mkdtempSync(join(tmpdir(), "prebuild-"));
  const marker = join(directory, "prebuilt");
  const prebuild = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, [process.env.SLIPJAY_DEPLOY_ENVIRONMENT, process.env.SLIPJAY_DEPLOY_COMMIT, process.env.SLIPJAY_MACHINE_SSH].join(" ") + "\\n")`;
  const leased = (machine: MachineLease["machine"]): MachineLease => ({
    machine,
    env: { SLIPJAY_MACHINE_SSH: `ssh-${machine.name}`, SLIPJAY_MACHINE_GIT_DIR: `git-${machine.name}` },
    async close() { return null; },
  });
  const leases: string[] = [];
  const state = { reachable: true };
  const machine: LeaseBuildMachine = async ({ commitId }) => {
    if (!state.reachable) throw new Error("peach-box unreachable");
    leases.push(`machine ${commitId}`);
    return leased({ verifier: "machine", id: "peach-box/build", name: "peach-box", size: "machine", image: "fixed SSH machine" });
  };
  const boat: RemoteVerification = {
    async open() {
      return { executor: { host: "boat", run: runBoundedProcess }, machine: { verifier: "boat", id: "vm-1", name: "release-check", size: "fixture", image: "fixture" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() {} };
    },
    async lease({ commitId }) {
      leases.push(`boat ${commitId}`);
      return leased({ verifier: "boat", id: "vm-2", name: "boat-images", size: "fixture", image: "fixture" });
    },
  };
  return { marker, prebuild, leases, machine, boat, state, prebuilt: () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [] };
}

export const started = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.log.events({ operationId: id }).flatMap((row) => row.event.type === "progress" && row.event.line.startsWith("[prebuild]") ? [row.event.line] : []);
export const deployProgress = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.log.deployments(REPO).filter((entry) => entry.environment === "production").flatMap((entry) => f.log.events({ operationId: entry.id }))
    .flatMap((row) => row.event.type === "progress" ? [row.event.line] : []);
