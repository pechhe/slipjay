import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";
import { confirmRelease, confirmableCandidate, releaseIntegration } from "../../src/lib/release/release.ts";
import type { PromotionState } from "../../src/lib/release/release.ts";
import { landFile, releaseProject } from "../support/release-project.ts";
import { promotingProject, verificationOf } from "./fixtures/release-fixture.ts";

test("a requested older staging-green commit is planned with the newer green commits it leaves out, and every other commit is refused", async () => {
  const f = await promotingProject();
  try {
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const b = await f.commit({ "b.txt": "b\n" }, "Add b");
    const c = await f.commit({ "c.txt": "c\n" }, "Add c");
    const red = await f.commit({ "d.txt": "d\n" }, "Add d");
    const state = (verifications: PromotionState["verifications"] = []): PromotionState =>
      ({ stagingGreen: c, stagingGreenCommits: [c, b, a], approved: [], verifications });
    const plan = (candidate?: string, extra: { requestVerification?: (commit: string) => Promise<void> } = {}, read = async () => state()) =>
      releaseIntegration(f.repo, { readPromotion: read, ...candidate ? { candidate } : {}, ...extra });

    const newest = await plan();
    assert.ok(newest.ok && newest.status === "planned", JSON.stringify(newest));
    assert.equal(newest.candidate, c);
    assert.equal(newest.candidateSource, "newest_green");
    assert.equal(newest.newerGreen, undefined);

    const older = await plan(b.slice(0, 12));
    assert.ok(older.ok && older.status === "planned", JSON.stringify(older));
    assert.equal(older.candidate, b);
    assert.equal(older.candidateSource, "requested");
    assert.deepEqual(older.newerGreen, [c]);
    assert.ok(!older.paths.includes("c.txt"), "the plan carries only what staging verified for the older commit");
    assert.match(older.next, new RegExp(`slipjay promote --confirm ${b.slice(0, 12)}`));
    assert.equal(older.verification?.status, "none");
    assert.equal(older.approval?.covered, false, "approval coverage is computed against the requested candidate");

    // Staging never deployed `red` green.
    const never = await plan(red);
    assert.ok(!never.ok && /no green deploy of/.test(never.reason), JSON.stringify(never));
    const short = await plan("abc");
    assert.ok(!short.ok && /at least 12 hex/.test(short.reason), JSON.stringify(short));
    const newestAsked = await plan(c);
    assert.ok(newestAsked.ok && newestAsked.status === "planned" && newestAsked.candidateSource === "requested" && newestAsked.newerGreen?.length === 0);

  } finally { await f.dispose(); }
});

test("a requested commit without a pre-verification asks for one, and one that has it asks for none", async () => {
  const f = await promotingProject();
  try {
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const b = await f.commit({ "b.txt": "b\n" }, "Add b");
    const requested: string[] = [];
    let queued = false;
    const read = async (): Promise<PromotionState> => ({ stagingGreen: b, stagingGreenCommits: [b, a], approved: [],
      verifications: queued ? [verificationOf(a, "queued")] : [] });
    const planned = await releaseIntegration(f.repo, { readPromotion: read, candidate: a,
      requestVerification: async (commit) => { requested.push(commit); queued = true; } });
    assert.ok(planned.ok && planned.status === "planned", JSON.stringify(planned));
    assert.deepEqual(requested, [a]);
    assert.equal(planned.verification?.status, "queued");

    await releaseIntegration(f.repo, { readPromotion: read, candidate: a, requestVerification: async (commit) => { requested.push(commit); } });
    assert.deepEqual(requested, [a], "an existing pre-verification is not requested again");

    await releaseIntegration(f.repo, { readPromotion: read, requestVerification: async (commit) => { requested.push(commit); } });
    assert.deepEqual(requested, [a], "the newest green commit's pre-verification is the runner's to queue");
  } finally { await f.dispose(); }
});

test("a commit older than the release tip or on another line is not a candidate, and a confirm checks staging was green", async () => {
  const f = await promotingProject();
  try {
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const b = await f.commit({ "b.txt": "b\n" }, "Add b");
    const read = (green: string[]) => async (): Promise<PromotionState> => ({ stagingGreen: green[0] ?? null, stagingGreenCommits: green, approved: [], verifications: [] });

    const confirmable = await confirmableCandidate(f.repo, a.slice(0, 12), false, read([b, a]));
    assert.ok(confirmable.ok && confirmable.status === "confirmable" && confirmable.candidate === a, JSON.stringify(confirmable));
    const never = await confirmableCandidate(f.repo, a.slice(0, 12), false, read([b]));
    assert.ok(!never.ok && /no green deploy of/.test(never.reason), JSON.stringify(never));
    const unchecked = await confirmableCandidate(f.repo, a.slice(0, 12), false);
    assert.ok(unchecked.ok && unchecked.status === "confirmable", "without the runner's state the runner is left to refuse");

    // The release branch moves to `a`: the commit before it is older than the tip, and `a` itself has nothing left to release.
    const before = execFileSync("git", ["rev-parse", `${a}~1`], { cwd: f.repo, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", "origin", `${a}:refs/heads/release`], { cwd: f.repo, stdio: "pipe" });
    const green = read([b, a, before]);
    const older = await releaseIntegration(f.repo, { readPromotion: green, candidate: before });
    assert.ok(!older.ok && /does not contain everything release@origin/.test(older.reason), JSON.stringify(older));
    const olderConfirm = await confirmableCandidate(f.repo, before, false, green);
    assert.ok(olderConfirm.ok, "a commit the release branch holds is a released_by confirm, not a refusal");
    const tip = await releaseIntegration(f.repo, { readPromotion: green, candidate: a });
    assert.ok(tip.ok && tip.status === "up_to_date" && tip.candidateSource === "requested", JSON.stringify(tip));
    const newer = await releaseIntegration(f.repo, { readPromotion: green, candidate: b });
    assert.ok(newer.ok && newer.status === "planned" && newer.commits === 1, JSON.stringify(newer));
  } finally { await f.dispose(); }
});

test("a staging-green commit on another line is refused by the plan, the client's confirm and the runner's release, which publishes nothing", async () => {
  const f = await promotingProject();
  try {
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
    // `side` branches from before `a` and is merged into main afterwards, so it is published but does not contain `a`.
    const fork = git(["rev-parse", `${a}~1`]);
    const side = git(["commit-tree", `${fork}^{tree}`, "-p", fork, "-m", "Side line"]);
    const merge = git(["commit-tree", `${a}^{tree}`, "-p", a, "-p", side, "-m", "Merge the side line"]);
    git(["push", "-q", "origin", `${merge}:refs/heads/main`]);
    git(["push", "-q", "origin", `${a}:refs/heads/release`]);
    const state = async (): Promise<PromotionState> => ({ stagingGreen: side, stagingGreenCommits: [side], approved: [], verifications: [] });

    const refusal = /does not contain everything release@origin/;
    const planned = await releaseIntegration(f.repo, { readPromotion: state, candidate: side });
    assert.ok(!planned.ok && refusal.test(planned.reason), JSON.stringify(planned));
    const confirmable = await confirmableCandidate(f.repo, side, false, state);
    assert.ok(!confirmable.ok && refusal.test(confirmable.reason), JSON.stringify(confirmable));
    const released = await confirmRelease(f.repo, { candidate: side });
    assert.ok(!released.ok && released.status === "refused" && refusal.test(released.reason), JSON.stringify(released));
    assert.equal(git(["rev-parse", "origin/release"]), a, "nothing was published");
  } finally { await f.dispose(); }
});

test("--candidate is refused when the repository does not ship by promotion, and an older runner lists only the newest green commit", async () => {
  const plain = await releaseProject();
  try {
    await landFile(plain, "a.txt");
    const refused = await releaseIntegration(plain.repo, { candidate: "a".repeat(12) });
    assert.ok(!refused.ok && /does not ship by promotion/.test(refused.reason), JSON.stringify(refused));
  } finally { await plain.dispose(); }

  const f = await promotingProject();
  try {
    const a = await f.commit({ "a.txt": "a\n" }, "Add a");
    const b = await f.commit({ "b.txt": "b\n" }, "Add b");
    const older: () => Promise<PromotionState> = async () => ({ stagingGreen: b, approved: [], verifications: [] });
    const asked = await releaseIntegration(f.repo, { readPromotion: older, candidate: a });
    assert.ok(!asked.ok && /too old to list older green commits/.test(asked.reason), JSON.stringify(asked));
    const newest = await releaseIntegration(f.repo, { readPromotion: older, candidate: b });
    assert.ok(newest.ok && newest.candidate === b);
    const confirm = await confirmableCandidate(f.repo, a, false, older);
    assert.ok(!confirm.ok && /too old to list older green commits/.test(confirm.reason), JSON.stringify(confirm));
  } finally { await f.dispose(); }
});
