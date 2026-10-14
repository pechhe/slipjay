import { jj, landThroughTestRunner, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vite-plus/test";
import {
  parseExecutionPolicy, readExecutionPolicy, readExecutionPolicyAtCommit, readIntegrationPolicy, resolveIntegrationBranch,
} from "../src/lib/execution-policy.ts";
import { readExactExecutionPolicy } from "../src/lib/post-integration-source.ts";
import { workspaceContext } from "../src/lib/slipjay.ts";

// peach-pi's policy as extracted (pechhe/peach-pi 37a32367): its landing records
// carry this declaration's digest, so the parser must keep reproducing it.
const peachPolicy = JSON.stringify({
  version: 1,
  integrationBranch: "master",
  remote: "origin",
  requiredLandingVerification: [
    { executable: "bun", args: ["install", "--frozen-lockfile"] },
    { executable: "bun", args: ["dedupe", "--check"], concurrent: true },
    { executable: "bun", args: ["run", "check"], concurrent: true },
    { executable: "bun", args: ["run", "check:architecture"], concurrent: true },
    { executable: "bun", args: ["run", "typecheck"], concurrent: true },
    { executable: "bun", args: ["run", "test:landing"], concurrent: true },
  ],
  generatedPaths: ["apps/desktop/deno/generated", "**/.build"],
  unattendedMergeToIntegration: true,
  parallelExecution: true,
});
const slipjayPolicy = readFileSync(fileURLToPath(new URL("../slipjay.json", import.meta.url)), "utf8");
// The shape of YardSmith's policy: a develop integration branch, the older
// sourcePublication remote, `cwd: null`, migrations and a development database step.
const yardsmithPolicy = {
  version: 1,
  integrationBranch: "develop",
  sourcePublication: { version: 1, mode: "required", remote: "origin" },
  releaseBranch: "master",
  generatedPaths: ["apps/planner-workbench/src/paraglide", ".yardsmith/diagnostics"],
  requiredLandingVerification: [{ executable: "bun", args: ["run", "test:business-journeys:critical"], cwd: null }],
  unattendedMergeToIntegration: true,
  parallelExecution: true,
  migrationFinalization: {
    mode: "late_bound_serialized",
    triggerPaths: ["apps/planner-workbench/src/lib/server/db/schema.ts"],
    artifactPaths: ["apps/planner-workbench/drizzle"],
    generate: { executable: "bun", args: ["run", "db:generate"], cwd: "apps/planner-workbench" },
    verify: { executable: "bun", args: ["run", "check:migrations"] },
  },
  postIntegration: {
    version: 1, target: "yardsmith-development-db:61a7", idempotency: "artifact-key",
    approvalMode: "automatic-development", timeoutMs: 600000,
    command: { executable: "bun", args: ["scripts/finalize-development-migration.ts"], cwd: "apps/planner-workbench" },
    targetProbe: { executable: "bun", args: ["scripts/probe-development-database-target.ts"], cwd: "apps/planner-workbench" },
    environmentKeys: [],
  },
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policy = (overrides: Record<string, unknown>) => JSON.stringify({ version: 1, ...overrides });
const check = (executable: string, extra: Record<string, unknown> = {}) => ({ executable, args: ["run", "test"], ...extra });

test("peach-pi's policy parses with its landing shape and verification digest unchanged", () => {
  const parsed = parseExecutionPolicy(peachPolicy);
  assert.equal(parsed.integrationBranch, "master");
  assert.equal(parsed.remote, "origin");
  assert.equal(parsed.parallelExecution, true);
  assert.equal(parsed.unattendedMergeToIntegration, true);
  assert.deepEqual(parsed.requiredLandingVerification[1], { executable: "bun", args: ["dedupe", "--check"], concurrent: true });
  // The digest landing records for this declaration before the shared parser existed.
  assert.equal(digest(parsed.requiredLandingVerification), "25effc2d61517a47e37578dae699fe59599f9b43732013020df26aab978316b8");
});

test("slipjay's own policy gates a landing on static checks and the test suite", () => {
  const parsed = parseExecutionPolicy(slipjayPolicy);
  assert.equal(parsed.integrationBranch, "main");
  assert.equal(parsed.remote, "origin");
  assert.deepEqual(parsed.requiredLandingVerification.map((step: { args: string[] }) => step.args.join(" ")),
    ["install --frozen-lockfile", "run check", "run typecheck", "run test"]);
});

test("a YardSmith-shaped policy keeps every declaration it makes", () => {
  const parsed = parseExecutionPolicy(JSON.stringify(yardsmithPolicy));
  assert.equal(parsed.integrationBranch, "develop");
  assert.equal(parsed.remote, "origin");
  assert.equal(parsed.releaseBranch, "master");
  assert.deepEqual(parsed.sourcePublication, yardsmithPolicy.sourcePublication);
  assert.deepEqual(parsed.generatedPaths, yardsmithPolicy.generatedPaths);
  assert.deepEqual(parsed.postIntegration, yardsmithPolicy.postIntegration);
  assert.deepEqual(parsed.requiredLandingVerification, [{ executable: "bun", args: ["run", "test:business-journeys:critical"] }]);
  assert.equal(digest(parsed.requiredLandingVerification), "41f1dc81f59107adca78bf8466b3bea732d36595686ec012bb10e081494b4e66");
  assert.deepEqual(parsed.migrationFinalization?.generate, { executable: "bun", args: ["run", "db:generate"], cwd: "apps/planner-workbench" });
  assert.equal(parsed.migrationFinalization?.verify.cwd, null);
});

test("a policy declaring the gate's former name is refused, never read as an empty gate", () => {
  assert.throws(() => parseExecutionPolicy(policy({ requiredLocalVerification: [check("bun")] })), /requiredLocalVerification, the gate's former name; rename it requiredLandingVerification/);
});

test("a policy still declaring postLandVerification is refused, not silently ignored", () => {
  assert.throws(() => parseExecutionPolicy(policy({ postLandVerification: [check("bun")] })), /postLandVerification, which is no longer run/);
});

test("a reset declares its target, deadline and an interval of an hour to 30 days; postRelease is refused", () => {
  const reset = { version: 1, target: "app-development-db:1a2b", timeoutMs: 900000, intervalMs: 7 * 86_400_000,
    command: { executable: "bun", args: ["scripts/reset-development.ts"], cwd: "app" },
    targetProbe: { executable: "bun", args: ["scripts/probe-development.ts"], cwd: "app" }, environmentKeys: ["NEON_API_KEY"] };
  assert.deepEqual(parseExecutionPolicy(policy({ integrationBranch: "develop", reset })).reset, reset);
  assert.deepEqual(parseExecutionPolicy(policy({ integrationBranch: "develop", reset: { ...reset, intervalMs: 3_600_000 } })).reset?.intervalMs, 3_600_000);
  for (const intervalMs of [3_599_999, 30 * 86_400_000 + 1, undefined, 1.5 * 3_600_000 + 0.5])
    assert.throws(() => parseExecutionPolicy(policy({ integrationBranch: "develop", reset: { ...reset, intervalMs } })), /Invalid reset identity, deadline or interval/, String(intervalMs));
  assert.throws(() => parseExecutionPolicy(policy({ integrationBranch: "develop", reset: { ...reset, timeoutMs: 900001 } })), /Invalid reset/);
  assert.throws(() => parseExecutionPolicy(policy({ integrationBranch: "develop", reset: { ...reset, environmentKeys: ["SLIPJAY_RESET_TARGET"] } })), /Invalid reset environment declaration/);
  assert.throws(() => parseExecutionPolicy(policy({ reset })), /declares reset without an integrationBranch/);
  assert.throws(() => parseExecutionPolicy(policy({ integrationBranch: "develop", releaseBranch: "master", postRelease: reset })),
    /declares postRelease, which no longer runs at promotion; declare it as reset with an intervalMs/);
});

test("an empty or absent check list is a valid landing policy", () => {
  assert.deepEqual(parseExecutionPolicy(policy({ requiredLandingVerification: [] })).requiredLandingVerification, []);
  assert.deepEqual(parseExecutionPolicy(policy({})).requiredLandingVerification, []);
  assert.equal(parseExecutionPolicy(policy({})).remote, null);
});

test("the strict rules reject unsafe or malformed policies", () => {
  const rejects = (raw: string, pattern: RegExp) => assert.throws(() => parseExecutionPolicy(raw), pattern, raw.slice(0, 120));
  rejects(JSON.stringify({ integrationBranch: "main" }), /version-1 policy/);
  rejects("{", /not valid JSON/);
  rejects(policy({ padding: "x".repeat(64 * 1024) }), /64 KiB/);
  for (const shell of ["bash", "sh", "zsh", "fish", "pwsh", "git", "jj", "Bash"]) {
    rejects(policy({ requiredLandingVerification: [check(shell)] }), /unsafe for a landing gate/);
  }
  rejects(policy({ requiredLandingVerification: [check("/usr/bin/node")] }), /bare executable name/);
  rejects(policy({ requiredLandingVerification: [check("bun", { cwd: "../x" })] }), /inside the checkout/);
  rejects(policy({ requiredLandingVerification: [check("bun", { cwd: "/tmp" })] }), /inside the checkout/);
  rejects(policy({ requiredLandingVerification: [{ executable: "bun", args: Array(101).fill("x") }] }), /at most 100/);
  rejects(policy({ requiredLandingVerification: Array(21).fill(check("bun")) }), /at most 20/);
  for (const branch of ["-main", "main..master", "feature branch", "", "x".repeat(201)]) {
    rejects(policy({ integrationBranch: branch }), /unsafe integrationBranch/);
  }
  rejects(policy({ generatedPaths: ["../outside"] }), /generatedPaths entry/);
  rejects(policy({ remote: "origin upstream" }), /publication remote/);
  rejects(policy({ postIntegration: { ...yardsmithPolicy.postIntegration, timeoutMs: 600001 } }), /deadline/);
  rejects(policy({ migrationFinalization: { ...yardsmithPolicy.migrationFinalization, generate: check("../bun") } }), /safe command/);
});

test("a release branch declares its own checks, and unsafe release declarations are refused", () => {
  const parsed = parseExecutionPolicy(JSON.stringify({ version: 1, integrationBranch: "develop", releaseBranch: "master",
    requiredReleaseVerification: [{ executable: "bun", args: ["run", "check:static"] }] }));
  assert.equal(parsed.releaseBranch, "master");
  assert.deepEqual(parsed.requiredReleaseVerification, [{ executable: "bun", args: ["run", "check:static"] }]);
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1, releaseBranch: "master" })).requiredReleaseVerification, undefined);
  for (const policy of [
    { version: 1, integrationBranch: "develop", releaseBranch: "develop" },
    { version: 1, releaseBranch: "-master" },
    { version: 1, requiredReleaseVerification: [] },
    { version: 1, releaseBranch: "master", requiredReleaseVerification: [{ executable: "sh", args: ["-c", "true"] }] },
  ]) assert.throws(() => parseExecutionPolicy(JSON.stringify(policy)), JSON.stringify(policy));
});

test("integration branches resolve declared, then origin/HEAD, then main, then master", async () => {
  const exists = (names: string[]) => async (name: string) => names.includes(name);
  assert.equal(await resolveIntegrationBranch({ declared: "develop", originHead: async () => "master", exists: exists([]) }), "develop");
  assert.equal(await resolveIntegrationBranch({ originHead: async () => "master", exists: exists(["main", "master"]) }), "master");
  assert.equal(await resolveIntegrationBranch({ originHead: async () => null, exists: exists(["main", "master"]) }), "main");
  assert.equal(await resolveIntegrationBranch({ exists: exists(["master"]) }), "master");
  assert.equal(await resolveIntegrationBranch({ exists: exists([]) }), null);
  await assert.rejects(resolveIntegrationBranch({ declared: "a..b", exists: exists([]) }), /unsafe integrationBranch/);
});

type PolicyPath = "slipjay.json" | "slipway.json";

async function gitRepository(branches: Record<string, string | null>, originHead: string, policyPaths: PolicyPath[] = ["slipjay.json"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "peach-policy-")));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-q", "--bare", "-b", originHead, remote], root);
  await mkdir(repo);
  git(["init", "-q", "-b", Object.keys(branches)[0]!]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["remote", "add", "origin", remote]);
  for (const [branch, declared] of Object.entries(branches)) {
    git(["checkout", "-q", "-B", branch]);
    // With both names committed, the retired file declares a decoy so precedence is observable.
    for (const policyPath of policyPaths) {
      const decoy = policyPaths.length > 1 && policyPath === "slipway.json";
      await writeFile(join(repo, policyPath), policy(decoy ? { integrationBranch: "legacy-decoy" } : declared ? { integrationBranch: declared } : {}));
    }
    await writeFile(join(repo, `${branch}.txt`), branch);
    git(["add", "."]);
    git(["commit", "-qm", branch]);
    git(["push", "-q", "origin", branch]);
  }
  git(["fetch", "-q", "origin"]);
  git(["remote", "set-head", "origin", originHead]);
  jj(repo, ["git", "init", "--colocate"]);
  return { root, repo, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("a checkout with main and master follows origin/HEAD=master and reads that bookmark's committed policy", async () => {
  const f = await gitRepository({ main: null, master: null }, "master");
  try {
    const resolved = await readIntegrationPolicy(f.repo);
    assert.equal(resolved.integrationBranch, "master");
    assert.equal(resolved.commitId, jj(f.repo, ["log", "--no-graph", "-r", "master", "-T", "commit_id"]));
    // An uncommitted working-file edit is not the committed policy.
    await writeFile(join(f.repo, "slipjay.json"), "not json");
    assert.equal((await readExecutionPolicyAtCommit(f.repo, "master")).policy?.integrationBranch, undefined);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a release bookmark that names another integration branch is followed to it, and drift fails closed", async () => {
  const f = await gitRepository({ develop: "develop", master: "develop" }, "master");
  try {
    assert.equal((await readIntegrationPolicy(f.repo)).integrationBranch, "develop");
    const g = await gitRepository({ develop: "master", master: "develop" }, "master");
    try {
      await assert.rejects(readIntegrationPolicy(g.repo), /Integration policy drift/);
    } finally {
      await g.dispose();
    }
  } finally {
    await f.dispose();
  }
}, 60_000);

test("a malformed working hint recovers through the remote default's committed policy when its local bookmark is deleted", async () => {
  const f = await gitRepository({ develop: "develop", master: "develop" }, "master");
  try {
    jj(f.repo, ["bookmark", "delete", "master"]);
    await writeFile(join(f.repo, "slipjay.json"), "<<<<<<< conflicted policy\n");
    const resolved = await readIntegrationPolicy(f.repo, { hintRoot: f.repo });
    assert.equal(resolved.integrationBranch, "develop");
    assert.equal(resolved.commitId, jj(f.repo, ["log", "--no-graph", "-r", "develop", "-T", "commit_id"]));
    assert.equal(jj(f.repo, ["log", "--no-graph", "-r", 'bookmarks("master")', "-T", "commit_id"]), "");
  } finally { await f.dispose(); }
}, 60_000);

test("landing verifies with the integration bookmark's policy and ignores an uncommitted edit in the primary checkout", async () => {
  const f = await project();
  try {
    // A Direct landing of the primary checkout, whose candidate edits the policy.
    const primaryPolicy = join(f.repo, "slipjay.json");
    const committed = JSON.parse(await readFile(primaryPolicy, "utf8"));
    await writeFile(primaryPolicy, JSON.stringify({ ...committed,
      requiredLandingVerification: [{ executable: "node", args: ["-e", "process.exit(9)"] }] }));
    await writeFile(join(f.repo, "task.txt"), "task\n");
    jj(f.repo, ["describe", "-m", "Task"]);
    const context = await workspaceContext(f.repo);
    assert.deepEqual(context?.configuration.requiredLandingVerification, committed.requiredLandingVerification);
    const landed = await landThroughTestRunner(f, f.repo, { direct: true });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    // The committed check ran once, on the runner, not the edited one; the edit itself is now integrated.
    assert.equal((await readFile(f.verified, "utf8")).trim().split("\n").length, 1);
    assert.match(f.remoteFile("slipjay.json"), /process\.exit\(9\)/);
  } finally {
    await f.dispose();
  }
}, 120_000);

/** Run `operation` capturing what it writes to stderr. */
async function stderrOf<T>(operation: () => Promise<T>) {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  try {
    return { value: await operation(), stderr: lines.join("") };
  } finally {
    spy.mockRestore();
  }
}
const refusal = /slipway\.json is no longer read .* rename it to slipjay\.json/;

test("working files: slipjay.json governs, and the retired path alone is refused, not read", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slipjay-policy-files-")));
  try {
    assert.equal(await readExecutionPolicy(root), null);

    await writeFile(join(root, "slipway.json"), policy({ integrationBranch: "retired" }));
    await assert.rejects(readExecutionPolicy(root), (error: Error & { code?: string }) =>
      refusal.test(error.message) && error.code === "SLIPJAY_RETIRED_POLICY_PATH");

    await writeFile(join(root, "slipjay.json"), policy({ integrationBranch: "neutral" }));
    const both = await stderrOf(() => readExecutionPolicy(root));
    assert.equal(both.value?.integrationBranch, "neutral");
    assert.equal(both.stderr, "", "no warning: the retired file is simply ignored once slipjay.json exists");

    await writeFile(join(root, "slipjay.json"), "{");
    await assert.rejects(readExecutionPolicy(root), /^Error: slipjay\.json is not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, policyPaths] of [
  ["slipjay.json", ["slipjay.json"]],
  ["both, preferring slipjay.json", ["slipjay.json", "slipway.json"]],
] as const) {
  test(`at-commit reads (jj and exact git object) find a policy committed as ${label}`, async () => {
    const f = await gitRepository({ main: "main" }, "main", [...policyPaths]);
    try {
      const commit = jj(f.repo, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]);
      assert.equal((await readExecutionPolicyAtCommit(f.repo, "main")).commitId, commit);
      assert.equal((await readExecutionPolicyAtCommit(f.repo, "main")).policy?.integrationBranch, "main");
      assert.equal((await readIntegrationPolicy(f.repo)).integrationBranch, "main");
      assert.equal((await readExactExecutionPolicy(join(f.repo, ".git"), commit)).configuration?.integrationBranch, "main");
    } finally {
      await f.dispose();
    }
  }, 60_000);
}

test("at-commit reads (jj, integration and exact git object) refuse a commit whose tree has only the retired path", async () => {
  const f = await gitRepository({ main: "main" }, "main", ["slipway.json"]);
  try {
    const commit = jj(f.repo, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]);
    await assert.rejects(readExecutionPolicyAtCommit(f.repo, "main"), refusal);
    await assert.rejects(readIntegrationPolicy(f.repo), refusal);
    await assert.rejects(readExactExecutionPolicy(join(f.repo, ".git"), commit), refusal);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("sharedPaths and spares are validated strictly and kept only when declared", () => {
  const policy = (extra: Record<string, unknown>) => parseExecutionPolicy(JSON.stringify({ version: 1, ...extra }));
  assert.deepEqual(policy({ sharedPaths: ["artifacts", "out/reports/", "artifacts"], spares: 3 }).sharedPaths, ["artifacts", "out/reports"]);
  assert.equal(policy({ sharedPaths: ["artifacts"], spares: 3 }).spares, 3);
  assert.equal(policy({}).sharedPaths, undefined);
  assert.equal(policy({}).spares, undefined, "an undeclared pool size is the caller's default of one");
  assert.equal(policy({ spares: 0 }).spares, 0);
  for (const sharedPaths of ["artifacts", [""], ["/abs"], ["../up"], ["a/../b"], ["./a"], ["a//b"], ["*"], ["a/**"], [".jj"], [".git/x"], [7], ["a", "a/b"], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
    assert.throws(() => policy({ sharedPaths }), /sharedPaths/, JSON.stringify(sharedPaths));
  }
  for (const spares of [-1, 9, 1.5, "2", null]) assert.throws(() => policy({ spares }), /spares must be an integer from 0 to 8/, JSON.stringify(spares));
});

test("deployments declare environments with projects; unknown environments and malformed projects are refused", () => {
  const project = { name: "app", command: { executable: "bun", args: ["scripts/deploy.ts", "app"] } };
  const parsed = parseExecutionPolicy(policy({ deployments: { version: 1, environments: { staging: { timeoutMs: 600_000, environmentKeys: ["VERCEL_TOKEN"], projects: [project] } } } }));
  assert.deepEqual(parsed.deployments, { version: 1, environments: { staging: {
    minIntervalMs: 3_600_000, timeoutMs: 600_000, environmentKeys: ["VERCEL_TOKEN"],
    projects: [{ name: "app", command: { executable: "bun", args: ["scripts/deploy.ts", "app"], cwd: "." } }],
  } } });
  assert.equal(parseExecutionPolicy(policy({})).deployments, undefined);
  const production = parseExecutionPolicy(policy({ deployments: { version: 1, environments: { production: { timeoutMs: 600_000, projects: [{ ...project, activate: project.command }] } } } }));
  assert.deepEqual(Object.keys(production.deployments?.environments ?? {}), ["production"], "production parses; its promotion path is the only deploy");
  const step = (name: string) => ({ executable: "bun", args: ["scripts/deploy.ts", "app", name] });
  const checked = parseExecutionPolicy(policy({ deployments: { version: 1, environments: { production: { timeoutMs: 600_000,
    projects: [{ ...project, healthCheck: step("health"), activate: step("activate") }] } } } }));
  assert.deepEqual(checked.deployments?.environments.production?.projects[0], { ...project, command: { ...project.command, cwd: "." },
    healthCheck: { ...step("health"), cwd: "." }, activate: { ...step("activate"), cwd: "." } });
  const migrating = parseExecutionPolicy(policy({ deployments: { version: 1, environments: { production: { timeoutMs: 600_000,
    projects: [{ ...project, activate: project.command }], migrations: { verify: step("verify"), apply: step("apply") } } } } }));
  assert.deepEqual(migrating.deployments?.environments.production?.migrations, { verify: { ...step("verify"), cwd: "." }, apply: { ...step("apply"), cwd: "." } });
  for (const deployments of [
    { version: 1, environments: { qa: { timeoutMs: 1, projects: [project] } } },
    { version: 1, environments: { staging: { timeoutMs: 1, projects: [] } } },
    { version: 1, environments: { staging: { timeoutMs: 1, projects: [project, project] } } },
    { version: 1, environments: { staging: { timeoutMs: 1, projects: [{ ...project, command: { executable: "bun", args: [], cwd: "../x" } }] } } },
    { version: 1, environments: { staging: { projects: [project] } } },
    { version: 2, environments: {} },
    { version: 1, environments: { production: { timeoutMs: 1, projects: [{ ...project, activate: project.command }, { ...project, name: "hq" }] } } },
    { version: 1, environments: { production: { timeoutMs: 1, projects: [{ ...project, activate: project.command, healthCheck: { executable: "" } }] } } },
    { version: 1, environments: { production: { timeoutMs: 1, projects: [project] } } },
    { version: 1, environments: { staging: { timeoutMs: 1, projects: [project], migrations: { verify: project.command, apply: project.command } } } },
    { version: 1, environments: { production: { timeoutMs: 1, projects: [{ ...project, activate: project.command }], migrations: { verify: project.command } } } },
  ]) assert.throws(() => parseExecutionPolicy(policy({ deployments })), JSON.stringify(deployments));
});
