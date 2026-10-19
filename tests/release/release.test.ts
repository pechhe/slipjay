import { jj } from "../support/workspace-project.ts";
import { landFile, releaseProject, remoteParents, remoteRef, remoteTree } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { confirmRelease, nonAdditiveSql, releaseIntegration, returnRelease, verifyRelease } from "../../src/lib/release/release.ts";
import type { PromotionState } from "../../src/lib/release/release.ts";
import type { OperationEvent, VerificationOperation } from "../../src/lib/runner/runner-contract.ts";

/** A promoting fixture that also declares production migrations, with a commit helper that writes straight to main. */
async function promotingProject() {
  const f = await releaseProject({ migrations: true, promotes: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(f.repo, file, ".."), { recursive: true });
      await writeFile(join(f.repo, file), content);
    }
    git(["add", "-A"]); git(["commit", "-qm", message]); git(["push", "-q", "origin", "main"]);
    jj(f.repo, ["git", "import"]);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
  };
  const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
  const step = { executable: "node", args: ["-e", ""] };
  policy.deployments.environments.production.migrations = { verify: step, apply: step };
  await commit({ "slipjay.json": JSON.stringify(policy) }, "Declare production migrations");
  const plan = (stagingGreen: string, approved: string[], verifications: VerificationOperation[] = []) =>
    releaseIntegration(f.repo, { readPromotion: async () => ({ stagingGreen, approved, verifications }) });
  return { ...f, commit, plan, checks: policy.requiredReleaseVerification as unknown[] };
}

const verificationOf = (commitId: string, status: VerificationOperation["status"], result?: OperationEvent): VerificationOperation =>
  ({ id: `op_${status}_${commitId.slice(0, 6)}`, kind: "verification", repo: "fixture/repo", commitId, submittedBy: "runner:staging", status,
    stage: status === "running" ? "verifying" : "queued", submittedAt: new Date().toISOString(), runs: [], lastSeq: 1,
    ...result ? { result: result as VerificationOperation["result"] } : {} });

test("release dependency preparation uses its runner executor and cannot bypass a refused install", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "package.json", JSON.stringify({ name: "fixture-release", private: true, packageManager: "bun@1.4.3" }));
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

test("a promotion plans the newest commit staging is green on, with its paths, and re-asks only the delta past an approval that did not ship", async () => {
  const f = await releaseProject({ promotes: true });
  try {
    const a = await landFile(f, "a.txt");
    const b = await landFile(f, "b.txt");
    const c = await landFile(f, "c.txt");
    const plan = (state: PromotionState) => releaseIntegration(f.repo, { readPromotion: async () => state });
    const offline = await releaseIntegration(f.repo);
    assert.ok(!offline.ok && /reads staging from the runner/.test(offline.reason), JSON.stringify(offline));
    const red = await plan({ stagingGreen: null, approved: [], verifications: [] });
    assert.ok(!red.ok && /green on no commit/.test(red.reason), JSON.stringify(red));

    const first = await plan({ stagingGreen: b, approved: [a], verifications: [] });
    assert.ok(first.ok && first.status === "planned", JSON.stringify(first));
    assert.equal(first.candidate, b, "the candidate is what staging verified, not the integration tip");
    assert.deepEqual(first.paths.filter((path) => path.endsWith(".txt")), ["a.txt", "b.txt"]);
    assert.equal(first.delta?.since, a);
    assert.match(first.next, new RegExp(`slipjay promote --confirm ${b.slice(0, 12)}`));

    // b was approved, its release failed and c landed: the next ask shows only c.
    const moved = await plan({ stagingGreen: c, approved: [b, a], verifications: [] });
    assert.ok(moved.ok && moved.status === "planned", JSON.stringify(moved));
    assert.equal(moved.candidate, c);
    assert.deepEqual(moved.delta, { since: b, commits: [{ commitId: c, subject: moved.subjects[0] }], paths: ["c.txt"], migrationArtifacts: [] });
    assert.equal(moved.subjects.length, 1);
    assert.ok(moved.commits > 1, "the summary still counts the whole release");

    const again = await plan({ stagingGreen: c, approved: [c, b], verifications: [] });
    assert.ok(again.ok && again.status === "planned" && !again.delta, "a re-ask of the same candidate shows the whole release");
  } finally {
    await f.dispose();
  }
});

test("an earlier approval covers a candidate whose changes since add no migration and name only work items the approved range names", async () => {
  const f = await promotingProject();
  try {
    const approved = await f.commit({ "feature.txt": "a\n" }, "Add the feature\n\nBuild: #5");
    await f.commit({ "format.txt": "b\n" }, "Fix formatting");
    const sameItem = await f.commit({ "feature.txt": "a2\n" }, "Finish the feature\n\nBuild: #5");
    const covered = await f.plan(sameItem, [approved]);
    assert.ok(covered.ok && covered.status === "planned", JSON.stringify(covered));
    assert.deepEqual(covered.approval, { approvedCandidate: approved, covered: true, reasons: [] });
    assert.match(covered.next, /covers this candidate/);

    const again = await f.plan(approved, [approved]);
    assert.ok(again.ok && again.status === "planned");
    assert.deepEqual(again.approval, { approvedCandidate: approved, covered: true, reasons: [] }, "a re-ask of exactly the approved candidate");

    const first = await f.plan(sameItem, []);
    assert.ok(first.ok && first.status === "planned");
    assert.deepEqual(first.approval, { approvedCandidate: null, covered: false, reasons: ["No earlier approval that has not shipped"] });
    assert.match(first.next, /^After explicit human approval/);

    const stranger = "0123456789abcdef0123456789abcdef01234567";
    const unrelated = await f.plan(sameItem, [stranger]);
    assert.ok(unrelated.ok && unrelated.status === "planned");
    assert.equal(unrelated.approval?.covered, false);
    assert.match(unrelated.approval!.reasons.join(), /does not descend from the approved 0123456789ab/);

    const newItem = await f.commit({ "other.txt": "c\n" }, "Start another feature\n\nIssue: pechhe/slipjay#9");
    const migration = await f.commit({ "migrations/0001.sql": "create table t (a int);\n" }, "Add a table");
    const uncovered = await f.plan(migration, [approved]);
    assert.ok(uncovered.ok && uncovered.status === "planned", JSON.stringify(uncovered));
    assert.equal(uncovered.approval?.covered, false);
    assert.deepEqual(uncovered.approval?.reasons, [
      `${migration.slice(0, 12)} (Add a table) adds or changes migration artifacts: migrations/0001.sql`,
      `${newItem.slice(0, 12)} (Start another feature) names Issue: pechhe/slipjay#9, which the approved range does not`,
    ]);
  } finally { await f.dispose(); }
});

test("a promotion plan reports its candidate's pre-verification, passed only against the plan's base and checks", async () => {
  const f = await promotingProject();
  try {
    const candidate = await f.commit({ "feature.txt": "a\n" }, "Add the feature");
    const older = await f.commit({ "next.txt": "b\n" }, "Next");
    const base = remoteRef(f, "release");
    const state = async (verifications: VerificationOperation[]) => {
      const plan = await f.plan(candidate, [], verifications);
      assert.ok(plan.ok && plan.status === "planned", JSON.stringify(plan));
      return plan.verification;
    };
    const passed = { type: "verified", base, candidate, checks: f.checks } as OperationEvent;
    assert.deepEqual(await state([]), { status: "none", commit: candidate, operationId: null });
    assert.deepEqual(await state([verificationOf(older, "verified", passed)]), { status: "none", commit: candidate, operationId: null }, "another commit's pass is not this one's");
    assert.equal((await state([verificationOf(candidate, "queued")]))?.status, "queued");
    assert.equal((await state([verificationOf(candidate, "running")]))?.status, "running");
    const pass = verificationOf(candidate, "verified", passed);
    assert.deepEqual(await state([pass]), { status: "passed", commit: candidate, operationId: pass.id });
    assert.equal((await state([verificationOf(candidate, "verified", { ...passed, base: older } as OperationEvent)]))?.status, "none", "a pass against another release base");
    assert.equal((await state([verificationOf(candidate, "verified", { ...passed, checks: [] } as OperationEvent)]))?.status, "none", "a pass with other checks");
    const failed = verificationOf(candidate, "failed", { type: "failed", stage: "verifying", reason: "exited 1", command: "bun run verify:release" });
    assert.deepEqual(await state([failed, pass]), { status: "failed", commit: candidate, operationId: failed.id, failedCommand: "bun run verify:release" }, "the newest counts");
    assert.equal((await state([verificationOf(candidate, "superseded"), pass]))?.status, "passed", "a superseded one is passed over");
  } finally { await f.dispose(); }
});

test("a pre-verification runs the release checks and publishes nothing; a confirm that reuses it publishes without running them", async () => {
  const f = await releaseProject();
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const verified = await verifyRelease(f.repo, { candidate });
    assert.ok(verified.ok, JSON.stringify(verified));
    assert.equal(verified.base, base);
    assert.equal(verified.candidate, candidate);
    assert.equal(remoteRef(f, "release"), base, "nothing published");
    assert.equal((await readFile(f.verifiedRelease, "utf8")).split("\n").filter(Boolean).length, 1);

    const result = await confirmRelease(f.repo, { candidate, preverified: (plan) => plan.base === base ? "op_pre" : null });
    assert.ok(result.ok && result.status === "released", JSON.stringify(result));
    assert.deepEqual(result.verification, { preverified: "op_pre" });
    assert.equal((await readFile(f.verifiedRelease, "utf8")).split("\n").filter(Boolean).length, 1, "the confirm ran no check");
    assert.deepEqual(remoteParents(f, remoteRef(f, "release")), [base, candidate]);

    const shipped = await verifyRelease(f.repo, { candidate });
    assert.ok(!shipped.ok && /already on release/.test(shipped.reason), JSON.stringify(shipped));
  } finally { await f.dispose(); }
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

test("a release carrying migration artifacts needs --migrations-ready and names the ones that are not additive", async () => {
  const f = await releaseProject({ migrations: true });
  try {
    // Landing generates migrations itself, so this fixture commits one straight to main.
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
    await mkdir(join(f.repo, "migrations"), { recursive: true });
    await writeFile(join(f.repo, "migrations", "0001.sql"), "create table t (a int); -- drop nothing\n");
    await writeFile(join(f.repo, "migrations", "0002.sql"), "alter table t alter column a set data type text;\n");
    await writeFile(join(f.repo, "migrations", "0003.sql"), "/* DROP TABLE t; */ alter table t add column b int;\n");
    git(["add", "migrations"]);
    git(["commit", "-qm", "Add a migration"]);
    git(["push", "-q", "origin", "main"]);
    jj(f.repo, ["git", "import"]);
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    const plan = await releaseIntegration(f.repo);
    assert.ok(plan.ok && plan.status === "planned");
    assert.deepEqual(plan.migrationArtifacts, ["migrations/0001.sql", "migrations/0002.sql", "migrations/0003.sql"]);
    assert.deepEqual(plan.nonAdditiveMigrations, ["migrations/0002.sql"], "commented-out SQL does not count");
    const refused = await confirmRelease(f.repo, { candidate });
    assert.ok(!refused.ok && /--migrations-ready/.test(refused.reason), JSON.stringify(refused));
    const released = await confirmRelease(f.repo, { candidate, migrationsReady: true });
    assert.equal(released.status, "released", JSON.stringify(released));
  } finally {
    await f.dispose();
  }
});

test("a promotion's migrations are the runner's to apply: it needs a declared production step and refuses --migrations-ready", async () => {
  const f = await releaseProject({ migrations: true, promotes: true });
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
    const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    const commit = (message: string) => { git(["add", "-A"]); git(["commit", "-qm", message]); git(["push", "-q", "origin", "main"]); jj(f.repo, ["git", "import"]); return head(); };
    await mkdir(join(f.repo, "migrations"), { recursive: true });
    await writeFile(join(f.repo, "migrations", "0001.sql"), "create table t (a int);\n");
    const undeclared = commit("Add a migration");
    const plan = (stagingGreen: string) => releaseIntegration(f.repo, { readPromotion: async () => ({ stagingGreen, approved: [], verifications: [] }) });
    const refused = await plan(undeclared);
    assert.ok(!refused.ok && /declares no deployments production migrations/.test(refused.reason), JSON.stringify(refused));
    assert.ok(!(await confirmRelease(f.repo, { candidate: undeclared })).ok, "the runner refuses it too");

    const policyPath = join(f.repo, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    const step = { executable: "node", args: ["-e", ""] };
    policy.deployments.environments.production.migrations = { verify: step, apply: step };
    await writeFile(policyPath, JSON.stringify(policy));
    const declared = commit("Declare production migrations");
    const planned = await plan(declared);
    assert.ok(planned.ok && planned.status === "planned", JSON.stringify(planned));
    assert.doesNotMatch(planned.next, /--migrations-ready/);
    assert.match(planned.next, /The runner applies its migrations \(migrations\/0001\.sql\) to production before it activates/);
    const marked = await confirmRelease(f.repo, { candidate: declared, migrationsReady: true });
    assert.ok(!marked.ok && /confirm without --migrations-ready/.test(marked.reason), JSON.stringify(marked));
    const released = await confirmRelease(f.repo, { candidate: declared });
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

test("a returned release moves the release branch back to before its merge, only while it still holds that merge", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "a.txt");
    const base = remoteRef(f, "release");
    const released = await confirmRelease(f.repo, { candidate });
    assert.ok(released.status === "released", JSON.stringify(released));
    assert.deepEqual(await returnRelease(f.repo, { merge: released.merge, candidate }), { returned: true, releaseBranch: base });
    assert.equal(remoteRef(f, "release"), base);
    const again = await returnRelease(f.repo, { merge: released.merge, candidate });
    assert.ok(!again.returned && /has moved on/.test(again.reason), JSON.stringify(again));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});

test("SQL is additive when earlier code cannot tell: new tables and columns, widened enums, loosened and generated columns", () => {
  for (const sql of [
    'CREATE TEMP TABLE "w" ON COMMIT DROP AS SELECT 1;\nDELETE FROM "w";\nUPDATE "w" SET "a" = 1;',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD COLUMN "b" boolean DEFAULT false NOT NULL;\nALTER TABLE "t" ADD CONSTRAINT "t_check" CHECK ("t"."a" is not null or not "t"."b");',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD CONSTRAINT "t_a_fk" FOREIGN KEY ("a") REFERENCES "u"("id");\nCREATE UNIQUE INDEX "t_a" ON "t" USING btree ("a");',
    'ALTER TABLE "t" ADD COLUMN "a" text;\nUPDATE "t" SET "a" = lower("b") WHERE "a" IS NULL;',
    'ALTER TABLE "t" DROP CONSTRAINT "t_kind_check";\nALTER TABLE "t" ADD CONSTRAINT "t_kind_check" CHECK ("t"."kind" in (\'a\', \'b\'));',
    'ALTER TABLE "t" ALTER COLUMN "a" DROP NOT NULL;',
    'ALTER TABLE "t" ADD COLUMN "d" tsvector GENERATED ALWAYS AS (to_tsvector(body)) STORED NOT NULL;',
    'ALTER TABLE "u" ADD COLUMN "x" text, ADD COLUMN "y" integer DEFAULT 0 NOT NULL;',
    'ALTER TABLE t ADD COLUMN a int;\nUPDATE t x SET a = (SELECT 1 FROM z WHERE z.id = x.id) WHERE true;',
    'ALTER TABLE s.t ADD COLUMN a int, ADD COLUMN b int, ADD UNIQUE (a, b);\nUPDATE s.t SET (a, b) = (1, 2);',
    'ALTER TABLE t ADD COLUMN "default" int NOT NULL DEFAULT 1;', "CREATE TABLE IF NOT EXISTS x (a int);",
    "select 1; -- DROP TABLE x\nCOMMENT ON TABLE t IS 'drop it; TRUNCATE t; -- not a comment';",
  ]) assert.equal(nonAdditiveSql(sql), false, sql);
  for (const sql of [
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nALTER TABLE "t" ADD CONSTRAINT "t_check" CHECK ("t"."a" is not null or "t"."b" > 0);',
    'ALTER TABLE "t" ADD COLUMN "a" uuid;\nCREATE UNIQUE INDEX "t_ab" ON "t" ("a", "b");',
    'ALTER TABLE "t" ADD COLUMN "a" text;\nUPDATE "t" SET "a" = 1, "b" = NULL;',
    'UPDATE "t" SET "a" = 1 WHERE "b" IS NULL;',
    'ALTER TABLE "t" DROP CONSTRAINT "t_kind_check";\nALTER TABLE "t" ADD CONSTRAINT "t_kind_check" CHECK ("t"."a" > 0);',
    'ALTER TABLE "t" ALTER COLUMN "a" DROP DEFAULT;', 'ALTER TABLE "t" DROP CONSTRAINT "t_pk";',
    'ALTER TABLE "t" ADD COLUMN "x" text, ADD COLUMN "y" integer NOT NULL;',
    // A widened CHECK is only that for the same table and constraint, as a plain IN list.
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE u ADD CONSTRAINT k CHECK (a IN ('x'));", "ALTER TABLE t ADD CONSTRAINT k CHECK (a IN ('x'));",
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE t ADD CONSTRAINT k CHECK (a NOT IN ('x'));",
    "ALTER TABLE t DROP CONSTRAINT k; ALTER TABLE t ADD CONSTRAINT k CHECK (a IN ('x') AND b > 1);",
    // Every UPDATE, assignment and clause counts, and tables are told apart by schema.
    "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = 1; UPDATE t SET d = 2;", "ALTER TABLE t ADD COLUMN c int; UPDATE t SET c = (SELECT a FROM z), d = 2;",
    "ALTER TABLE s.t ADD COLUMN c int; UPDATE t SET c = 1;", "ALTER TABLE t ADD COLUMN c int, ADD UNIQUE (a), ADD PRIMARY KEY (c);",
    "ALTER TABLE t ADD COLUMN c int; CREATE UNIQUE INDEX i ON t (c) WHERE a > 1;", "ALTER TABLE t ADD COLUMN c int; CREATE UNIQUE INDEX i ON t (c) INCLUDE (a);",
    "CREATE TABLE IF NOT EXISTS t (a int); ALTER TABLE t ADD COLUMN b int NOT NULL;",
    "ALTER TABLE t ADD UNIQUE (a);", "ALTER TABLE t ADD CHECK (a > 1);", "ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u(id);",
    "ALTER TABLE t ALTER a TYPE text;", "ALTER TABLE t ALTER a SET NOT NULL;", "ALTER TABLE t VALIDATE CONSTRAINT k;",
    "ALTER TABLE t ENABLE ROW LEVEL SECURITY;", "CREATE POLICY p ON t USING (true);", "CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
    "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;", "MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE;",
    "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2;", "DO $$ BEGIN ALTER TABLE t DROP COLUMN a; END $$;",
  ]) assert.equal(nonAdditiveSql(sql), true, sql);
});

test("SQL is non-additive when it removes, retypes or deletes, or tightens a table that already existed", () => {
  for (const sql of [
    'ALTER TABLE "t" DROP COLUMN "a";', "alter table t rename to u;", "DELETE FROM t WHERE a IS NULL;", "TRUNCATE t;",
    'ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE text;', 'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;',
    "ALTER TABLE t ADD CONSTRAINT positive CHECK (a > 0);", 'CREATE UNIQUE INDEX "t_a" ON "public"."t" USING btree ("a");',
    'ALTER TABLE "t" ADD COLUMN "b" integer NOT NULL;',
  ]) assert.equal(nonAdditiveSql(sql), true, sql);
  for (const sql of [
    'CREATE TABLE "u" ("id" text PRIMARY KEY NOT NULL, "t_id" text);\n--> statement-breakpoint\nALTER TABLE "u" ADD CONSTRAINT "u_t_fk" FOREIGN KEY ("t_id") REFERENCES "public"."t"("id");\nCREATE UNIQUE INDEX "u_t" ON "u" ("t_id");',
    'ALTER TABLE "t" ADD COLUMN "b" integer DEFAULT 0 NOT NULL;', 'ALTER TABLE "t" ADD COLUMN "c" text;', "CREATE INDEX t_a ON t (a);",
    "/* DROP TABLE t; */ select 1; -- truncate t",
  ]) assert.equal(nonAdditiveSql(sql), false, sql);
});
