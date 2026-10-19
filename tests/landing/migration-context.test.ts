import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { migrationCandidate } from "../../src/lib/landing/migration-candidate.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { revisionFacts } from "../../src/lib/infra/workspace-jj.ts";
import type { MigrationFinalizationPolicy } from "../../src/lib/policy/execution-policy.ts";
import type { LandingRevision } from "../../src/lib/landing/landing-steps.ts";
import type { BoundedProcessRequest } from "../../src/lib/infra/bounded-process.ts";
import { jj, project } from "../support/workspace-project.ts";

const policy: MigrationFinalizationPolicy = {
  mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
  generate: { executable: "node", args: ["generate.mjs"], cwd: null },
  verify: { executable: "node", args: ["verify.mjs"], cwd: null },
};
const candidate: LandingRevision = {
  commitId: "rebased-source", changeId: "source-change", empty: false, conflict: false,
  description: "Change schema (#45)",
};
const base: LandingRevision = { ...candidate, commitId: "integration-base", changeId: "base-change" };

async function write(root: string, path: string, value: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
const advance = (cwd: string, description: string) => {
  jj(cwd, ["commit", "-m", description]);
  jj(cwd, ["bookmark", "set", "main", "-r", "@-"]);
  jj(cwd, ["git", "push", "--bookmark", "main"]);
};

async function fixture(verifyFails: boolean) {
  const f = await project({ policy: { migrationFinalization: policy } });
  const observations = join(f.root, "migration-context.jsonl");
  const capture = (step: string) => `
    import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
      step: ${JSON.stringify(step)}, raw: process.env.SLIPJAY_MIGRATION_CONTEXT,
      stepEnvironment: process.env.STEP_ENVIRONMENT,
      currentCommit: execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], { encoding: "utf8" }).trim()
    }) + "\\n");
  `;
  await write(f.repo, "schema/source", "old");
  await write(f.repo, "generate.mjs", capture("generate") + `
    mkdirSync("migrations", { recursive: true });
    writeFileSync("migrations/0001.sql", "generated");
  `);
  await write(f.repo, "verify.mjs", capture("verify") + (verifyFails ? "process.exit(6);" : ""));
  advance(f.repo, "Configure migration fixture");
  const workspace = (await createWorkspace("migration context fixture", f.repo)).workspacePath;
  await write(workspace, "schema/source", "new");
  jj(workspace, ["describe", "-m", "Change schema\n\nIssue: owner/app#45"]);
  const original = await revisionFacts(workspace, "@");
  jj(workspace, ["new"]);
  await write(f.repo, "later-integration", "added after workspace allocation");
  advance(f.repo, "Advance integration before final rebase");
  jj(workspace, ["rebase", "--branch", original.changeId, "--onto", "main"]);
  // No fetch follows these metadata-only remotes; commands remain entirely local.
  jj(workspace, ["git", "remote", "add", "publication", "https://fixture-user:fixture-password@github.com/owner/app.git"]);
  jj(workspace, ["git", "remote", "add", "upstream", "git@github.com:unrelated/repository.git"]);
  return { ...f, workspace, original, observations };
}

for (const verifyFails of [false, true]) test(`real migration commands bind rebased source provenance${verifyFails ? " through verifier refusal and rollback" : ""}`, async () => {
  const f = await fixture(verifyFails);
  try {
    const semantic = await revisionFacts(f.workspace, f.original.changeId);
    const integration = await revisionFacts(f.workspace, "main");
    assert.notEqual(semantic.commitId, f.original.commitId, "the source was rebased onto the advanced integration");
    assert.equal(jj(f.workspace, ["log", "-r", `parents(${semantic.changeId})`, "--no-graph", "-T", "commit_id"]), integration.commitId);
    const originalEnvironments: NodeJS.ProcessEnv[] = [];
    const migration = await migrationCandidate(f.workspace, {
      current: { root: f.workspace }, integrationBranch: "main",
      configuration: { remote: "publication", migrationFinalization: policy },
    }, { jj: async (cwd, args) => jj(cwd, args), revisionFacts }, {
      environment: () => {
        const environment = Object.freeze({ ...process.env,
          SLIPJAY_MIGRATION_CONTEXT: "spoofed provenance", STEP_ENVIRONMENT: String(originalEnvironments.length + 1),
          API_TOKEN: "fixture-unrelated-credential",
        });
        originalEnvironments.push(environment);
        return environment;
      },
    });
    try {
      if (verifyFails) await assert.rejects(migration.finalize(semantic, integration), /"exitCode":6/);
      else {
        const finalized = await migration.finalize(semantic, integration);
        assert.notEqual(finalized.commitId, semantic.commitId, "generated artifacts have a different revision");
        assert.equal(await readFile(join(f.workspace, "migrations/0001.sql"), "utf8"), "generated");
      }
      const observed = (await readFile(f.observations, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
        step: string; raw: string; stepEnvironment: string; currentCommit: string;
      });
      assert.deepEqual(observed.map(({ step }) => step), ["generate", "verify"]);
      assert.equal(observed[0]!.raw, observed[1]!.raw, "both subprocesses receive exactly the same serialized provenance");
      assert.deepEqual(JSON.parse(observed[0]!.raw), {
        version: 1, repository: "owner/app", baseCommit: integration.commitId,
        candidateCommit: semantic.commitId, candidateChangeId: semantic.changeId, issueNumber: 45,
      });
      assert.equal(observed[0]!.currentCommit, semantic.commitId);
      assert.notEqual(observed[1]!.currentCommit, semantic.commitId, "the verifier runs after the artifact revision exists");
      assert.deepEqual(observed.map(({ stepEnvironment }) => stepEnvironment), ["1", "2"]);
      assert.equal(originalEnvironments.length, 2, "ordinary environment values are obtained afresh for each command");
      for (const environment of originalEnvironments) {
        assert.equal(environment.SLIPJAY_MIGRATION_CONTEXT, "spoofed provenance");
        assert.equal(environment.API_TOKEN, "fixture-unrelated-credential");
      }
      assert.doesNotMatch(observed[0]!.raw, /https:|github\.com|fixture-password|fixture-unrelated-credential|STEP_ENVIRONMENT|spoofed/);
    } finally { await migration.rollback(); }
    assert.equal(existsSync(join(f.workspace, "migrations/0001.sql")), false, "rollback removes generated artifacts");
    assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new", "rollback preserves semantic source");
    assert.equal(jj(f.workspace, ["diff", "--from", semantic.commitId, "--to", semantic.changeId, "--summary"]), "");
    assert.equal((await revisionFacts(f.workspace, "main")).commitId, integration.commitId);
    assert.equal((await revisionFacts(f.workspace, "@")).empty, true, "rollback restores the empty continuation checkout");
  } finally { await f.dispose(); }
}, 60000);

const attributionCases = [
  { name: "default origin", remote: undefined, remotes: "origin git@github.com:owner/app.git", description: "Change\n\nIssue: owner/app#12", repository: "owner/app", issue: 12 },
  { name: "configured publication remote", remote: "publish", remotes: "origin https://github.com/unrelated/repository.git\npublish https://user:fake-password@github.com/owner/app.git", description: "Change (#14)\n\nIssue: unrelated/repository#99", repository: "owner/app", issue: 14 },
  { name: "closing reference", remote: null, remotes: "origin https://github.com/owner/app.git", description: "Change\n\nCloses #15", repository: "owner/app", issue: 15 },
  { name: "absent Issue", remote: undefined, remotes: "origin https://github.com/owner/app.git", description: "Change", repository: "owner/app", issue: null },
  { name: "unrelated Issue", remote: undefined, remotes: "origin https://github.com/owner/app.git", description: "Change\n\nIssue: unrelated/repository#99", repository: "owner/app", issue: null },
  { name: "invalid Issue", remote: undefined, remotes: "origin https://github.com/owner/app.git", description: "Change (#0)", repository: "owner/app", issue: null },
  { name: "local publication remote", remote: "publish", remotes: "origin https://github.com/unrelated/repository.git\npublish /local/project.git", description: "Change (#45)", repository: null, issue: null },
  { name: "missing publication remote", remote: "publish", remotes: "origin https://github.com/unrelated/repository.git", description: "Change (#45)", repository: null, issue: null },
  { name: "local origin with unrelated GitHub remote", remote: undefined, remotes: "origin /local/project.git\nupstream https://github.com/unrelated/repository.git", description: "Change (#45)", repository: null, issue: null },
  { name: "missing origin", remote: undefined, remotes: "upstream https://github.com/unrelated/repository.git", description: "Change (#45)", repository: null, issue: null },
  { name: "hostname suffix lookalike", remote: undefined, remotes: "origin https://notgithub.com/owner/app.git", description: "Change (#45)", repository: null, issue: null },
  { name: "GitHub text in another host's path", remote: undefined, remotes: "origin https://example.com/github.com/owner/app.git", description: "Change (#45)", repository: null, issue: null },
];

for (const attribution of attributionCases) test(`migration context resolves ${attribution.name} without unrelated attribution`, async () => {
  const requests: BoundedProcessRequest[] = [];
  let remoteLookups = 0;
  const source = { ...candidate, description: attribution.description };
  const migration = await migrationCandidate(import.meta.dirname, {
    current: { root: import.meta.dirname }, integrationBranch: "main",
    configuration: { remote: attribution.remote, migrationFinalization: policy },
  }, {
    jj: async (_cwd, args) => {
      if (args[0] === "diff") return "M schema/source";
      if (args[0] === "git") { remoteLookups++; return attribution.remotes; }
      if (args[0] === "log" && args.at(-1) === "description") {
        assert.equal(args[2], source.commitId, "Issue attribution reads the immutable semantic source");
        return attribution.description;
      }
      return "";
    },
    revisionFacts: async () => source,
  }, {
    environment: () => ({ SLIPJAY_MIGRATION_CONTEXT: "spoofed", EXTRA_ENVIRONMENT: "excluded" }),
    runCommand: async (request) => {
      requests.push(request);
      return { exitCode: 0, signal: null, timedOut: false, cancelled: false,
        stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
        finishedAt: "2026-10-14T12:00:00.000Z", outputSha256: "fixture" };
    },
  });
  assert.equal(await migration.finalize(source, base), source, "a verified no-op retains the source revision");
  assert.equal(remoteLookups, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.env!.SLIPJAY_MIGRATION_CONTEXT, requests[1]!.env!.SLIPJAY_MIGRATION_CONTEXT);
  assert.deepEqual(JSON.parse(requests[0]!.env!.SLIPJAY_MIGRATION_CONTEXT!), {
    version: 1, repository: attribution.repository, baseCommit: base.commitId,
    candidateCommit: source.commitId, candidateChangeId: source.changeId, issueNumber: attribution.issue,
  });
});

for (const migrationPolicy of [null, policy]) test(`migration context makes no new lookup without ${migrationPolicy ? "owned changes" : "a migration policy"}`, async () => {
  const calls: string[] = [];
  const migration = await migrationCandidate(import.meta.dirname, {
    current: { root: import.meta.dirname }, integrationBranch: "main",
    configuration: { migrationFinalization: migrationPolicy },
  }, {
    jj: async (_cwd, args) => { calls.push(args.join(" ")); assert.equal(args[0], "diff"); return "M docs/guide.md"; },
    revisionFacts: async () => { throw new Error("no candidate lookup expected"); },
  }, {
    environment: () => { throw new Error("no command environment expected"); },
    runCommand: async () => { throw new Error("no command expected"); },
  });
  assert.equal(await migration.finalize(candidate, base), candidate);
  await migration.rollback();
  assert.equal(calls.length, migrationPolicy ? 1 : 0);
});
