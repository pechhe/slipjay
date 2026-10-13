import { jj } from "./support/workspace-project.ts";
import {
  gatedReleaseCheck, landFile, openReleaseGate, releaseProject, remoteParents, remoteRef, remoteTree, until, verifiedCandidates,
} from "./support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { releaseIntegration } from "../src/lib/release.ts";

test("a release plans, then verifies the exact candidate and publishes a merge with its tree", async () => {
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
    assert.deepEqual(plan.halfBuiltSpecs, { checked: false, reason: "the repository has no GitHub remote" },
      "a repository without GitHub still plans, saying the Spec check could not run");
    assert.equal(remoteRef(f, "release"), base, "planning publishes nothing");

    const children = () => jj(f.repo, ["log", "--no-graph", "-r", `children(${candidate})`, "-T", 'commit_id ++ "\\n"']).split("\n").sort();
    const childrenBefore = children();
    const released = await releaseIntegration(f.repo, { confirm: candidate.slice(0, 12) });
    assert.equal(released.status, "released", JSON.stringify(released));
    assert.ok(released.ok && released.status === "released");
    assert.equal(released.halfBuiltSpecs?.checked, false, "confirm re-runs the Spec check");
    assert.equal(remoteRef(f, "release"), released.merge);
    assert.deepEqual(remoteParents(f, released.merge), [base, candidate]);
    assert.equal(remoteTree(f, released.merge), remoteTree(f, candidate));
    // The check ran once, in a checkout of its own that is gone afterwards.
    const verified = (await readFile(f.verifiedRelease, "utf8")).trim().split("\n");
    assert.equal(verified.length, 1);
    assert.match(verified[0]!, /releases\/checkouts\//);
    assert.ok(!jj(f.repo, ["workspace", "list"]).includes("slipjay-release-"));
    // The release adds only the merge on the candidate: not even its checkout's empty working copy.
    assert.deepEqual(children(), [...childrenBefore, released.merge].sort());

    assert.equal((await releaseIntegration(f.repo)).status, "up_to_date");
  } finally {
    await f.dispose();
  }
});

test("a failed release check publishes nothing", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["-e", "process.exit(3)"] }] });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await releaseIntegration(f.repo, { confirm: candidate });
    assert.equal(result.status, "verification_failed", JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});

test("a landing does not wait for a release verification", async () => {
  const f = await releaseProject({ checks: gatedReleaseCheck });
  try {
    const candidate = await landFile(f, "feature.txt");
    let releaseSettled = false;
    const release = releaseIntegration(f.repo, { confirm: candidate }).finally(() => { releaseSettled = true; });
    await until(async () => (await verifiedCandidates(f)).length === 1, "the release check to start");
    // The release's check is now running and blocked; a landing must still go through.
    await landFile(f, "during-release.txt");
    assert.equal(releaseSettled, false, "the landing waited for the release verification");
    await openReleaseGate(f);
    assert.equal((await release).status, "released");
  } finally {
    await openReleaseGate(f).catch(() => {});
    await f.dispose();
  }
});

test("a candidate that is not published on the integration branch is refused", async () => {
  const f = await releaseProject();
  try {
    await landFile(f, "feature.txt");
    jj(f.repo, ["new", "main", "-m", "unpublished"]);
    const unpublished = jj(f.repo, ["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    const result = await releaseIntegration(f.repo, { confirm: unpublished });
    assert.equal(result.status, "refused");
    assert.ok(!result.ok && /is not published/.test(result.reason));
  } finally {
    await f.dispose();
  }
});

test("a release carrying migration artifacts needs --migrations-ready", async () => {
  const f = await releaseProject({ migrations: true });
  try {
    // Landing generates migrations itself, so this fixture commits one straight to main.
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
    await mkdir(join(f.repo, "migrations"), { recursive: true });
    await writeFile(join(f.repo, "migrations", "0001.sql"), "create table t ();\n");
    git(["add", "migrations"]);
    git(["commit", "-qm", "Add a migration"]);
    git(["push", "-q", "origin", "main"]);
    jj(f.repo, ["git", "import"]);
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    const plan = await releaseIntegration(f.repo);
    assert.ok(plan.ok && plan.status === "planned");
    assert.deepEqual(plan.migrationArtifacts, ["migrations/0001.sql"]);
    const refused = await releaseIntegration(f.repo, { confirm: candidate });
    assert.ok(!refused.ok && /--migrations-ready/.test(refused.reason), JSON.stringify(refused));
    const released = await releaseIntegration(f.repo, { confirm: candidate, migrationsReady: true });
    assert.equal(released.status, "released", JSON.stringify(released));
  } finally {
    await f.dispose();
  }
});

test("a release branch with changes the integration branch lacks is refused", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "feature.txt");
    // A hotfix straight on the release branch that never reached main.
    const scratch = join(f.root, "hotfix");
    execFileSync("git", ["clone", "-q", "-b", "release", f.remote, scratch]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: scratch, stdio: "pipe" });
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.com"]);
    await writeFile(join(scratch, "hotfix.txt"), "hotfix\n");
    git(["add", "."]);
    git(["commit", "-qm", "Hotfix"]);
    git(["push", "-q", "origin", "release"]);
    const hotfix = remoteRef(f, "release");
    const result = await releaseIntegration(f.repo, { confirm: candidate });
    assert.ok(!result.ok && /not the verified tree/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), hotfix);
  } finally {
    await f.dispose();
  }
});
