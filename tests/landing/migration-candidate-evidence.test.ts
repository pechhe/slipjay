import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { jj } from "../support/workspace-project.ts";
import { migrationCommandFailure } from "../../src/lib/landing/migration-command-evidence.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { advance, write, fixture, append } from "./fixtures/migration-candidate-fixture.ts";

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
