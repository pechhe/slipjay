import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { promotingProject } from "./fixtures/release-fixture.ts";
import { remoteRef } from "../support/release-project.ts";
import { jj } from "../support/workspace-project.ts";
import { confirmRelease, planRelease, releaseIntegration } from "../../src/lib/release/release.ts";
import { buildReleaseCommits, declaredSpecGates } from "../../src/lib/release/release-build.ts";
import type { BuildReleasePlan } from "../../src/lib/release/release-build.ts";
import { BuildRefusal } from "../../src/lib/build/tracker.ts";
import type { BuildReader } from "../../src/lib/build/tracker.ts";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { buildReader, buildRoute } from "../../src/lib/build/build-admission.ts";

async function buildProject(gates?: string) {
  const f = await promotingProject();
  // Fetches stay local; the normal tracker locator reader can also see this remote.
  jj(f.repo, ["git", "remote", "add", "github", "https://github.com/fixture/repo.git"]);
  const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
  const candidate = await f.commit({ "slipjay.json": JSON.stringify({ ...policy, tracker: "build",
    ...(gates === undefined ? {} : { specGateDeclarations: "gates.ts" }) }),
    ...(gates === undefined ? {} : { "gates.ts": gates }) }, "Deliver the Spec\n\nBuild: #2973");
  const calls: Record<string, unknown>[] = [];
  const reader = (state: BuildReleasePlan["specs"][number]["state"] | "unclassified" = "accepted"): BuildReader => async (action, input) => {
    assert.equal(action, "release_plan");
    calls.push(input);
    const commits = input.commits as { commitId: string }[];
    return { repository: input.repository, releasable: state !== "held" && state !== "unclassified",
      commits: commits.map(({ commitId }) => ({ commitId, kind: state === "unclassified" ? "unclassified" : "spec", specId: "spec", number: 2973 })),
      specs: state === "unclassified" ? [] : [{ specId: "spec", number: 2973, title: "Accept on staging", status: "landed", level: "owner",
        state, heldReason: state === "held" ? "not_accepted" : null, commitIds: commits.map((commit) => commit.commitId) }] };
  };
  const plan = (readBuild = reader()) => releaseIntegration(f.repo, { readBuild,
    readPromotion: async () => ({ stagingGreen: candidate, approved: [candidate], verifications: [] }) });
  return { ...f, candidate, reader, calls, plan };
}

test("gate declarations collect literal calls, ignoring comments and quoted examples", () => {
  assert.deepEqual(declaredSpecGates(`// defineSpecGate(9)\n/* defineSpecGate(8) */
    const example = 'defineSpecGate(7)'; const a = defineSpecGate(2973); const b = defineSpecGate(42);
    const regex = /defineSpecGate(6)/; const again = defineSpecGate(42);`), [42, 2973]);
  assert.throws(() => declaredSpecGates("defineSpecGate(specNumber)"), /positive integer literal/);
  for (const path of ["/tmp/gates.ts", "../gates.ts", "a/../gates.ts", "", 42])
    assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, specGateDeclarations: path })), /repository-relative/);
});

test("the runner Build reader forwards release_plan and preserves typed refusals", async () => {
  const input = { repository: "fixture/repo", commits: [], declaredGates: [] };
  const value = { repository: input.repository, commits: [], specs: [], releasable: true };
  const read = buildReader(buildRoute({ origin: "https://build.example", token: "fixture", fetch: async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body as string), { action: "release_plan", input });
    return Response.json({ status: "succeeded", value });
  } }));
  assert.deepEqual(await read("release_plan", input), value);
  for (const [status, code] of [[409, "release_plan_invalid"], [503, "release_plan_spec_unavailable"]] as const) {
    const refused = buildReader(buildRoute({ origin: "https://build.example", token: "fixture", fetch: async () =>
      Response.json({ status: status === 503 ? "unavailable" : "refused", code }, { status }) }));
    await assert.rejects(refused("release_plan", input), (error: unknown) => error instanceof BuildRefusal && error.code === code);
  }
});

test("Build planning reads gates at the candidate and absent declarations send an empty list", async () => {
  for (const gates of [undefined, "export const accepted = defineSpecGate(2973);"]) {
    const f = await buildProject(gates);
    try {
      if (gates) await writeFile(join(f.repo, "gates.ts"), "defineSpecGate(9999);");
      const result = await f.plan(f.reader(gates ? "gated" : "accepted"));
      assert.ok(result.ok && result.status === "planned", JSON.stringify(result));
      assert.equal(result.releasable, true);
      assert.equal(result.specs?.[0]?.label, gates ? "Hidden in production" : "Accepted");
      assert.equal(result.approval?.covered, true);
      assert.deepEqual(f.calls[0]?.declaredGates, gates ? [2973] : []);
      assert.equal(f.calls[0]?.repository, "fixture/repo");
    } finally { await f.dispose(); }
  }
});

test("the release range includes side ancestors and resolves revert trailers, excluding only SlipJay release merges", async () => {
  const f = await buildProject();
  try {
    const base = remoteRef(f, "release");
    const reverted = await f.commit({ "change.txt": "change\n" }, "Change");
    const revert = await f.commit({ "change.txt": "undone\n" }, `Revert change\n\nThis reverts commit ${reverted.slice(0, 12)}.`);
    const unresolved = await f.commit({ "other.txt": "other\n" }, "Revert missing\n\nThis reverts commit deadbeef.");
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const side = git(["commit-tree", tree, "-p", base, "-m", "Side ancestor"]);
    const ordinaryMerge = git(["commit-tree", tree, "-p", unresolved, "-p", side, "-m", "Integrate side branch"]);
    const releaseMerge = git(["commit-tree", tree, "-p", base, "-p", ordinaryMerge, "-m", `Release main to release\n\nRelease-Candidate: ${ordinaryMerge}\n`]);
    // Release-shaped messages alone exempt nothing: one names a parent it does not merge, one adds content.
    const misnamed = git(["commit-tree", tree, "-p", releaseMerge, "-p", side, "-m", `Release main to release\n\nRelease-Candidate: ${ordinaryMerge}\n`]);
    git(["update-ref", "refs/heads/merged", misnamed]);
    jj(f.repo, ["git", "import"]);
    const index = { ...process.env, GIT_INDEX_FILE: join(f.repo, ".git", "smuggled-index") };
    const indexed = (args: string[], input?: string) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8", env: index, input }).trim();
    indexed(["read-tree", tree]);
    indexed(["update-index", "--add", "--cacheinfo", `100644,${indexed(["hash-object", "-w", "--stdin"], "unreviewed\n")},smuggled.txt`]);
    const smuggledTree = indexed(["write-tree"]);
    const smuggled = git(["commit-tree", smuggledTree, "-p", misnamed, "-p", side, "-m", `Release main to release\n\nRelease-Candidate: ${side}\n`]);
    git(["update-ref", "refs/heads/merged", smuggled]);
    jj(f.repo, ["git", "import"]);
    const disguised = await buildReleaseCommits(f.repo, smuggled, base);
    assert.ok(disguised.some((commit) => commit.commitId === misnamed));
    assert.ok(disguised.some((commit) => commit.commitId === smuggled));
    assert.ok(!disguised.some((commit) => commit.commitId === releaseMerge));
    const commits = await buildReleaseCommits(f.repo, releaseMerge, base);
    assert.ok(commits.some((commit) => commit.commitId === side));
    assert.ok(commits.some((commit) => commit.commitId === ordinaryMerge));
    assert.ok(!commits.some((commit) => commit.commitId === base || commit.commitId === releaseMerge));
    assert.equal(commits.find((commit) => commit.commitId === revert)?.revertsCommitId, reverted);
    assert.equal(commits.find((commit) => commit.commitId === unresolved)?.revertsCommitId, null);
    const bulk = Array.from({ length: 2001 }, (_, index) => {
      const message = `Bulk ${index}`;
      return `commit refs/heads/large\nmark :${index + 1}\ncommitter Fixture <fixture@example.com> 1700000000 +0000\ndata ${message.length}\n${message}\nfrom ${index ? `:${index}` : base}\n\n`;
    }).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: f.repo, input: bulk, stdio: ["pipe", "pipe", "pipe"] });
    jj(f.repo, ["git", "import"]);
    await assert.rejects(buildReleaseCommits(f.repo, git(["rev-parse", "large"]), base), /2001 commits.*limit is 2000/);
  } finally { await f.dispose(); }
});

test("confirmation refuses held Specs, unclassified commits, Build outages and refusals despite an approval", async () => {
  const f = await buildProject();
  try {
    const base = remoteRef(f, "release");
    for (const state of ["held", "unclassified"] as const) {
      const plan = await f.plan(f.reader(state));
      assert.ok(plan.ok && plan.status === "planned");
      assert.equal(plan.releasable, false);
      assert.equal(plan.approval?.covered, true);
      if (state === "held") assert.equal(plan.specs?.[0]?.label, "Held back");
      else assert.ok(plan.unclassifiedCommits!.includes(f.candidate));
      const result = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: f.reader(state) });
      assert.ok(!result.ok && result.status === "refused", JSON.stringify(result));
      assert.match(result.reason, state === "held" ? /not_accepted/ : /unclassified commit/);
      assert.equal(remoteRef(f, "release"), base);
    }
    for (const readBuild of [undefined, async () => { throw new Error("Build offline"); },
      async () => { throw new BuildRefusal("release_plan", "release_plan_spec_unavailable"); }]) {
      const result = await confirmRelease(f.repo, { candidate: f.candidate, readBuild });
      assert.ok(!result.ok && result.status === "refused", JSON.stringify(result));
      assert.match(result.reason, /Build/);
      assert.equal(remoteRef(f, "release"), base);
    }
    const missing = await f.plan(async () => null);
    assert.ok(!missing.ok && missing.status === "refused" && missing.releasable === false);
    for (const readBuild of [async () => ({ repository: "fixture/repo", releasable: true, commits: [], specs: [] }),
      async (action: Parameters<BuildReader>[0], input: Record<string, unknown>) => ({ ...await f.reader()(action, input) as BuildReleasePlan, specs: [] }),
      // A Spec Build calls gated or accepted while naming a held reason is a contradiction, not a release.
      ...(["gate_partial", undefined] as const).map((heldReason) => async (action: Parameters<BuildReader>[0], input: Record<string, unknown>) => {
        const answer = await f.reader("gated")(action, input) as BuildReleasePlan;
        return { ...answer, specs: answer.specs.map((spec) => ({ ...spec, heldReason })) };
      }),
      async (action: Parameters<BuildReader>[0], input: Record<string, unknown>) => {
        const answer = await f.reader("held")(action, input) as BuildReleasePlan;
        return { ...answer, releasable: true, specs: answer.specs.map((spec) => ({ ...spec, heldReason: null })) };
      }]) {
      const result = await confirmRelease(f.repo, { candidate: f.candidate, readBuild });
      assert.ok(!result.ok && result.status === "refused", JSON.stringify(result));
      assert.equal(remoteRef(f, "release"), base);
    }
    await assert.rejects(readFile(f.verifiedRelease), /ENOENT/);
  } finally { await f.dispose(); }
});

test("a releasable plan proceeds, but acceptance changing during verification refuses publication", async () => {
  const f = await buildProject();
  try {
    const base = remoteRef(f, "release");
    let reads = 0;
    const changes: BuildReader = (action, input) => f.reader(++reads === 1 ? "accepted" : "held")(action, input);
    const refused = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: changes });
    assert.ok(!refused.ok && refused.status === "refused", JSON.stringify(refused));
    assert.equal(reads, 2);
    assert.equal(remoteRef(f, "release"), base);
    const result = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: f.reader() });
    assert.equal(result.status, "released", JSON.stringify(result));
    assert.notEqual(remoteRef(f, "release"), base);
    assert.equal((await planRelease(f.repo)).commits.length, 0);
    const retry = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: async () => { throw new Error("Build offline"); } });
    assert.ok(!retry.ok && retry.status === "refused", "even an already published candidate needs Build before production can be retried");
    // A retry judges what the release merge published, so a Spec held since publication stops production.
    f.calls.length = 0;
    const held = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: f.reader("held") });
    assert.ok(!held.ok && held.status === "refused", JSON.stringify(held));
    assert.match(held.reason, /not_accepted/);
    assert.ok((f.calls[0]?.commits as { commitId: string }[]).some((commit) => commit.commitId === f.candidate));
    const again = await confirmRelease(f.repo, { candidate: f.candidate, readBuild: f.reader() });
    assert.equal(again.status, "released_by", JSON.stringify(again));
  } finally { await f.dispose(); }
});
