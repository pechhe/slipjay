import { jj } from "../support/workspace-project.ts";
import { releaseProject } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { confirmRelease, releaseIntegration } from "../../src/lib/release/release.ts";

test("a release carrying migration artifacts needs --migrations-ready and names the ones that are not additive", async () => {
  const f = await releaseProject({ migrations: true });
  try {
    // Landing generates migrations itself, so this fixture commits one straight to main.
    const git = (args: string[]) => execFileSync("git", args, { cwd: f.repo, stdio: "pipe" });
    await mkdir(join(f.repo, "migrations"), { recursive: true });
    await writeFile(join(f.repo, "migrations", "0001.sql"), "create table t (a int); -- drop nothing\n");
    await writeFile(join(f.repo, "migrations", "0002.sql"), "alter table t alter column a set data type text;\n");
    await writeFile(join(f.repo, "migrations", "0003.sql"), "/* DROP TABLE t; */ alter table t add column b int;\n");
    await writeFile(join(f.repo, "migrations", "0004.ts"), "export const up = 'drop table t';\n");
    await mkdir(join(f.repo, "migrations", "meta"), { recursive: true });
    await writeFile(join(f.repo, "migrations", "meta", "_journal.json"), "{}\n");
    git(["add", "migrations"]);
    git(["commit", "-qm", "Add a migration"]);
    git(["push", "-q", "origin", "main"]);
    jj(f.repo, ["git", "import"]);
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    const plan = await releaseIntegration(f.repo);
    assert.ok(plan.ok && plan.status === "planned");
    assert.deepEqual(plan.migrationArtifacts, ["migrations/0001.sql", "migrations/0002.sql", "migrations/0003.sql", "migrations/0004.ts", "migrations/meta/_journal.json"]);
    // Commented-out SQL and JSON metadata do not count; a migration that is not SQL cannot be read, so it is not known to be additive.
    assert.deepEqual(plan.nonAdditiveMigrations, ["migrations/0002.sql", "migrations/0004.ts"]);
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
