import { jj } from "./support/workspace-project.ts";
import { landFile, releaseProject, remoteParents, remoteRef, remoteTree } from "./support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { confirmRelease, releaseIntegration } from "../src/lib/release.ts";

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
    assert.deepEqual(plan.halfBuiltSpecs, { checked: false, reason: "the repository has no GitHub remote" },
      "a repository without GitHub still plans, saying the Spec check could not run");
    assert.equal(remoteRef(f, "release"), base, "planning publishes nothing");

    const released = await confirmRelease(f.repo, { candidate: candidate.slice(0, 12) });
    assert.equal(released.status, "released", JSON.stringify(released));
    assert.ok(released.ok && released.status === "released");
    assert.equal(released.halfBuiltSpecs?.checked, false, "confirm re-runs the Spec check");
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

test("a failed release check publishes nothing", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["-e", "process.exit(3)"] }] });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await confirmRelease(f.repo, { candidate });
    assert.equal(result.status, "verification_failed", JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});

test("a release check that edits tracked source publishes nothing and restores the candidate", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync('feature.txt', 'edited by a check\\n')"] }] });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await confirmRelease(f.repo, { candidate });
    assert.equal(result.status, "refused", JSON.stringify(result));
    assert.ok(!result.ok && /release verification changed the candidate's source[\s\S]*feature\.txt/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
    assert.equal(jj(f.repo, ["diff", "--from", candidate, "--to", "@", "--summary"]), "");
  } finally {
    await f.dispose();
  }
});

test("a candidate that is not published on the integration branch is refused", async () => {
  const f = await releaseProject();
  try {
    await landFile(f, "feature.txt");
    jj(f.repo, ["new", "main", "-m", "unpublished"]);
    const unpublished = jj(f.repo, ["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    const result = await confirmRelease(f.repo, { candidate: unpublished });
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
    const refused = await confirmRelease(f.repo, { candidate });
    assert.ok(!refused.ok && /--migrations-ready/.test(refused.reason), JSON.stringify(refused));
    const released = await confirmRelease(f.repo, { candidate, migrationsReady: true });
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
    const result = await confirmRelease(f.repo, { candidate });
    assert.ok(!result.ok && /not the verified tree/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), hotfix);
  } finally {
    await f.dispose();
  }
});
