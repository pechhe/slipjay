import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { promotingProject } from "./fixtures/release-fixture.ts";
import { jj } from "../support/workspace-project.ts";
import { remoteRef } from "../support/release-project.ts";
import { confirmRelease, releaseIntegration } from "../../src/lib/release/release.ts";
import type { BuildReader } from "../../src/lib/build/tracker.ts";
import type { BuildReleasePlan } from "../../src/lib/release/release-build.ts";

async function proposalProject() {
  const f = await promotingProject();
  jj(f.repo, ["git", "remote", "add", "github", "https://github.com/fixture/repo.git"]);
  const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
  await f.commit({ "slipjay.json": JSON.stringify({ ...policy, tracker: "build", specGateDeclarations: "gates.ts" }), "gates.ts": "" }, "Declare Build");
  const publications = new Map<string, { number: number; state: "accepted" | "held" }>();
  const commit = async (number: number, state: "accepted" | "held") => {
    const id = await f.commit({ [`${number}.txt`]: `${number}\n` }, `Spec ${number}\n\nBuild: #${number}`);
    publications.set(id, { number, state });
    return id;
  };
  const calls: Record<string, unknown>[] = [];
  const read: BuildReader = async (action, input) => {
    assert.equal(action, "release_plan");
    calls.push(input);
    const commits = (input.commits as { commitId: string }[]).map(({ commitId }) => {
      const spec = publications.get(commitId);
      return { commitId, kind: spec ? "spec" as const : "chore" as const, specId: spec ? `spec-${spec.number}` : null, number: spec?.number ?? null };
    });
    const specs = commits.filter((entry) => entry.kind === "spec").map(({ commitId, specId, number }) => {
      const { state } = publications.get(commitId)!;
      return { specId: specId!, number: number!, title: `Feature ${number}`, status: "landed", level: "owner" as const,
        state, heldReason: state === "held" ? "not_accepted" as const : null, commitIds: [commitId] };
    });
    return { repository: input.repository, commits, specs, releasable: specs.every((spec) => spec.state === "accepted") };
  };
  const plan = (stagingGreen: string, stagingGreens: string[], readBuild = read) => releaseIntegration(f.repo, {
    readBuild, readPromotion: async () => ({ stagingGreen, stagingGreens, approved: [], verifications: [] }) });
  return { ...f, commitFiles: f.commit, commit, publications, calls, read, plan };
}

test("proposal walks only staging-green integration commits and names everything withheld above the newest releasable range", async () => {
  const f = await proposalProject();
  try {
    const accepted = await f.commit(10, "accepted");
    await f.commit(11, "accepted"); // Never staged: cannot be proposed.
    const held = await f.commit(12, "held");
    await f.commit(13, "accepted"); // Integration tip has not staged yet.
    const result = await f.plan(held, [held, accepted]);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, accepted);
    assert.equal(result.candidate, accepted);
    assert.equal(result.newestStagingGreen, held);
    assert.equal(result.releasable, true);
    assert.equal(result.verification?.commit, accepted);
    assert.ok(result.paths.includes("10.txt") && !result.paths.includes("11.txt"));
    assert.deepEqual(result.heldBack?.map((spec) => [spec.number, spec.title, spec.heldReason]).sort(),
      [[11, "Feature 11", null], [12, "Feature 12", "not_accepted"]]);
    assert.deepEqual(result.proposalSearch, { checked: 2, limit: 8, exhausted: false });
    assert.match(result.next, new RegExp(`--confirm ${accepted.slice(0, 12)}`));
    const base = remoteRef(f, "release");
    const refused = await confirmRelease(f.repo, { candidate: held, readBuild: f.read });
    assert.ok(!refused.ok && refused.status === "refused");
    assert.match(refused.reason, /#12 Feature 12: not_accepted/);
    assert.equal(remoteRef(f, "release"), base);
    const withoutOlderStagingEvidence = await f.plan(held, []);
    assert.ok(withoutOlderStagingEvidence.ok && withoutOlderStagingEvidence.status === "planned");
    assert.equal(withoutOlderStagingEvidence.proposed, null, "an accepted ancestor alone is not proof of staging success");
    const unclassified: BuildReader = async (action, input) => {
      const answer = await f.read(action, input) as BuildReleasePlan;
      return { ...answer, releasable: true, specs: answer.specs.filter((spec) => spec.number !== 12),
        commits: answer.commits.map((commit) => commit.number === 12 ? { ...commit, kind: "unclassified", specId: null, number: null } : commit) };
    };
    const withoutUnclassified = await f.plan(held, [held, accepted], unclassified);
    assert.ok(withoutUnclassified.ok && withoutUnclassified.status === "planned");
    assert.equal(withoutUnclassified.proposed, accepted);
    assert.deepEqual(withoutUnclassified.heldBackUnclassifiedCommits, [held]);
  } finally { await f.dispose(); }
});

test("newest releasable staging candidate wins, even after a newer deployment record of an older commit", async () => {
  const f = await proposalProject();
  try {
    const older = await f.commit(20, "accepted");
    const newer = await f.commit(21, "accepted");
    const result = await f.plan(older, [older, newer]);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, newer);
    assert.deepEqual(result.heldBack, []);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test("no releasable staged range proposes nothing and retains held Spec names and reasons", async () => {
  const f = await proposalProject();
  try {
    const older = await f.commit(30, "held");
    const newer = await f.commit(31, "accepted");
    const result = await f.plan(newer, [newer, older]);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, null);
    assert.equal(result.releasable, false);
    assert.match(result.proposalReason!, /No unreleased staging-green candidate/);
    assert.deepEqual(result.heldBack?.find((spec) => spec.number === 30), {
      specId: "spec-30", number: 30, title: "Feature 30", status: "landed", level: "owner", state: "held", heldReason: "not_accepted", commitIds: [older] });
    assert.doesNotMatch(result.next, /--confirm/);
    assert.equal(f.calls.length, 2);
  } finally { await f.dispose(); }
});

test("Build read budget stops the search without claiming an unchecked older candidate is releasable", async () => {
  const f = await proposalProject();
  try {
    const green = [await f.commit(40, "accepted")];
    green.push(await f.commit(41, "held"));
    for (let number = 42; number <= 49; number += 1) green.push(await f.commit(number, "accepted"));
    const result = await f.plan(green.at(-1)!, green);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, null);
    assert.equal(f.calls.length, 8);
    assert.deepEqual(result.proposalSearch, { checked: 8, limit: 8, exhausted: true });
    assert.match(result.proposalReason!, /older staging-green commits remain unchecked/);
    assert.equal(result.heldBack?.find((spec) => spec.number === 41)?.heldReason, "not_accepted");
    const bulk = Array.from({ length: 2001 }, (_, index) => {
      const message = `Bulk ${index}`;
      return `commit refs/heads/bulk\nmark :${index + 1}\ncommitter Fixture <fixture@example.com> 1700000000 +0000\ndata ${message.length}\n${message}\nfrom ${index ? `:${index}` : green.at(-1)}\n\n`;
    }).join("");
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8", stdio: "pipe" }).trim();
    execFileSync("git", ["fast-import", "--quiet"], { cwd: f.repo, input: bulk, stdio: "pipe" });
    const head = git(["rev-parse", "bulk"]);
    git(["push", "origin", "bulk:main"]);
    const bounded = await f.plan(head, [head]);
    assert.ok(!bounded.ok && bounded.status === "refused", JSON.stringify(bounded));
    assert.equal(bounded.proposed, null);
    assert.match(bounded.reason, /2000-commit integration history limit/);
    assert.equal(f.calls.length, 8, "history exhaustion makes no further Build calls");
  } finally { await f.dispose(); }
});

test("a failed Build read while walking proposes nothing and retains the newest held evidence", async () => {
  const f = await proposalProject();
  try {
    const older = await f.commit(50, "accepted");
    const newer = await f.commit(51, "held");
    let calls = 0;
    const reader: BuildReader = (action, input) => {
      if (++calls === 2) throw new Error("Build offline");
      return f.read(action, input);
    };
    const result = await f.plan(newer, [older, newer], reader);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, null);
    assert.equal(result.releasable, false);
    assert.match(result.proposalReason!, /Build offline/);
    assert.equal(result.heldBack?.find((spec) => spec.number === 51)?.title, "Feature 51");
    assert.equal(calls, 2);
  } finally { await f.dispose(); }
});

test("each older candidate uses its own gate declarations instead of inheriting the newest gates", async () => {
  const f = await proposalProject();
  try {
    const older = await f.commit(60, "accepted");
    const newer = await f.commitFiles({ "gates.ts": "defineSpecGate(61);" }, "Declare gate 61");
    // The older range can become held when a gate only declared later is absent.
    const reader: BuildReader = async (action, input) => {
      const answer = await f.read(action, input) as BuildReleasePlan;
      return { ...answer, releasable: false, specs: answer.specs.map((spec) => ({ ...spec, state: "held", heldReason: (input.declaredGates as number[]).length ? "not_accepted" : "gate_not_declared" })) };
    };
    const result = await f.plan(newer, [older, newer], reader);
    assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
    assert.equal(result.proposed, null);
    assert.deepEqual(f.calls.map((input) => input.declaredGates), [[61], []]);
  } finally { await f.dispose(); }
});
