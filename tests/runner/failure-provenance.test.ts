import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { failureProvenance } from "../../src/lib/runner/failure-provenance.ts";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { jj, project } from "../support/workspace-project.ts";

const migration = { mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
  generate: { executable: "node", args: [] }, verify: { executable: "node", args: [] } };

test("provenance reads exact candidate objects, includes deletes and both rename sides, and never executes repository code", async () => {
  const f = await project();
  try {
    await mkdir(join(f.repo, "schema"));
    await writeFile(join(f.repo, "schema/deleted.ts"), "old");
    jj(f.repo, ["describe", "-m", "base"]);
    const base = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["new"]);
    const { rm } = await import("node:fs/promises");
    await rm(join(f.repo, "schema/deleted.ts"));
    await writeFile(join(f.repo, "schema/new.ts"), "new");
    await mkdir(join(f.repo, "migrations"));
    await writeFile(join(f.repo, "migrations/001.sql"), "generated");
    await mkdir(join(f.repo, "fixtures"));
    await writeFile(join(f.repo, "fixtures/data.json"), "{}");
    for (const path of ["yarn.lock", "bun.lock", "pnpm-lock.yaml"]) await writeFile(join(f.repo, path), "lock");
    await writeFile(join(f.repo, "unrelated"), "ignored");
    const candidate = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const oid = (path: string) => execFileSync("git", ["rev-parse", `${candidate}:${path}`], { cwd: f.repo, encoding: "utf8" }).trim();
    const policy = parseExecutionPolicy(JSON.stringify({ version: 1, migrationFinalization: migration }));
    const runtime = { name: "bun" as const, version: "1.4.4", sha256: "a".repeat(64), path: "/runtime/bun" };
    const input = { checkout: f.repo, checked: { base, candidate }, policy,
      runtime: { status: "recorded" as const, executable: "bun", args: [], cwd: ".", environmentNames: [], redacted: false, configurationSha256: "b".repeat(64), runtime } };
    const frozen = await failureProvenance(input);
    assert.deepEqual(frozen.migrations, { paths: ["migrations/001.sql", "schema/deleted.ts", "schema/new.ts"] });
    assert.deepEqual(frozen.toolchain.runtime, { name: runtime.name, version: runtime.version, sha256: runtime.sha256 });
    assert.deepEqual(frozen.toolchain.lockfiles, ["bun.lock", "pnpm-lock.yaml", "yarn.lock"].map(path => ({ path, blob: oid(path) })));
    assert.deepEqual(frozen.fixture, { unavailable: "the repository declares no provenance.fixturePaths" });
    policy.provenance = { fixturePaths: ["fixtures/data.json", "fixtures"] };
    assert.deepEqual((await failureProvenance(input)).fixture, { paths: ["fixtures", "fixtures/data.json"].map(path => ({ path, tree: oid(path) })) });
    const { openOperationLog } = await import("../../src/lib/runner/runner-log.ts");
    const { owedReceipts } = await import("../../src/lib/build/build-receipts.ts");
    const log = openOperationLog(":memory:");
    try {
      const id = "frozen-operation";
      log.append(id, { type: "submitted", repo: "owner/repo", commitId: candidate, changeId: "k".repeat(32), bookmark: "candidate", submittedBy: "test",
        admission: { binding: { specId: "spec", ticketIds: [], bodyRevision: 3, bindGeneration: 1, sessionId: "session" },
          specBodyHash: "a".repeat(64), helperRevisions: [], repairsOperationId: null, supersedes: null } });
      log.append(id, { type: "build_admitted", sequence: 1, sessionId: "session", recordedAt: null });
      log.append(id, { type: "verification_base", base, candidate });
      log.append(id, { type: "provenance", value: frozen });
      log.append(id, { type: "failed", stage: "verifying", reason: "failed" });
      const receipt = () => JSON.stringify(owedReceipts(log.operation(id) as import("../../src/lib/runner/runner-types.ts").LandingOperation,
        log.events({ operationId: id }), log.integrationSettlements()));
      const bytes = receipt();
      jj(f.repo, ["new", base]);
      await writeFile(join(f.repo, "slipjay.json"), JSON.stringify({ version: 1, provenance: { fixturePaths: ["different"] } }));
      jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
      assert.equal(receipt(), bytes, "moving the integration branch to a new provenance policy cannot change frozen receipts");
    } finally { log.close(); }
    jj(f.repo, ["new", base]);
    await writeFile(join(f.repo, "bun.lock"), "changed integration input");
    assert.deepEqual((await failureProvenance({ ...input, policy: { ...policy, provenance: undefined } })), frozen);
  } finally { await f.dispose(); }
});

test("migration provenance bounds sorted paths and names missing candidate, runtime and fixture objects", async () => {
  const f = await project();
  try {
    const base = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["new"]);
    await mkdir(join(f.repo, "schema"));
    for (let n = 0; n < 105; n++) await writeFile(join(f.repo, `schema/${String(n).padStart(3, "0")}.ts`), "schema");
    const candidate = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const policy = parseExecutionPolicy(JSON.stringify({ version: 1, migrationFinalization: migration, provenance: { fixturePaths: ["absent"] } }));
    const result = await failureProvenance({ checkout: f.repo, checked: { base, candidate }, policy });
    assert.ok("paths" in result.migrations);
    assert.equal(result.migrations.paths.length, 100);
    assert.equal(result.migrations.truncated, true);
    assert.equal(result.migrations.paths[0], "schema/000.ts");
    assert.deepEqual(result.toolchain.runtime, { unavailable: "the failure has no recorded run" });
    assert.ok("unavailable" in result.fixture);
    const missing = await failureProvenance({ checkout: f.repo });
    assert.ok("unavailable" in missing.migrations);
    assert.deepEqual(missing.toolchain.lockfiles, []);
  } finally { await f.dispose(); }
});
