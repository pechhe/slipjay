import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { failureProvenance, provenanceSource } from "../../src/lib/runner/failure-provenance.ts";
import type { StoredEvent } from "../../src/lib/runner/runner-types.ts";

const vcs = vi.hoisted(() => ({ jj: vi.fn(), run: vi.fn() }));
vi.mock("../../src/lib/infra/workspace-jj.ts", () => vcs);

test("the object reader sorts and bounds each list without executing repository code", async () => {
  vcs.jj.mockReset().mockResolvedValue("/objects");
  vcs.run.mockReset().mockImplementation(async (tool: string, args: string[]) => {
    assert.equal(tool, "git");
    assert.deepEqual(args.slice(0, 3), ["--git-dir", "/objects", "--literal-pathspecs"]);
    assert.equal(args.includes("a".repeat(40)), true);
    let stdout: string;
    if (args[3] === "diff") {
      assert.ok(args.includes("b".repeat(40)));
      assert.ok(args.includes("--no-ext-diff") && args.includes("--no-textconv"));
      stdout = [...Array.from({ length: 105 }, (_, n) => `schema/${String(104 - n).padStart(3, "0")}`), "migrations/a.sql", "unrelated"].join("\0") + "\0";
    } else {
      assert.equal(args[3], "ls-tree");
      const paths = args.slice(args.indexOf("--") + 1).reverse();
      stdout = paths.map(path => `100644 blob ${"c".repeat(40)}\t${path}\0`).join("");
    }
    return { code: 0, stdout, truncated: false };
  });
  const runtime = { name: "bun" as const, version: "1.4.4", sha256: "d".repeat(64), path: "/toolchains/bun" };
  const result = await failureProvenance({ checkout: "/checkout", checked: { candidate: "a".repeat(40), base: "b".repeat(40) },
    policy: { migrationFinalization: { mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
      generate: { executable: "node", args: [], cwd: null }, verify: { executable: "node", args: [], cwd: null } },
      provenance: { fixturePaths: Array.from({ length: 55 }, (_, n) => `fixture/${String(54 - n).padStart(3, "0")}`) } },
    runtime: { status: "recorded", executable: "bun", args: [], cwd: ".", environmentNames: [], redacted: false, configurationSha256: "e".repeat(64), runtime } });
  assert.ok("paths" in result.migrations);
  assert.equal(result.migrations.paths.length, 100);
  assert.equal(result.migrations.paths[0], "migrations/a.sql");
  assert.equal(result.migrations.truncated, true);
  assert.deepEqual(result.toolchain.runtime, { name: runtime.name, version: runtime.version, sha256: runtime.sha256 });
  assert.deepEqual(result.toolchain.lockfiles.map(row => row.path), ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  assert.ok(result.toolchain.lockfiles.every(row => row.blob === "c".repeat(40)));
  assert.ok("paths" in result.fixture);
  assert.equal(result.fixture.paths.length, 50);
  assert.equal(result.fixture.paths[0]!.path, "fixture/000");
  assert.equal(result.fixture.truncated, true);
  assert.equal(vcs.jj.mock.calls.length, 1);
  assert.deepEqual(vcs.jj.mock.calls[0], ["/checkout", ["--ignore-working-copy", "git", "root"]]);
});

test("no candidate or unreadable objects produce bounded explicit reasons", async () => {
  vcs.jj.mockReset().mockRejectedValue(new Error("missing objects"));
  const absent = await failureProvenance({ checkout: "/checkout" });
  assert.deepEqual(absent.fixture, { unavailable: "the repository declares no provenance.fixturePaths" });
  assert.deepEqual(absent.toolchain.runtime, { unavailable: "the failure has no recorded run" });
  assert.ok("unavailable" in absent.migrations);
  assert.equal(vcs.jj.mock.calls.length, 0);
  const unreadable = await failureProvenance({ checkout: "/checkout", checked: { candidate: "a".repeat(40), base: "b".repeat(40) },
    policy: { migrationFinalization: null, provenance: { fixturePaths: ["fixtures"] } } });
  assert.ok("unavailable" in unreadable.migrations && "unavailable" in unreadable.fixture);
});

test("recovery selects the latest exact prepared attempt and the failing run's recorded evidence", () => {
  const runtime = { status: "unavailable" as const, reason: "capacity" as const };
  const events = [
    { event: { type: "attempt_prepared", candidate: "old", base: "old-base" } },
    { event: { type: "attempt_prepared", candidate: "checked", base: "exact-base" } },
    { event: { type: "run_started", command: "failed", commandEvidence: runtime } },
    { event: { type: "run_started", command: "other" } },
  ] as StoredEvent[];
  assert.deepEqual(provenanceSource(events, { type: "failed", stage: "verifying", reason: "failed", command: "failed" }),
    { checked: { candidate: "checked", base: "exact-base" }, runtime });
});
