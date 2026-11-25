import { afterEach, expect, test } from "vite-plus/test";
import { setProcessBroker } from "../../src/lib/infra/bounded-process.ts";
import type { BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { ensureDeployCommit, ensureOnIntegrationBranch } from "../../src/lib/release/deploy.ts";

const tip = "a".repeat(40);
const ok = (stdout = "") => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" }) as unknown as BoundedProcessResult;
const bad = (stderr: string) => ({ exitCode: 128, signal: null, timedOut: false, stdout: "", stderr }) as unknown as BoundedProcessResult;
const BOILERPLATE = "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

/** Answers each git subcommand from a queue of results; records every call. */
function fakeGit(script: Record<string, BoundedProcessResult[]>) {
  const calls: { sub: string; env: Record<string, string> }[] = [];
  setProcessBroker(async (request) => {
    const sub = request.args[2] ?? "";
    calls.push({ sub, env: request.env });
    const queue = script[sub] ?? [ok()];
    return (queue.length > 1 ? queue.shift() : queue[0]) as never;
  });
  return calls;
}

afterEach(() => { setProcessBroker(undefined); });

test.each(["kex_exchange_identification: read: Connection reset by peer", BOILERPLATE])("ls-remote retries a transient failure: %s", async (stderr) => {
  const calls = fakeGit({ "ls-remote": [bad(stderr), bad(stderr), ok(`${tip}\trefs/heads/main\n`)], "merge-base": [ok()] });
  await ensureOnIntegrationBranch("/g", "git@github.com:o/r.git", "main", tip, [0, 0]);
  expect(calls.filter((call) => call.sub === "ls-remote")).toHaveLength(3);
});

test("ls-remote gives up after the bounded retries", async () => {
  const calls = fakeGit({ "ls-remote": [bad(BOILERPLATE)] });
  await expect(ensureOnIntegrationBranch("/g", "u", "main", tip, [0, 0])).rejects.toThrow("git ls-remote failed");
  expect(calls).toHaveLength(3);
});

test.each(["git@github.com: Permission denied (publickey).", "ERROR: Repository not found."])("ls-remote does not retry a permanent failure and keeps its reason: %s", async (reason) => {
  const calls = fakeGit({ "ls-remote": [bad(`${reason}\n${BOILERPLATE}`)] });
  const error = await ensureOnIntegrationBranch("/g", "u", "main", tip, [0, 0]).then(() => null, (e: Error) => e);
  expect(calls).toHaveLength(1);
  expect(error?.message).toContain(reason);
});

test("fetch retries a transient failure and succeeds; local cat-file is not retried", async () => {
  const calls = fakeGit({ "cat-file": [bad("missing")], fetch: [bad("ssh: connect to host github.com port 22: Connection timed out"), ok()] });
  await ensureDeployCommit("/g", "u", tip, [0, 0]);
  expect(calls.map((call) => call.sub)).toEqual(["cat-file", "fetch", "fetch"]);
});

test("git forwards GIT_SSH_COMMAND from the process environment", async () => {
  const previous = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = "ssh -i /tmp/key";
  try {
    const calls = fakeGit({ "cat-file": [ok()] });
    await ensureDeployCommit("/g", "u", tip, [0]);
    expect(calls[0]?.env.GIT_SSH_COMMAND).toBe("ssh -i /tmp/key");
  } finally {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = previous;
  }
});
