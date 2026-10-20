import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { probeCheckout, probeSubmission, submissionProbe } from "../../src/lib/landing/submission-probe.ts";
import { retainSubmissionSource } from "../../src/lib/landing/submission-source.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { candidateBookmark, RUNNER_API, RUNNER_JJ_DEFAULTS } from "../../src/lib/runner/runner-contract.ts";
import type { SubmitRequest } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { jj, project } from "../support/workspace-project.ts";
import { directExecutor } from "../support/executor.ts";

/** A runner handler that retains and probes submissions for real, over a disposable project. */
async function runner() {
  const f = await project();
  const home = join(f.root, "runner");
  await mkdir(home);
  const log = openOperationLog(":memory:");
  const handler = createRunnerHandler({
    log, token: "test-token", runnerName: "test-runner",
    readLog: async () => null, onSubmitted: () => {}, kill: () => ({ status: "idle" }), subscribe: () => () => {},
    retainSubmission: (operationId, request) => retainSubmissionSource({ home, operationId, request, url: f.remote, executor: directExecutor("test") }),
    probeSubmission: (request, ahead) => probeSubmission({ home, url: f.remote, jjConfig: RUNNER_JJ_DEFAULTS, request, ahead }),
  });
  const server = await serveRunner(handler, { host: "127.0.0.1", port: 0 });
  /** A change on the remote's main, as another landing that already published. */
  const publish = async (file: string, text: string) => {
    jj(f.repo, ["new", "main@origin"]);
    await writeFile(join(f.repo, file), text);
    jj(f.repo, ["describe", "-m", `Publish ${file}`]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    jj(f.repo, ["git", "push", "--remote", "origin", "--bookmark", "main"]);
  };
  /** A candidate on the current main, pushed under its bookmark and submitted. */
  const submit = async (file: string, text: string, parents = ["main@origin"]) => {
    jj(f.repo, ["new", ...parents]);
    return revise(file, text);
  };
  /** A new revision of the candidate last submitted, pushed and submitted to replace it. */
  const revise = async (file: string, text: string) => {
    await writeFile(join(f.repo, file), text);
    jj(f.repo, ["describe", "-m", `Change ${file}`]);
    const at = (template: string) => jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", template]);
    const changeId = at("change_id");
    const commitId = at("commit_id");
    const bookmark = candidateBookmark(changeId);
    execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", "-q", f.remote, `+${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });
    const body: SubmitRequest = { repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "fixture" };
    const response = await fetch(`${server.url}${RUNNER_API}/operations`, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: "Bearer test-token" }, signal: AbortSignal.timeout(60_000) });
    return { changeId, status: response.status, body: await response.json() as Record<string, unknown> & { operation?: { id: string } } };
  };
  return { ...f, log, publish, submit, revise, dispose: async () => { await server.close(); log.close(); await f.dispose(); } };
}

test("a submission that conflicts with a landing queued ahead is refused before it queues, naming the paths and that change", async () => {
  const f = await runner();
  try {
    const ahead = await f.submit("README.md", "queued ahead\n");
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
    const aheadId = ahead.body.operation!.id;
    // A clean one queues behind it as before.
    const clean = await f.submit("other.txt", "unrelated\n");
    assert.equal(clean.status, 200, JSON.stringify(clean.body));
    const conflicting = await f.submit("README.md", "candidate\n");
    assert.equal(conflicting.status, 422, JSON.stringify(conflicting.body));
    assert.equal(conflicting.body.code, "conflicts_ahead");
    assert.deepEqual(conflicting.body.paths, ["README.md"]);
    assert.deepEqual(conflicting.body.conflictsWith, { operationId: aheadId, changeId: ahead.changeId });
    assert.match(String(conflicting.body.error), new RegExp(`${aheadId}.*README\\.md`));
    assert.deepEqual(f.log.openOperations().map((operation) => operation.id), [aheadId, clean.body.operation!.id]);
  } finally { await f.dispose(); }
}, 120_000);

test("a submission that conflicts with the integration head alone is refused without naming a queued change", async () => {
  const f = await runner();
  try {
    const base = jj(f.repo, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);
    await f.publish("README.md", "published\n");
    // The candidate was written on the older head.
    jj(f.repo, ["new", base]);
    await writeFile(join(f.repo, "README.md"), "candidate\n");
    const stale = await (async () => {
      jj(f.repo, ["describe", "-m", "Change README.md on the old head"]);
      const changeId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
      const commitId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      const bookmark = candidateBookmark(changeId);
      execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", "-q", f.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });
      return probeSubmission({ home: join(f.root, "runner"), url: f.remote, jjConfig: RUNNER_JJ_DEFAULTS, ahead: [],
        request: { repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "fixture" } });
    })();
    assert.deepEqual(stale, { paths: ["README.md"], conflictsWith: null });
    assert.equal(f.log.openOperations().length, 0);
  } finally { await f.dispose(); }
}, 120_000);

test("a merge candidate is probed after its first-parent line moves onto the landing ahead", async () => {
  const f = await runner();
  try {
    const base = jj(f.repo, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);
    const ahead = await f.submit("README.md", "queued ahead\n");
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
    // An upstream line merged in, with the integration line as first parent.
    jj(f.repo, ["new", base]);
    await writeFile(join(f.repo, "upstream.txt"), "upstream\n");
    jj(f.repo, ["describe", "-m", "Upstream"]);
    const upstream = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const merge = await f.submit("README.md", "merge candidate\n", [base, upstream]);
    assert.equal(merge.status, 422, JSON.stringify(merge.body));
    assert.deepEqual(merge.body.paths, ["README.md"]);
    assert.deepEqual(merge.body.conflictsWith, { operationId: ahead.body.operation!.id, changeId: ahead.changeId });
  } finally { await f.dispose(); }
}, 120_000);

test("a fork whose remote default carries no policy is probed against the integration branch its candidate declares", async () => {
  const f = await project();
  try {
    const initial = jj(f.repo, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);
    // The fork's integration line declares `fork`; the remote's default, `main`, is upstream's and has no policy.
    jj(f.repo, ["new", initial]);
    const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ ...policy, integrationBranch: "fork" }));
    jj(f.repo, ["describe", "-m", "Fork policy"]);
    const forkBase = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["new"]);
    await writeFile(join(f.repo, "README.md"), "published on the fork\n");
    jj(f.repo, ["describe", "-m", "Publish README.md on the fork"]);
    jj(f.repo, ["bookmark", "set", "fork", "-r", "@"]);
    jj(f.repo, ["new", initial]);
    await rm(join(f.repo, "slipjay.json"));
    jj(f.repo, ["describe", "-m", "Upstream"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@", "--allow-backwards"]);
    jj(f.repo, ["git", "push", "--remote", "origin", "--bookmark", "fork", "--bookmark", "main"]);
    // The candidate was written on the fork's older head, so it conflicts with that head and nothing else.
    jj(f.repo, ["new", forkBase]);
    await writeFile(join(f.repo, "README.md"), "candidate\n");
    jj(f.repo, ["describe", "-m", "Change README.md on the fork"]);
    const changeId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const commitId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const bookmark = candidateBookmark(changeId);
    execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", "-q", f.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });
    const request: SubmitRequest = { repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "fixture" };
    const probe = () => probeSubmission({ home: join(f.root, "runner"), url: f.remote, jjConfig: RUNNER_JJ_DEFAULTS, ahead: [], request });
    assert.deepEqual(await probe(), { paths: ["README.md"], conflictsWith: null });
    // Again from the checkout the first probe left behind.
    assert.deepEqual(await probe(), { paths: ["README.md"], conflictsWith: null });
  } finally { await f.dispose(); }
}, 120_000);

test("the probe checkout carries the runner's jj settings", async () => {
  const f = await runner();
  try {
    await f.submit("a.txt", "a\n");
    const checkout = probeCheckout(join(f.root, "runner"), "owner/repo");
    assert.equal(jj(checkout, ["config", "get", "snapshot.max-new-file-size"]), RUNNER_JJ_DEFAULTS["snapshot.max-new-file-size"]);
  } finally { await f.dispose(); }
}, 120_000);

test("a probe over budget, or behind its repository's running probe, lets the submission queue unchecked", async () => {
  const f = await project();
  try {
    const skipped: string[] = [];
    // A remote that accepts the clone's connection and never answers, so the clone outlasts the budget.
    const held = new Set<Socket>();
    const silent = createServer((socket) => { held.add(socket); });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    const probe = submissionProbe({ home: join(f.root, "runner"), url: () => `http://127.0.0.1:${port}/repo.git`, jjConfig: {}, budgetMs: 200,
      onSkipped: (_repo, reason) => skipped.push(reason) });
    const request: SubmitRequest = { repo: "owner/repo", changeId: "c", commitId: "0".repeat(40), bookmark: "b", submittedBy: "fixture" };
    assert.equal(await probe(request, []), null);
    assert.match(skipped[0] ?? "", /over its 0s budget/);
    assert.equal(await probe(request, []), null);
    assert.equal(skipped[1], "the previous probe is still running");
    for (const socket of held) socket.destroy();
    silent.close();
  } finally { await f.dispose(); }
}, 30_000);

test("a refused replacement names its change's earlier candidate, which stays queued", async () => {
  const f = await runner();
  try {
    const ahead = await f.submit("README.md", "queued ahead\n");
    const earlier = await f.submit("other.txt", "unrelated\n");
    assert.equal(earlier.status, 200, JSON.stringify(earlier.body));
    const earlierId = earlier.body.operation!.id;
    const replacement = await f.revise("README.md", "candidate\n");
    assert.equal(replacement.status, 422, JSON.stringify(replacement.body));
    assert.equal(replacement.body.stillQueued, earlierId);
    assert.match(String(replacement.body.error), new RegExp(`slipjay cancel ${earlierId}`));
    assert.deepEqual(f.log.openOperations().map((operation) => operation.id), [ahead.body.operation!.id, earlierId]);
  } finally { await f.dispose(); }
}, 120_000);

test("a probe still running for one repository does not hold another repository's submission", async () => {
  let unblock!: () => void;
  const blocked = new Promise<null>((resolve) => { unblock = () => resolve(null); });
  const log = openOperationLog(":memory:");
  const handler = createRunnerHandler({
    log, token: "test-token", runnerName: "test-runner",
    readLog: async () => null, onSubmitted: () => {}, kill: () => ({ status: "idle" }), subscribe: () => () => {},
    probeSubmission: (request) => request.repo === "owner/slow" ? blocked : Promise.resolve(null),
  });
  const server = await serveRunner(handler, { host: "127.0.0.1", port: 0 });
  try {
    const post = (repo: string, changeId: string) => fetch(`${server.url}${RUNNER_API}/operations`, { method: "POST",
      headers: { authorization: "Bearer test-token" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ repo, changeId, commitId: "a".repeat(40), bookmark: candidateBookmark(changeId), submittedBy: "fixture" } satisfies SubmitRequest) });
    const slow = post("owner/slow", "k".repeat(32));
    // Queued while the slow repository's probe still runs.
    assert.equal((await post("owner/fast", "z".repeat(32))).status, 200);
    unblock();
    assert.equal((await slow).status, 200);
  } finally { await server.close(); log.close(); }
}, 60_000);
