import { jj } from "../support/workspace-project.ts";
import { landFile, releaseProject, remoteParents, remoteRef, remoteTree } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { test } from "vite-plus/test";
import { confirmRelease, releaseIntegration } from "../../src/lib/release/release.ts";

const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

test("release dependency preparation uses its runner executor and cannot bypass a refused install", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "package.json", JSON.stringify({ name: "fixture-release", private: true, packageManager: `bun@${bunVersion}` }));
    const before = remoteRef(f, "release");
    const commands: string[][] = [];
    await assert.rejects(confirmRelease(f.repo, { candidate, run: async (request) => {
      commands.push([request.executable, ...request.args]);
      return { exitCode: 3, signal: null, timedOut: false, stdout: "", stderr: "executor refused install", cancelled: false,
        stdoutTruncated: false, stderrTruncated: false, finishedAt: new Date().toISOString(), outputSha256: "fixture" };
    } }), /executor refused install/);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]?.slice(0, 3), ["bun", "install", "--frozen-lockfile"]);
    assert.equal(remoteRef(f, "release"), before);
  } finally { await f.dispose(); }
});

test("a release plans, then verifies the exact candidate in the confirming checkout and publishes a merge with its tree", async () => {
  // A shallow primary, as YardSmith's is: the base exists only as fetched history.
  const f = await releaseProject({ shallow: true });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const plan = await releaseIntegration(f.repo);
    assert.equal(plan.status, "planned", JSON.stringify(plan));
    assert.ok(plan.ok && plan.status === "planned");
    assert.equal(plan.candidate, candidate);
    assert.equal(plan.base, base);
    assert.equal(plan.commits, 2);
    assert.equal(remoteRef(f, "release"), base, "planning publishes nothing");

    const released = await confirmRelease(f.repo, { candidate: candidate.slice(0, 12) });
    assert.equal(released.status, "released", JSON.stringify(released));
    assert.ok(released.ok && released.status === "released");
    assert.equal(remoteRef(f, "release"), released.merge);
    assert.deepEqual(remoteParents(f, released.merge), [base, candidate]);
    assert.equal(remoteTree(f, released.merge), remoteTree(f, candidate));
    // The check ran once, on the candidate checked out where the release was confirmed.
    assert.deepEqual((await readFile(f.verifiedRelease, "utf8")).trim().split("\n"), [await realpath(f.repo)]);
    assert.equal(jj(f.repo, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]), candidate);

    assert.equal((await releaseIntegration(f.repo)).status, "up_to_date");
  } finally {
    await f.dispose();
  }
});
