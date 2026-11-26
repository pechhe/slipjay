import { readdir } from "node:fs/promises";
import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import type { RemoteVerification } from "../../../src/lib/runner/runner-types.ts";
import { fixture } from "./runner-queue-fixture.ts";

export function controlledRemote() {
  const opened: { slot: number; screening?: boolean; base: string; candidate: string; files: string[]; release(): void }[] = [];
  const closed: string[] = [];
  let hold = true;
  const remote: RemoteVerification = {
    async open(input) {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const entry = { ...input, files: await readdir(input.checkout), release };
      opened.push(entry);
      const name = `fake-${input.screening ? "screen" : "authoritative"}-${input.slot}`;
      return {
        machine: { verifier: "boat", id: name, name, size: "large", image: "image" }, tree: "tree", usage: null,
        executor: { host: name, async run(request) {
          if (hold) await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("cancelled"));
            request.abortSignal?.addEventListener("abort", abort, { once: true });
            if (request.abortSignal?.aborted) abort();
            void ready.then(() => { request.abortSignal?.removeEventListener("abort", abort); resolve(); });
          });
          return runBoundedProcess(request);
        } },
        finish: async () => ({ tree: "tree", trackedChanges: 0, usage: null }),
        close: async () => { closed.push(name); },
      };
    },
  };
  return { remote, opened, closed, releaseAll() { hold = false; for (const entry of opened) entry.release(); } };
}

export const events = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.log.events({ operationId: id }).map(({ event }) => event);
