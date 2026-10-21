import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";

// These drive the runner through checks that fail in turn, so they need the verification core
// (SJ-51) to keep going after a failed check and to throw one error carrying every failure.
const failing = (file: string, label: string, code = 3) => `const fs=require("node:fs");if(fs.existsSync(${JSON.stringify(file)})){process.stderr.write("FAIL tests/${label}.test.ts > ${label} > breaks\\n");process.exit(${code});}`;
const checkRuns = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.log.operation(id)!.runs.filter((run) => run.purpose === "gate");

test("a landing with two failing sequential checks and a passing one reports both, each with its own run", async () => {
  const f = await fixture(false, false, undefined, false, { gates: () => [failing("fail-a", "a"), failing("fail-b", "b"), "process.exit(0)"] });
  try {
    await f.candidate("fail-a");
    await writeFile(join(f.author, "fail-b"), "");
    const id = f.submit(await f.push());
    const result = await f.land(id);
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.equal(result.stage, "verifying");
    assert.deepEqual(result.failures?.map((failure) => [failure.checkIndex, failure.outcome]), [[0, "nonzero_exit"], [1, "nonzero_exit"]]);
    const runs = checkRuns(f, id);
    assert.equal(runs.length, 3, "every declared check ran");
    assert.deepEqual(result.failures?.map((failure) => failure.runId), [runs[0]!.runId, runs[1]!.runId]);
    assert.match(result.output ?? "", /tests\/a\.test\.ts/, "the legacy fields keep the first failure");
    assert.match(result.reason, /tests\/a\.test\.ts/);
    assert.match(result.reason, /tests\/b\.test\.ts/);
    const fact = f.log.events({ operationId: id }).find((row) => row.event.type === "classified")?.event;
    assert.ok(fact?.type === "classified" && fact.cause === "gate");
    assert.deepEqual(fact.checks?.map((check) => [check.runId, check.failingTests]), [
      [runs[0]!.runId, ["tests/a.test.ts > a > breaks"]], [runs[1]!.runId, ["tests/b.test.ts > b > breaks"]],
    ]);
  } finally { await f.dispose(); }
}, 120_000);

test("the same command declared twice and failing twice is attributed to two distinct runs", async () => {
  const same = failing("fail-a", "same");
  const f = await fixture(false, false, undefined, false, { gates: () => [same, same] });
  try {
    const id = f.submit(await f.candidate("fail-a"));
    const result = await f.land(id);
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.equal(result.failures?.length, 2);
    assert.equal(result.failures![0]!.command, result.failures![1]!.command);
    assert.ok(result.failures![0]!.runId && result.failures![1]!.runId);
    assert.notEqual(result.failures![0]!.runId, result.failures![1]!.runId);
    assert.deepEqual(result.failures!.map((failure) => failure.runId), checkRuns(f, id).map((run) => run.runId));
  } finally { await f.dispose(); }
}, 120_000);

test("a passing landing's events carry no failure list", async () => {
  const f = await fixture(false, false, undefined, false, { gates: () => [failing("fail-a", "a"), "process.exit(0)"] });
  try {
    const result = await f.land(f.submit(await f.candidate("fine.txt")));
    assert.equal(result?.type, "landed", JSON.stringify(result));
    assert.equal(f.log.events().some((row) => row.event.type === "failed" || row.event.type === "classified"), false);
  } finally { await f.dispose(); }
}, 120_000);

test("an owner kill after an earlier failed check is cancelled, not a gate failure", async () => {
  const f = await fixture(false, false, undefined, false, { gates: (root) => [failing("fail-a", "a"),
    `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(join(root, "second-started"))},"");setInterval(()=>{},1000);`] });
  try {
    const id = f.submit(await f.candidate("fail-a"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "second-started"), "utf8").then(() => true, () => undefined));
    const outcome = f.queue.kill();
    assert.ok(outcome.status === "killed", JSON.stringify(outcome));
    await f.queue.idle();
    assert.deepEqual(f.result(id), { type: "cancelled", reason: OWNER_KILL_REASON });
    const fact = f.log.events({ operationId: id }).find((row) => row.event.type === "classified")?.event;
    assert.ok(fact?.type === "classified" && fact.cause === "killed");
    assert.equal(fact.checks, undefined);
  } finally { await f.dispose(); }
}, 120_000);

const releaseGates = (root: string) => [failing(join(root, "fail-release-2"), "release2", 5)];

test("runner-managed release verification with two failing checks records both", async () => {
  const f = await fixture(false, true, undefined, false, { releaseGates });
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "fail-release"), "");
    await writeFile(join(f.root, "fail-release-2"), "");
    const base = f.releaseRef();
    const outcome = await f.land(f.submitRelease(f.main()));
    assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
    assert.match(outcome.output ?? "", /release boom/, "the legacy fields keep the first failure");
    assert.deepEqual(outcome.failures?.map((failure) => failure.checkIndex), [0, 1]);
    assert.notEqual(outcome.failures![0]!.runId, outcome.failures![1]!.runId);
    assert.match(outcome.reason, /release2/);
    assert.equal(f.releaseRef(), base);
  } finally { await f.dispose(); }
}, 120_000);

test("pre-verification with two failing checks records both in its failed event", async () => {
  const f = await fixture(false, true, undefined, false, { releaseGates });
  try {
    await writeFile(join(f.root, "fail-release"), "");
    await writeFile(join(f.root, "fail-release-2"), "");
    // Main one commit past the release branch, as a landing leaves it, without a landing's staging wait.
    const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
    const git = (args: string[]) => execFileSync("git", ["--git-dir", join(f.root, "origin.git"), ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();
    git(["update-ref", "refs/heads/main", git(["commit-tree", `${f.main()}^{tree}`, "-p", f.main(), "-m", "Landed"])]);
    const id = newOperationId();
    f.log.append(id, { type: "submitted", kind: "verification", repo: "fixture/repo", commitId: f.main(), submittedBy: "test" });
    const outcome = await f.land(id);
    assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
    assert.deepEqual(outcome.failures?.map((failure) => failure.checkIndex), [0, 1]);
    assert.ok(outcome.failures!.every((failure) => failure.runId));
  } finally { await f.dispose(); }
}, 120_000);
