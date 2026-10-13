import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../src/lib/workspace-create.ts";
import { controlRunner, landThroughRunner, releaseThroughRunner } from "../src/lib/runner-client.ts";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import type { Operation, OperationEvent, StoredEvent } from "../src/lib/runner-contract.ts";
import { serveRunner } from "../src/lib/runner-http.ts";
import { readLandingState } from "../src/lib/workspace-state.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { jj, project } from "./support/workspace-project.ts";

async function fixture(dropStream = false) {
  const f = await project();
  // A GitHub-shaped local path exercises repository identification without network access.
  const remote = join(f.root, "github.com/fixture/project.git");
  await mkdir(join(f.root, "github.com/fixture"), { recursive: true });
  await rename(f.remote, remote);
  jj(f.repo, ["git", "remote", "set-url", "origin", remote]);
  const workspace = await createWorkspace("runner client fixture", f.repo);
  const cwd = workspace.workspacePath;
  await writeFile(join(cwd, "change.txt"), "candidate\n");
  jj(cwd, ["describe", "-m", "Implement candidate"]);
  const commit = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const change = jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
  const log = openOperationLog(":memory:");
  const listeners = new Set<(event: StoredEvent) => void>();
  const append = (id: string, event: OperationEvent) => {
    const stored = log.append(id, event);
    for (const listener of listeners) listener(stored);
  };
  let killed: { operation: Operation; killed: boolean } | null = null;
  const handler = createRunnerHandler({ log, token: "test-token", runnerName: "test-runner",
    readLog: async () => "test log", onSubmitted: () => {}, kill: () => killed,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const streamRequests: number[] = [];
  let droppedSeq = 0;
  const route = async (request: Request) => {
    if (new URL(request.url).pathname.endsWith("/events")) {
      streamRequests.push(Number(new URL(request.url).searchParams.get("after")));
      if (dropStream && streamRequests.length === 1) {
        const operation = log.openOperations()[0]!;
        const stored = log.append(operation.id, { type: "progress", line: "before reconnect" });
        droppedSeq = stored.seq;
        return new Response(`data: ${JSON.stringify(stored)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
    }
    return handler(request);
  };
  let server = await serveRunner(route, { host: "127.0.0.1", port: 0 });
  // The runner is unreachable until `back()`, as during a service restart.
  const goDown = async () => {
    const { port } = server;
    await server.close();
    return async () => { server = await serveRunner(route, { host: "127.0.0.1", port }); };
  };
  const lines: string[] = [];
  const options = { location: server.url, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "test-token" },
    onLine: (line: string) => { lines.push(line); } };
  return { ...f, remote, cwd, commit, change, log, append, server, lines, options, streamRequests, droppedSeq: () => droppedSeq, goDown,
    setKill: (outcome: { operation: Operation; killed: boolean } | null) => { killed = outcome; },
    dispose: async () => { await server.close(); log.close(); await f.dispose(); } };
}

const waitFor = (condition: () => unknown) => vi.waitFor(() => assert.ok(condition()), { timeout: 10_000, interval: 20 });

test("owner controls say what they did", async () => {
  const f = await fixture();
  try {
    const control = (action: "kill" | "pause" | "resume") => controlRunner(f.server.url, action, f.options.env);
    assert.deepEqual(await control("kill"), { ok: true, line: "[runner test-runner] nothing running" });
    assert.deepEqual(await control("pause"), { ok: true, line: "[runner test-runner] paused: queued changes wait until resumed" });
    assert.deepEqual(await control("resume"), { ok: true, line: "[runner test-runner] resumed" });
    const operation: Operation = { kind: "landing", id: "op", repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change),
      submittedBy: "test", status: "running", stage: "verifying", submittedAt: "", runs: [], lastSeq: 1 };
    const subject = `landing ${f.change.slice(0, 12)}`;
    f.setKill({ operation, killed: true });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killed ${subject}` });
    f.setKill({ operation: { ...operation, stage: "installing" as const }, killed: true });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killing ${subject}: it stops when installing finishes, before verification` });
    f.setKill({ operation: { ...operation, stage: "publishing" as const }, killed: false });
    assert.deepEqual(await control("kill"), { ok: false, line: `[runner test-runner] not killed: ${subject} publishing is past verification and cannot be killed; it finishes on its own` });
  } finally { await f.dispose(); }
}, 60_000);

test("interrupting and reattaching submits once and publishes the exact candidate bookmark", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = landThroughRunner(f.cwd, { ...f.options, signal: abort.signal });
    const stopped = assert.rejects(first);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const operation = f.log.openOperations()[0]!;
    abort.abort();
    await stopped;
    assert.equal(execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { encoding: "utf8" }).trim(), f.commit);
    assert.equal(jj(f.cwd, ["bookmark", "list", candidateBookmark(f.change)]), "");
    f.lines.length = 0;
    const second = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    const result = await second;
    assert.equal(result.operation.id, operation.id);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(result.ok, false);
  } finally { await f.dispose(); }
});

test("failed gates print the command, output verbatim and run log URL", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const output = "  gate failed\nsecond line\n";
    f.append(op.id, { type: "failed", stage: "verifying", reason: "gate failed", command: "bun run check", output });
    const result = await running;
    assert.equal(result.ok, false);
    assert.ok(f.lines.includes(output));
    assert.ok(f.lines.includes("bun run check"));
    assert.ok(f.lines.includes(result.logUrl));
    assert.ok(f.lines.some((line) => line.includes("failed at verifying")));
    // The candidate stays the editable working copy, so a fix amends it rather than stacking on it.
    assert.equal(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), f.commit);
  } finally { await f.dispose(); }
});

test("queued positions and stage changes name the runner", async () => {
  const f = await fixture();
  try {
    f.append("ahead", { type: "submitted", repo: "fixture/project", changeId: "kkkkkkkkkkkk", commitId: "older", bookmark: candidateBookmark("kkkkkkkkkkkk"), submittedBy: "fixture" });
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 2)"));
    const operation = f.log.operationsForChange("fixture/project", f.change)[0]!;
    f.append("ahead", { type: "cancelled", reason: "fixture" });
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 1)"));
    f.append(operation.id, { type: "stage", stage: "verifying" });
    await waitFor(() => f.lines.includes("[runner test-runner] verifying"));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    await running;
  } finally { await f.dispose(); }
});

test("a release confirm waits behind running work, follows its release to the verdict and reattaches on a rerun", async () => {
  const f = await fixture();
  try {
    f.append("ahead", { type: "submitted", repo: "fixture/project", changeId: "kkkkkkkkkkkk", commitId: "older", bookmark: candidateBookmark("kkkkkkkkkkkk"), submittedBy: "fixture" });
    f.append("ahead", { type: "stage", stage: "verifying" });
    const candidate = "c".repeat(40);
    const options = { ...f.options, candidate, remote: "origin", migrationsReady: false };
    const following = new AbortController();
    const detached = releaseThroughRunner(f.cwd, { ...options, signal: following.signal });
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 2, behind landing kkkkkkkkkkkk)"));
    following.abort(new Error("detached"));
    await assert.rejects(detached, /detached/);
    const release = f.log.openOperations().find((op) => op.kind === "release")!;
    const rerun = releaseThroughRunner(f.cwd, options);
    await waitFor(() => f.lines.includes(`[runner test-runner] following the open release of ${candidate.slice(0, 12)}`));
    assert.equal(f.log.openOperations().filter((op) => op.kind === "release").length, 1, "the rerun submitted no second release");
    f.append("ahead", { type: "cancelled", reason: "fixture" });
    f.append(release.id, { type: "stage", stage: "verifying" });
    f.append(release.id, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run verify:release", output: "boom\n" });
    const { operation, logUrl } = await rerun;
    assert.equal(operation.id, release.id);
    assert.deepEqual(operation.result, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run verify:release", output: "boom\n" });
    assert.equal(logUrl, `slipjay runner log ${release.id}`);
  } finally { await f.dispose(); }
});

test("a wrong token is refused clearly before publishing or submitting", async () => {
  const f = await fixture();
  try {
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "wrong" } }), /runner refused the credential/);
    assert.equal(f.log.events().length, 0);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "pipe" }));
  } finally { await f.dispose(); }
});


test("a published landing finishes housekeeping and releases the author workspace", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", op.commitId]);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: op.commitId, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), op.commitId);
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("a decline from an older runner reports its paths and fails without landing anywhere", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    f.append(op.id, { type: "declined", reason: "migration needs local landing", paths: ["schema/change.sql"] });
    const result = await running;
    assert.equal(result.ok, false);
    assert.ok(f.lines.some((line) => line.includes("migration needs local landing") && line.includes("schema/change.sql")));
    assert.notEqual(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), op.commitId);
  } finally { await f.dispose(); }
});


test("a dropped stream reconnects from the last event without repeating progress", async () => {
  const f = await fixture(true);
  try {
    const running = landThroughRunner(f.cwd, { ...f.options, env: { ...f.options.env, SLIPJAY_RUNNER_VERBOSE: "1" } });
    void running.catch(() => {});
    await waitFor(() => f.streamRequests.length === 2);
    assert.equal(f.streamRequests[1], f.droppedSeq());
    const op = f.log.openOperations()[0]!;
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await running;
    assert.equal(f.lines.filter((line) => line === "before reconnect").length, 1);
  } finally { await f.dispose(); }
});

test("a runner restart mid-follow reconnects and reports the verdict", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const back = await f.goDown();
    await waitFor(() => f.lines.some((line) => line.includes("connection lost; reconnecting")));
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await back();
    const result = await running;
    assert.equal(result.operation.id, op.id);
    assert.equal(result.operation.status, "cancelled");
  } finally { await f.dispose(); }
});

test("a landing is recorded even when abandoning the rewritten submitted commit fails", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // The runner rewrote the candidate onto main, so the submitted commit must be abandoned locally.
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const landed = git("commit-tree", `${op.commitId}^{tree}`, "-p", "main", "-m", "Implement candidate (rewritten)");
    git("update-ref", "refs/heads/main", landed);
    // Anything that stops the abandon, as a stale working copy does in the field.
    jj(f.repo, ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', `builtin_immutable_heads() | ${op.commitId}`]);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    const name = f.cwd.split("/").at(-1)!;
    const state = await readLandingState(name, { readOnly: true });
    assert.equal(state?.phase, "landed");
    assert.equal(state?.artifactCommitId, landed);
    assert.ok(f.lines.some((line) => line.includes("jj workspace update-stale")), f.lines.join("\n"));
  } finally { await f.dispose(); }
});

test("rerunning after an unfollowed landing reattaches to it and finishes housekeeping without resubmitting", async () => {
  const f = await fixture();
  try {
    const submitted = { type: "submitted" as const, repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change), submittedBy: "earlier" };
    f.append("op_landed", submitted);
    // The earlier run published the candidate and landed it on main.
    jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${candidateBookmark(f.change)}=${f.commit}`]);
    jj(f.cwd, ["bookmark", "forget", candidateBookmark(f.change)]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", f.commit]);
    f.append("op_landed", { type: "landed", base: "fixture-base", commitId: f.commit, branch: "main", remote: "origin" });
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.ok, true);
    assert.equal(result.operation.id, "op_landed");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("an older commit's running operation is followed without moving its candidate bookmark", async () => {
  const f = await fixture();
  try {
    f.append("op_older", { type: "submitted", repo: "fixture/project", changeId: f.change, commitId: "0".repeat(40), bookmark: candidateBookmark(f.change), submittedBy: "earlier" });
    f.append("op_older", { type: "stage", stage: "verifying" });
    const running = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("verifying")));
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "--verify", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "ignore" }));
    f.append("op_older", { type: "failed", stage: "verifying", reason: "fixture failure" });
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.operation.id, "op_older");
    assert.ok(f.lines.some((line) => line.includes("land again")));
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});
