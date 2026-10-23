import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { TEST_SLICE } from "../support/executor.ts";
import { alive, fixture, hanging, test, until } from "./fixtures/runner-queue-fixture.ts";
import { assertSystemdOrSkip } from "./fixtures/systemd-gate.ts";
import { holdGate, queueFixture, verified } from "./fixtures/short-landings.ts";

// Short landings through depth two, pre-verification places, unlimited hosts and a runner restart (Build #3010).

test("a short repository's depth-two head is short, and its successor counts as long", async () => {
  const { f, held, release, status, running, settle } = await queueFixture({ verificationDepth: 2, extra: ["Fixture/E"] });
  try {
    verified(f.log, "fixture/repo", 10, 20_000, "failed");
    const b = await held("fixture/other", "b");
    await settle();
    await running(b);
    const head = await held("fixture/repo", "h");
    await settle();
    await running(head);
    assert.equal(f.log.operation(head)!.shortLanding, true, "a head is short when its repository is");
    const e = await held("fixture/e", "e");
    await settle();
    await running(e);
    assert.equal(f.log.operation(e)!.shortLanding, undefined);
    const successor = await held("fixture/repo", "s");
    await settle();
    assert.equal(status(successor), "queued", "two long operations hold both workers");
    assert.match(f.log.operation(successor)!.waitingFor ?? "", /^a worker \(/);
    await release("b");
    await running(successor);
    for (const name of ["h", "s", "e"]) await release(name);
    await f.queue.idle();
    for (const id of [head, successor, e]) assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
  } finally { for (const name of ["b", "h", "s", "e"]) await release(name); await f.dispose(); }
}, 180_000);

test("without enforced combined limits, one operation runs at a time", async () => {
  const { f, held, release, status, running, settle } = await queueFixture({ combinedLimits: false, workers: 1, other: false, extra: ["Fixture/C"] });
  try {
    verified(f.log, "fixture/c", 10, 20_000, "failed");
    const a = await held("fixture/repo", "a");
    await settle();
    await running(a);
    const c = await held("fixture/c", "c");
    await settle();
    assert.equal(status(c), "queued");
    assert.match(f.log.operation(c)!.waitingFor ?? "", /^a worker \(/);
    await release("a");
    await running(c);
    await release("c");
    await f.queue.idle();
  } finally { for (const name of ["a", "c"]) await release(name); await f.dispose(); }
}, 180_000);

test("a pre-verification keeps its place beside a short head, and a successor that waits only for one waits for it", async () => {
  const { f, held, release, status, running, settle } = await queueFixture({ verificationDepth: 2, extra: ["Fixture/D"] }, true);
  try {
    // Other is short too: its pre-verification still holds a long place.
    for (const repo of ["fixture/repo", "fixture/other"]) verified(f.log, repo, 10, 20_000, "failed");
    // Other's main moves one commit past its release branch, as a landing would leave it.
    const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
    const otherGit = (args: string[]) => execFileSync("git", ["--git-dir", join(f.root, "other.git"), ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();
    otherGit(["update-ref", "refs/heads/release", f.otherMain()]);
    otherGit(["update-ref", "refs/heads/main", otherGit(["commit-tree", `${f.otherMain()}^{tree}`, "-p", f.otherMain(), "-m", "Landed"])]);
    const d = await held("fixture/d", "d");
    await settle();
    await running(d);
    // Other's pre-verification holds its release check while `hold-release` exists.
    await writeFile(join(f.root, "hold-release"), "");
    const preverification = newOperationId();
    f.log.append(preverification, { type: "submitted", kind: "verification", repo: "fixture/other", commitId: f.otherMain(), submittedBy: "test" });
    await settle();
    await until(async () => {
      assert.ok(status(preverification) === "queued" || status(preverification) === "running", JSON.stringify(f.log.operation(preverification)));
      return await readFile(join(f.root, "release-started")).then(() => true, () => undefined);
    });
    assert.equal(status(preverification), "running");
    const head = await held("fixture/repo", "h");
    await settle();
    await running(head);
    assert.equal(f.log.operation(head)!.shortLanding, true, "the head takes the short place");
    const yields = () => f.log.events({ operationId: preverification }).flatMap(({ event }) => event.type === "yielded" ? [event.to] : []);
    assert.deepEqual(yields(), [], "nothing waits for the place it holds");
    const successor = await held("fixture/repo", "s");
    await settle();
    assert.equal(status(successor), "queued", "both workers are held");
    assert.match(f.log.operation(successor)!.waitingFor ?? "", /^a worker \(/);
    assert.equal(status(preverification), "running", "the successor does not stop it");
    await rm(join(f.root, "hold-release"), { force: true });
    await running(successor);
    assert.deepEqual(yields(), [], "it ran to its end instead of yielding");
    assert.equal(f.log.operation(preverification)!.status, "verified");
    for (const name of ["d", "h", "s"]) await release(name);
    await rm(join(f.root, "hold-release"), { force: true });
    await f.queue.idle();
    for (const id of [d, head, successor]) assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
  } finally { for (const name of ["d", "h", "s"]) await release(name); await rm(join(f.root, "hold-release"), { force: true }); await f.dispose(); }
}, 180_000);

test("a pre-verification starts beside its own repository's running landing, within the workers, and keeps a reset out", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, true, { other: true, prefixGate: holdGate });
  const hold = async (name: string, repo: string, author: string) => { await writeFile(join(f.root, name), ""); return f.submit(await f.candidate(`hold-${name}`, author, repo)); };
  const release = (name: string) => rm(join(f.root, name), { force: true });
  const status = (id: string) => f.log.operation(id)!.status;
  try {
    assert.equal((await f.land(f.submit(await f.candidate("m.txt"))))?.type, "landed");
    await f.queue.idle();
    const m = f.main();
    const a = await hold("a", "fixture/repo", f.author);
    f.queue.wake();
    await until(() => status(a) === "running" || undefined);
    // Staging deploys m again while a runs: its pre-verification is queued behind nothing but a free place.
    await rm(join(f.root, "release-started"), { force: true });
    await writeFile(join(f.root, "hold-release"), "");
    f.log.append(newOperationId(), { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: m, submittedBy: "test" });
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const preverification = f.log.verifications("fixture/repo")[0]!;
    assert.deepEqual([status(a), status(preverification.id)], ["running", "running"], "it did not wait for the landing");
    const other = await hold("o", "fixture/other", f.otherAuthor);
    f.queue.wake();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status(other), "queued", "both workers are held");
    const reset = newOperationId();
    f.log.append(reset, { type: "submitted", kind: "reset", repo: "fixture/repo", commitId: f.main(), submittedBy: "test" });
    f.queue.wake();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status(reset), "queued", "a reset never overlaps a pre-verification");
    assert.equal(status(preverification.id), "running", "and does not stop it");
    await rm(join(f.root, "hold-release"), { force: true });
    await release("a"); await release("o");
    await f.queue.idle();
    assert.equal(status(preverification.id), "verified");
    assert.ok(!f.log.events({ operationId: preverification.id }).some(({ event }) => event.type === "yielded"));
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
  } finally { for (const name of ["a", "o"]) await release(name); await rm(join(f.root, "hold-release"), { force: true }); await f.dispose(); }
}, 180_000);

test("a runner killed while a short landing runs beside two long ones ends each once, publishes nothing, and stops their commands", async () => {
  const f = await fixture(false, false, undefined, false, { other: true, extra: ["Fixture/C"], workers: 2, durable: true, scopes: true });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = "";
  const left: number[] = [];
  try {
    verified(f.log, "fixture/c", 10, 20_000, "failed");
    const before = { repo: f.main(), other: f.otherMain() };
    const pids = (name: string) => join(f.root, `${name}-pids.json`);
    const a = f.submit(await hanging(f, pids("a")));
    const b = f.submit(await hanging(f, pids("b"), f.otherAuthor, "fixture/other"));
    const c = f.submit(await hanging(f, pids("c"), f.authors["Fixture/C"]!, "fixture/c"));
    const config = { repos: { "Fixture/Repo": { url: f.origin }, "Fixture/Other": { url: join(f.root, "other.git") }, "Fixture/C": { url: join(f.root, "extra-0.git") } },
      workers: 2, jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } };
    // Under systemd the runner's own executor runs them; elsewhere commands run directly, as the fixture's do.
    const driver = `
      import { createRunnerQueue, runnerLogOptions } from ${JSON.stringify(new URL("../../src/lib/runner/runner-queue.ts", import.meta.url).href)};
      import { localExecutor } from ${JSON.stringify(new URL("../../src/lib/runner/local-executor.ts", import.meta.url).href)};
      import { runBoundedProcess } from ${JSON.stringify(new URL("../../src/lib/infra/bounded-process.ts", import.meta.url).href)};
      import { openOperationLog } from ${JSON.stringify(new URL("../../src/lib/runner/runner-log.ts", import.meta.url).href)};
      import { shortRepositories } from ${JSON.stringify(new URL("../../src/lib/runner/pipeline-metrics.ts", import.meta.url).href)};
      const local = localExecutor({ home: ${JSON.stringify(f.home)}, slice: ${JSON.stringify(TEST_SLICE)} });
      const executor = { ...local, combinedLimits: true, run: local.combinedLimits ? local.run : runBoundedProcess };
      const config = ${JSON.stringify(config)};
      const log = openOperationLog(${JSON.stringify(f.logPath)}, runnerLogOptions(config, executor), { shortRepositories });
      const queue = createRunnerQueue({ log, executor, home: ${JSON.stringify(f.home)}, config });
      queue.wake(); setInterval(() => {}, 1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    for (const name of ["a", "b", "c"]) left.push(...await until(async () => {
      assert.equal(child!.exitCode, null, stderr);
      const text = await readFile(pids(name), "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    }));
    assert.equal(f.log.operation(c)!.shortLanding, true, "C runs in the short place beside A and B");
    child.kill("SIGKILL"); await exited;
    await f.queue.recover(); await f.queue.recover();
    for (const id of [a, b, c]) {
      assert.equal(f.result(id)?.type, "failed", JSON.stringify(f.result(id)));
      assert.match(JSON.stringify(f.result(id)), /runner restarted/);
      assert.equal(f.log.events({ operationId: id }).filter(({ event }) => event.type === "failed").length, 1, "each ends once");
      assert.ok(!f.log.events({ operationId: id }).some(({ event }) => event.type === "integrated" || event.type === "landed"));
    }
    assert.deepEqual({ repo: f.main(), other: f.otherMain() }, before, "nothing was published");
    if (assertSystemdOrSkip()) assert.deepEqual(left.map(alive), left.map(() => false), "recovery stopped every command the killed runner left");
    // The new process starts with every place free.
    const next = [
      f.submit(await f.candidate("a.txt")),
      f.submit(await f.candidate("b.txt", f.otherAuthor, "fixture/other")),
      f.submit(await f.candidate("c.txt", f.authors["Fixture/C"]!, "fixture/c")),
    ];
    f.queue.wake();
    await until(() => next.every((id) => f.log.operation(id)!.status !== "queued") || undefined);
    await f.queue.idle();
    for (const id of next) assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
  } finally {
    child?.kill("SIGKILL"); await exited;
    for (const pid of left) if (alive(pid)) process.kill(pid, "SIGKILL");
    await f.dispose();
  }
}, 180_000);
