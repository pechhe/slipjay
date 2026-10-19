import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/slipjay.ts";
import { jj, landThroughTestRunner, project } from "../support/workspace-project.ts";
import { migrationCommandFailure } from "../../src/lib/landing/migration-command-evidence.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";

const advance = (cwd: string, title: string) => { jj(cwd, ["commit", "-m", title]); jj(cwd, ["bookmark", "set", "main", "-r", "@-"]); jj(cwd, ["git", "push", "--bookmark", "main"]); };
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
  const workspace = (await createWorkspace("migration fixture", f.repo)).workspacePath;
  await write(workspace, "schema/source", "new");
  jj(workspace, ["describe", "-m", "Change schema"]); jj(workspace, ["new"]);
  const remoteMain = () => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const land = async () => { const result = await landThroughTestRunner(f, workspace); return { ...result, output: result.lines.join("\n") }; };
  return { ...f, workspace, remoteMain, land };
}

const append = 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("migrations",{recursive:true}); writeFileSync("migrations/0001.sql","generated");';

test("the runner prepares dependency drift from final rebase before generating and verifying", async () => {
  const f = await fixture('import { marker } from "fixture-dependency"; if(marker!==42)throw Error("dependency wrong");' + append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.4.2", workspaces: ["packages/*"], dependencies: { "fixture-dependency": "workspace:*" } }));
    await write(f.repo, "packages/dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await write(f.repo, "packages/dependency/index.js", "export const marker=42;");
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Dependency introduced after allocation");
    assert.equal(existsSync(join(f.workspace, "node_modules/fixture-dependency")), false);
    const landed = await f.land();
    assert.equal(landed.ok, true, landed.output);
    assert.equal(f.remoteFile("migrations/0001.sql"), "generated");
    assert.equal(await readFile(join(f.root, "migration-verified"), "utf8"), "yes");
    assert.ok(existsSync(f.verified), "the landing gate ran");
    assert.equal(existsSync(f.workspace), false, "the landed workspace was released");
  } finally { await f.dispose(); }
}, 60000);

test("a frozen preparation failure prevents generation and integration and retains semantic source", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", dependencies: { missing: "file:./does-not-exist" } }));
    advance(f.repo, "Uninstallable final graph");
    const base = f.remoteMain();
    const result = await f.land();
    assert.equal(result.ok, false);
    assert.match(result.output, /bun install/);
    assert.doesNotMatch(result.output, /rollback requires reconciliation/);
    assert.equal(existsSync(join(f.root, "migration-verified")), false);
    assert.equal(f.remoteMain(), base);
    assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new");
  } finally { await f.dispose(); }
}, 60000);

for (const [name, source, pass] of [
  ["append", append, true], ["no-op", "", true],
  ["undeclared artifact", append + 'writeFileSync("unexpected", "bad");', false],
  ["failed generation rollback", append + 'console.error("generation evidence");process.exit(9);', false],
] as const) test(`the runner retains ${name} migration behaviour`, async () => {
  const f = await fixture(source);
  try {
    const base = f.remoteMain();
    const out = await f.land();
    assert.equal(out.ok, pass, out.output);
    if (!pass) {
      assert.equal(f.remoteMain(), base);
      if (name === "failed generation rollback") assert.match(out.output, /generation evidence/);
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


test("a failed migration verification reports evidence and rolls generated artifacts back", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "verify.mjs", 'console.error("verification evidence");process.exit(6);');
    advance(f.repo, "Fail configured verifier");
    const base = f.remoteMain();
    const out = await f.land();
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.output, /rollback requires reconciliation/);
    assert.match(out.output, /verification evidence/);
    assert.equal(f.remoteMain(), base);
  } finally { await f.dispose(); }
}, 60000);


test("installation source drift is fenced before generation and restored without integration", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", scripts: { postinstall: 'node -e \"require(\\\"node:fs\\\").writeFileSync(\\\"schema/source\\\",\\\"tampered\\\")\"' } }));
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    await write(f.repo, "schema/source", "old");
    advance(f.repo, "Install script changes source");
    const base = f.remoteMain();
    const out = await f.land();
    assert.equal(out.ok, false);
    assert.match(out.output, /Dependency preparation changed the landing candidate's source/);
    assert.equal(f.remoteMain(), base);
  } finally { await f.dispose(); }
}, 60000);

test("migration failure and progress redact the exact injected command environment", async () => {
  const f = await fixture('process.stdout.write(process.env.API_TOKEN);process.stderr.write("custom failure");process.exit(8);');
  try {
    const { migrationCandidate } = await import("../../src/lib/landing/migration-candidate.ts");
    const { revisionFacts } = await import("../../src/lib/infra/workspace-jj.ts");
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
