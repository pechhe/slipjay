import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationLog } from "../../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../../src/lib/runner/runner-log.ts";
import { fixture, until } from "./runner-queue-fixture.ts";

/** What the short-landing queue tests share: ledger samples that make a repository short or long, and a queue whose gates hold on demand. */

export const SHORT_MS = 180_000;

/**
 * Record `count` closed landings of `repo` whose checks verified for `verifyMs` each. Beside a queue they end failed,
 * so no repository gains a landed commit it never published.
 */
export function verified(log: OperationLog, repo: string, count: number, verifyMs: number, end: "landed" | "failed" = "landed"): void {
  for (let index = 0; index < count; index++) {
    const id = newOperationId();
    log.append(id, { type: "submitted", repo, changeId: `${repo}-${index}`, commitId: `${index}`.padStart(40, "0"), bookmark: `b-${index}`, submittedBy: "test" });
    log.append(id, { type: "verification_base", base: "main", candidate: "c" });
    log.append(id, { type: "stage_detail", stage: "verifying", durationMs: verifyMs });
    log.append(id, end === "landed" ? { type: "landed", base: "main", commitId: `${index}`.padStart(40, "1"), branch: "main", remote: "origin" }
      : { type: "failed", stage: "verifying", reason: "earlier sample" });
  }
}

/** Submit a landing of `repo`, optionally started (as the queue records it, short or long). */
export function landing(log: OperationLog, repo: string, started?: "short" | "long"): string {
  const id = newOperationId();
  log.append(id, { type: "submitted", repo, changeId: id, commitId: "f".repeat(40), bookmark: id, submittedBy: "test" });
  if (started) log.append(id, { type: "stage", stage: "fetching", ...started === "short" ? { shortLanding: true as const } : {} });
  return id;
}

export const waiting = (log: OperationLog, id: string) => log.openOperations().find((operation) => operation.id === id)?.waitingFor;

// Every repository's gate holds while a marker named by one of the candidate's `hold-<name>` files exists under the root.
export const holdGate = (root: string) => `const fs=require("node:fs"),path=require("node:path");
for (const file of fs.readdirSync(".").filter((name) => name.startsWith("hold-"))) {
  while (fs.existsSync(path.join(${JSON.stringify(root)}, file.slice(5)))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}`;

export async function queueFixture(options: Parameters<typeof fixture>[4] = {}, releases = false, reset = false) {
  const f = await fixture(false, releases, undefined, reset, { other: true, extra: ["Fixture/C", "Fixture/D", "Fixture/E"], prefixGate: holdGate, ...options });
  const authorOf = (repo: string) => repo === "fixture/repo" ? f.author : repo === "fixture/other" ? f.otherAuthor : f.authors[`Fixture/${repo.slice(8).toUpperCase()}`]!;
  /** Submit a landing of `repo` whose gate holds until `release(name)`. */
  async function held(repo: string, name: string): Promise<string> {
    await writeFile(join(f.root, name), "");
    return f.submit(await f.candidate(`hold-${name}`, authorOf(repo), repo));
  }
  const release = (name: string) => rm(join(f.root, name), { force: true });
  const status = (id: string) => f.log.operation(id)!.status;
  const running = (id: string) => until(() => status(id) === "running" || undefined);
  /** Wake the queue and let anything it admitted record its first stage. */
  const settle = async () => { f.queue.wake(); await new Promise((resolve) => setImmediate(resolve)); };
  return { f, held, release, status, running, settle };
}
