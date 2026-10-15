import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../src/lib/workspace-create.ts";
import { controlRunner, landThroughRunner, releaseThroughRunner } from "../src/lib/runner-client.ts";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import type { KillOutcome, Operation, OperationEvent, StoredEvent } from "../src/lib/runner-contract.ts";
import { serveRunner } from "../src/lib/runner-http.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { configureLocalGithubTransport, jj, project } from "./support/workspace-project.ts";

async function fixture(dropStream = false, racedSubmission = false) {
  const f = await project();
  const transport = await configureLocalGithubTransport(f);
  try {
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
    let killed: KillOutcome = { status: "idle" };
    const killRequests: (string | undefined)[] = [];
    const handler = createRunnerHandler({ log, token: "test-token", runnerName: "test-runner",
      readLog: async () => "test log", onSubmitted: () => {}, kill: (operationId) => { killRequests.push(operationId); return killed; },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
    const streamRequests: number[] = [];
    let droppedSeq = 0;
    const route = async (request: Request) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/events")) {
        streamRequests.push(Number(new URL(request.url).searchParams.get("after")));
        if (dropStream && streamRequests.length === 1) {
          const operation = log.openOperations()[0]!;
          const stored = log.append(operation.id, { type: "progress", line: "before reconnect" });
          droppedSeq = stored.seq;
          return new Response(`data: ${JSON.stringify(stored)}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
      }
      const response = await handler(request);
      if (racedSubmission && request.method === "POST" && new URL(request.url).pathname.endsWith("/operations")) {
        const body = await response.json() as { operation: Operation; reattached: boolean };
        return Response.json({ ...body, reattached: true });
      }
      return response;
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
    return { ...f, cwd, commit, change, log, append, server, lines, options, streamRequests, droppedSeq: () => droppedSeq, goDown,
      setKill: (outcome: KillOutcome) => { killed = outcome; },
      killRequests,
      dispose: async () => {
        try { await server.close(); log.close(); }
        finally { try { transport.restore(); } finally { await f.dispose(); } }
      } };
  } catch (error) {
    try { transport.restore(); } finally { await f.dispose(); }
    throw error;
  }
}

const waitFor = (condition: () => unknown) => vi.waitFor(() => assert.ok(condition()), { timeout: 10_000, interval: 20 });

test("following a server-side submission race records reattachment", async () => {
  const f = await fixture(false, true);
  try {
    const running = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const fact = f.log.events({ operationId: op.id }).find((row) => row.event.type === "client" && row.event.fact.kind === "land_follow")?.event;
    assert.equal(fact?.type === "client" && fact.fact.kind === "land_follow" && fact.fact.reattached, true);
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await running;
  } finally { await f.dispose(); }
}, 60_000);

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
    f.setKill({ status: "killed", operation });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killed ${subject}` });
    f.setKill({ status: "killed", operation: { ...operation, stage: "installing" as const } });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killing ${subject}: it stops when installing finishes, before verification` });
    f.setKill({ status: "refused", operation: { ...operation, stage: "publishing" as const } });
    assert.deepEqual(await control("kill"), { ok: false, line: `[runner test-runner] not killed: ${subject} publishing is past verification and cannot be killed; it finishes on its own` });
    const id = "op_00mv8o85yu_f70a90f79d88f6b6664c3c82";
    f.setKill({ status: "killed", operation: { ...operation, id } });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: true, line: `[runner test-runner] killed ${subject}` });
    assert.equal(f.killRequests.at(-1), id, "a named kill reaches the runner with its operation");
    f.setKill({ status: "not_running", operation: { ...operation, id, status: "landed" } });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: false, line: `[runner test-runner] not killed: ${subject} is not running (landed); nothing was killed` });
    f.setKill({ status: "not_running", operation: null });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: false, line: `[runner test-runner] not killed: ${id} is not a known operation; nothing was killed` });
    const other: Operation = { kind: "release", id: "op_00mv8o85yu_aaaaaaaaaaaaaaaaaaaaaaaa", repo: "fixture/other", commitId: "c".repeat(40), migrationsReady: false, submittedBy: "test", status: "running", stage: "verifying", submittedAt: "", runs: [], lastSeq: 2 };
    f.setKill({ status: "ambiguous", operations: [{ ...operation, id }, other] });
    assert.deepEqual(await control("kill"), { ok: false, line: `[runner test-runner] not killed: 2 operations are running; name one:\n  slipjay runner kill ${id}  (${subject}, verifying)\n  slipjay runner kill ${other.id}  (release cccccccccccc, verifying)` });
    assert.equal(f.killRequests.at(-1), undefined, "an unnamed kill names no operation");
    await assert.rejects(controlRunner(f.server.url, "kill", f.options.env, "not-an-id"), /HTTP 400: Invalid control request/);
  } finally { await f.dispose(); }
}, 60_000);

test("a landing's stages end with this machine's housekeeping once the runner reports its verdict", async () => {
  const f = await fixture(false, true);
  try {
    const stages: string[] = [];
    const running = landThroughRunner(f.cwd, { ...f.options, onStage: (stage) => stages.push(stage) });
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    f.append(f.log.openOperations()[0]!.id, { type: "cancelled", reason: "fixture done" });
    await running;
    assert.equal(stages.at(-1), "housekeeping", stages.join());
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
    f.append("ahead", { type: "submitted", kind: "release", repo: "fixture/project", commitId: "o".repeat(40), migrationsReady: false, submittedBy: "fixture" });
    f.append("ahead", { type: "stage", stage: "verifying" });
    const candidate = "c".repeat(40);
    const options = { ...f.options, candidate, remote: "origin", migrationsReady: false };
    const following = new AbortController();
    const detached = releaseThroughRunner(f.cwd, { ...options, signal: following.signal });
    await waitFor(() => f.lines.includes("[runner test-runner] queued (position 2, behind release oooooooooooo)"));
    following.abort(new Error("detached"));
    await assert.rejects(detached, /detached/);
    const release = f.log.openOperations().find((op) => op.kind === "release" && op.commitId === candidate)!;
    const rerun = releaseThroughRunner(f.cwd, options);
    await waitFor(() => f.lines.includes(`[runner test-runner] following the open release of ${candidate.slice(0, 12)}`));
    assert.equal(f.log.openOperations().filter((op) => op.kind === "release" && op.commitId === candidate).length, 1, "the rerun submitted no second release");
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

test("a landed stack the runner rebased leaves none of its submitted commits behind", async () => {
  const f = await fixture();
  try {
    jj(f.cwd, ["new"]);
    await writeFile(join(f.cwd, "second.txt"), "second\n");
    jj(f.cwd, ["describe", "-m", "Implement the second commit"]);
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // Another landing advanced main, so the runner rewrote both commits onto it.
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const upstream = git("commit-tree", "main^{tree}", "-p", "main", "-m", "Land upstream");
    const lower = git("commit-tree", `${f.commit}^{tree}`, "-p", upstream, "-m", "Implement candidate (rewritten)");
    const upper = git("commit-tree", `${op.commitId}^{tree}`, "-p", lower, "-m", "Implement the second commit (rewritten)");
    git("update-ref", "refs/heads/main", upper);
    f.append(op.id, { type: "landed", base: upstream, commitId: upper, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true, f.lines.join("\n"));
    // Nothing undelivered remained, so housekeeping released the workspace.
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
    assert.equal(jj(f.repo, ["log", "-r", `(${f.commit} | ${op.commitId}) & ::visible_heads()`, "--no-graph", "-T", 'commit_id ++ "\\n"']), "");
  } finally { await f.dispose(); }
});

test("a landing finishes housekeeping even when abandoning the rewritten submitted commit fails", async () => {
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
    // The working copy moved onto the landed commit, so housekeeping released the workspace.
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
    assert.ok(f.lines.some((line) => line.includes(`jj abandon '::${op.commitId}`)), f.lines.join("\n"));
  } finally { await f.dispose(); }
});

test("a full fetch while the candidate is queued does not leave the landed commit divergent or the author's commit immutable", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // Another session fetches every remote bookmark, importing the candidate bookmark while it exists on origin.
    jj(f.repo, ["git", "fetch"]);
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const landed = git("commit-tree", `${op.commitId}^{tree}`, "-p", "main", "-m", "Implement candidate (rewritten)");
    git("update-ref", "refs/heads/main", landed);
    git("update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true, f.lines.join("\n"));
    assert.ok(!f.lines.some((line) => line.includes("Could not abandon")), f.lines.join("\n"));
    assert.equal(jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", 'change_id ++ "\\n"']), "");
    assert.equal(jj(f.repo, ["log", "-r", `visible_heads() & ${f.commit}`, "--no-graph", "-T", "commit_id"]), "");
  } finally { await f.dispose(); }
});

test("after a runner rebase conflict, fetching and rebasing keeps the change visible and editable at @", async () => {
  const f = await fixture();
  try {
    // Another landing changes the same file first, so the runner's rebase conflicts.
    const other = join(f.root, "other");
    const git = (args: string[]) => execFileSync("git", ["-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args]);
    execFileSync("git", ["clone", "-q", f.remote, other]);
    await writeFile(join(other, "change.txt"), "upstream\n");
    git(["add", "change.txt"]);
    git(["commit", "-qm", "Land upstream"]);
    git(["push", "-q", "origin", "main"]);
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    jj(f.repo, ["git", "fetch"]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`]);
    f.append(op.id, { type: "failed", stage: "rebasing", reason: "Rebase produced conflicts; resolve them in this workspace and retry:\nchange.txt" });
    assert.equal((await running).ok, false);
    jj(f.cwd, ["git", "fetch"]);
    jj(f.cwd, ["rebase", "-b", "@", "-d", "main@origin"]);
    await writeFile(join(f.cwd, "change.txt"), "upstream\ncandidate\n");
    jj(f.cwd, ["describe", "-m", "Implement candidate, rebased"]);
    const at = (template: string) => jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", template]);
    assert.equal(at("change_id"), f.change);
    assert.equal(at("conflict"), "false");
    assert.match(at("description"), /rebased/);
    assert.equal(jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"]), "Land upstream");
  } finally { await f.dispose(); }
});

test("a failed landing leaves the author's commit editable after a full fetch imported its candidate", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    jj(f.repo, ["git", "fetch"]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`]);
    f.append(op.id, { type: "failed", stage: "verifying", reason: "gate failed" });
    assert.equal((await running).ok, false);
    jj(f.cwd, ["describe", "-m", "Implement candidate, fixed"]);
    assert.match(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]), /fixed/);
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

test("a reland after the change landed, with an empty working copy on an immutable integrated parent, submits nothing", async () => {
  const f = await fixture();
  try {
    const base = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    const baseChange = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "change_id"]);
    f.append("op_landed", { type: "submitted", repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change), submittedBy: "earlier" });
    jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${candidateBookmark(f.change)}=${f.commit}`]);
    jj(f.cwd, ["bookmark", "forget", "--include-remotes", candidateBookmark(f.change)]);
    // The runner rebased the candidate, so main holds a different commit of the same change.
    const landed = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${f.commit}^{tree}`, "-p", base, "-m", "Implement candidate (landed)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", landed]);
    f.append("op_landed", { type: "landed", base, commitId: landed, branch: "main", remote: "origin" });
    // As after a concurrent fetch hid the candidate: an empty working copy on the old base, now immutable.
    jj(f.cwd, ["abandon", f.commit]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    assert.equal(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "empty"]), "true");
    assert.equal(jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "immutable"]), "true");
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.ok, true);
    assert.equal(result.operation.id, "op_landed");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "--verify", `refs/heads/${candidateBookmark(baseChange)}`], { stdio: "ignore" }));
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("an empty working copy on another workspace's landed change submits nothing and reports no landing, even when the local bookmark lags", async () => {
  const f = await fixture();
  try {
    const base = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    // Another workspace's change landed on main, rebased by the runner into a new commit.
    const other = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Other change"], { encoding: "utf8" }).trim();
    const submittedOther = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Other change (submitted)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", other]);
    // This workspace's own edit never happened: its working copy is empty on that change.
    jj(f.cwd, ["abandon", f.commit]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    jj(f.cwd, ["new", other]);
    const otherChange = jj(f.cwd, ["log", "-r", other, "--no-graph", "-T", "change_id"]);
    f.append("op_other", { type: "submitted", repo: "fixture/project", changeId: otherChange, commitId: submittedOther, bookmark: candidateBookmark(otherChange), submittedBy: "elsewhere:other-workspace" });
    f.append("op_other", { type: "landed", base, commitId: other, branch: "main", remote: "origin" });
    // The local main lags its remote, so the landed change does not look integrated here.
    jj(f.cwd, ["bookmark", "set", "main", "-r", base, "--allow-backwards"]);
    await assert.rejects(landThroughRunner(f.cwd, f.options), /Nothing to land/);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});

test("a landed candidate made immutable by a re-imported remote bookmark is still dropped", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // The runner rebased the candidate, and a fetch elsewhere re-imported its remote bookmark untracked.
    const base = jj(f.cwd, ["log", "-r", `${f.commit}-`, "--no-graph", "-T", "commit_id"]);
    const landed = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${f.commit}^{tree}`, "-p", base, "-m", "Implement candidate (landed)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", landed]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", candidateBookmark(f.change)]);
    assert.equal(jj(f.cwd, ["log", "-r", f.commit, "--no-graph", "-T", "immutable"]), "true");
    f.append(op.id, { type: "landed", base, commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
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

test("cancel uses the authenticated transport and attributes the hostname, preserving refusal", async () => {
  const { cancelThroughRunner } = await import("../src/lib/runner-client.ts");
  const { hostname } = await import("node:os");
  const bodies: unknown[] = [];
  const server = await serveRunner(
    async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
      if (new URL(request.url).pathname === "/v1/health")
        return Response.json({ runner: "fixture" });
      bodies.push(await request.json());
      return Response.json({ error: "operation is not queued" }, { status: 409 });
    },
    { host: "127.0.0.1", port: 0 },
  );
  try {
    const result = await cancelThroughRunner(server.url, "running", {
      SLIPJAY_RUNNER_TOKEN: "fixture-token",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.result, { error: "operation is not queued" });
    assert.deepEqual(bodies, [{ by: hostname() }]);
  } finally {
    await server.close();
  }
});
