import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "./support/workspace-project.ts";
import { migrationCommandFailure } from "../src/lib/migration-command-evidence.mjs";
import { runBoundedProcess } from "../src/lib/bounded-process.mjs";

const cli = resolve("src/launcher/workspace.mjs");
const native = (cwd: string, args: string[]) => execFileSync("node", [cli, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const advance = (cwd: string, title: string) => { jj(cwd, ["commit", "-m", title]); jj(cwd, ["bookmark", "set", "main", "-r", "@-"]); };
async function write(root: string, path: string, value: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

async function fixture(generate: string) {
  const f = await project({ ignore: "node_modules\n", policy: { migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "node", args: ["generate.mjs"] }, verify: { executable: "node", args: ["verify.mjs"] },
  } } });
  await write(f.repo, "schema/source", "old");
  await write(f.repo, "generate.mjs", generate);
  // Logs are external; verifier must not edit the candidate.
  await write(f.repo, "verify.mjs", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(f.root, "migration-verified"))}, "yes");`);
  advance(f.repo, "Configure migration");
  const started = JSON.parse(native(f.repo, ["start", "--integration", "--json", "migration fixture"]));
  const workspace = started.workspacePath as string;
  await write(workspace, "schema/source", "new");
  jj(workspace, ["describe", "-m", "Change schema"]); jj(workspace, ["new"]);
  return { ...f, workspace };
}

const append = 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("migrations",{recursive:true}); writeFileSync("migrations/0001.sql","generated");';

test("actual CLI prepares dependency drift from final rebase before generating and verifying", async () => {
  const f = await fixture('import { marker } from "fixture-dependency"; if(marker!==42)throw Error("dependency wrong");' + append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.4.2", workspaces: ["packages/*"], dependencies: { "fixture-dependency": "workspace:*" } }));
    await write(f.repo, "packages/dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await write(f.repo, "packages/dependency/index.js", "export const marker=42;");
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Dependency introduced after allocation");
    assert.equal(existsSync(join(f.workspace, "node_modules/fixture-dependency")), false);
    const out = native(f.workspace, ["land", "--local-only"]);
    assert.match(out, /0001|commitId/);
    // The landing removed its own workspace, so read what it integrated from the repository.
    assert.equal(jj(f.repo, ["file", "show", "-r", "main", "migrations/0001.sql"]), "generated");
    assert.equal(await readFile(join(f.root, "migration-verified"), "utf8"), "yes");
    assert.match(await readFile(f.verified, "utf8"), /workspaces/);
    assert.equal(existsSync(f.workspace), false, "the landed workspace was released");
  } finally { await f.dispose(); }
}, 60000);

test("actual CLI frozen preparation failure prevents generation and integration and retains semantic source", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", dependencies: { missing: "file:./does-not-exist" } }));
    advance(f.repo, "Uninstallable final graph");
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const result = spawnSync("node", [cli, "land", "--local-only"], { cwd: f.workspace, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Dependency command failed.*bun install/);
    assert.doesNotMatch(result.stderr, /rollback requires reconciliation/);
    assert.equal(existsSync(join(f.workspace, "migrations/0001.sql")), false);
    assert.equal(existsSync(join(f.root, "migration-verified")), false);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), base);
    assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new");
  } finally { await f.dispose(); }
}, 60000);

for (const [name, source, pass] of [
  ["append", append, true], ["no-op", "", true],
  ["undeclared artifact", append + 'writeFileSync("unexpected", "bad");', false],
  ["failed generation rollback", append + 'console.error("generation evidence");process.exit(9);', false],
] as const) test(`actual CLI retains ${name} migration behaviour`, async () => {
  const f = await fixture(source);
  try {
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const out = spawnSync("node", [cli, "land", "--local-only"], { cwd: f.workspace, encoding: "utf8" });
    assert.equal(out.status === 0, pass, out.stderr);
    if (!pass) {
      assert.equal(existsSync(join(f.workspace, "migrations/0001.sql")), false);
      assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), base);
      assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new");
      if (name === "failed generation rollback") assert.match(out.stderr, /generation evidence/);
    }
  } finally { await f.dispose(); }
}, 60000);

test("complete split-stream credentials redact before clipping; truncated evidence is withheld", async () => {
  const result = await runBoundedProcess({ executable: "node", args: ["-e", 'process.stdout.write("postgres://user:sec");process.stdout.write("ret@host/db\\n");process.stderr.write("known-");process.stderr.write("credential\\n");process.exitCode=7;'], cwd: process.cwd(), env: process.env, timeoutMs: 5000, maxOutputBytes: 65536 });
  const error = migrationCommandFailure("node generate", result, process.cwd(), { API_TOKEN: "known-credential" });
  assert.doesNotMatch(error.message, /secret@host|known-credential/);
  assert.match(error.message, /REDACTED_URL/);
  for (const extra of [{ timedOut: true }, { cancelled: true }, { signal: "SIGTERM" }, { stdoutTruncated: true, stdout: "credential suffix" }]) {
    const failure = migrationCommandFailure("node verify", { ...result, ...extra }, process.cwd());
    if ("stdoutTruncated" in extra) assert.doesNotMatch(failure.message, /credential suffix/);
    else assert.match(failure.message, /timeout|cancelled|signal/);
  }
});


test("actual CLI failed verification reports evidence and rolls generated artifacts back", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "verify.mjs", 'console.error("verification evidence");process.exit(6);');
    advance(f.repo, "Fail configured verifier");
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const out = spawnSync("node", [cli, "land", "--local-only"], { cwd: f.workspace, encoding: "utf8" });
    assert.notEqual(out.status, 0);
    assert.doesNotMatch(out.stderr, /rollback requires reconciliation/);
    assert.match(out.stderr, /verification evidence/);
    assert.equal(existsSync(join(f.workspace, "migrations/0001.sql")), false);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), base);
  } finally { await f.dispose(); }
}, 60000);


test("installation source drift is fenced before generation and restored without integration", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", scripts: { postinstall: 'node -e \"require(\\\"node:fs\\\").writeFileSync(\\\"schema/source\\\",\\\"tampered\\\")\"' } }));
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    await write(f.repo, "schema/source", "old");
    advance(f.repo, "Install script changes source");
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const out = spawnSync("node", [cli, "land", "--local-only"], { cwd: f.workspace, encoding: "utf8" });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Dependency preparation changed the landing candidate's source/);
    assert.equal(existsSync(join(f.workspace, "migrations/0001.sql")), false);
    assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new");
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), base);
  } finally { await f.dispose(); }
}, 60000);

test("migration failure and progress redact the exact injected command environment", async () => {
  const f = await fixture('process.stdout.write(process.env.API_TOKEN);process.stderr.write("custom failure");process.exit(8);');
  try {
    const { migrationCandidate } = await import("../src/lib/migration-candidate.mjs");
    const { revisionFacts } = await import("../src/lib/workspace-jj.mjs");
    const secret = "injected-fixture-credential";
    const policy = JSON.parse(await readFile(join(f.workspace, "slipjay.json"), "utf8"));
    policy.migrationFinalization.generate.args.push(secret, "postgres://fixture:password@invalid/db");
    const progress: string[] = [];
    const migration = await migrationCandidate(f.workspace, {
      current: { root: f.workspace }, integrationBranch: "main", configuration: policy,
    }, { jj: async (cwd: string, args: string[]) => jj(cwd, args), revisionFacts }, {
      environment: () => ({ ...process.env, API_TOKEN: secret }), onProgress: (line: string) => progress.push(line),
    });
    try {
      await assert.rejects(migration.finalize(await revisionFacts(f.workspace, "@-"), await revisionFacts(f.workspace, "main")), (error: Error) => {
        assert.match(error.message, /custom failure/);
        assert.doesNotMatch(error.message, /injected-fixture-credential|password@invalid/);
        return true;
      });
      assert.doesNotMatch(progress.join("\n"), /injected-fixture-credential|password@invalid/);
      assert.match(progress.join("\n"), /REDACTED/);
    } finally { await migration.rollback(); }
  } finally { await f.dispose(); }
}, 60000);
