import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { candidateChanges, landingCommands, planCandidate, PROCESS_TESTS, readQuarantine, RUNTIME_TESTS, runtimeTestFiles, selectLandingTests, versionOnlyChange, type JjQuery } from "./test-landing.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const CANDIDATE = "a".repeat(40);
const PARENT = "b".repeat(40);
const CHILD = "c".repeat(40);
function query(options: { emptyChild?: boolean; parent?: string; conflict?: boolean; unreadable?: boolean; moving?: boolean; integration?: string; deleted?: boolean } = {}) {
  const calls: string[][] = [];
  let reads = 0;
  const run: JjQuery = (args) => {
    calls.push(args);
    if (options.unreadable) throw new Error("unreadable");
    const revision = args[args.indexOf("-r") + 1];
    if (args[0] === "log") {
      if (revision === "main") return options.integration ?? PARENT;
      if (revision === "@") {
        reads++;
        return [options.moving && reads > 1 ? CHILD : options.emptyChild ? CHILD : CANDIDATE, options.emptyChild ? CANDIDATE : options.parent ?? PARENT, String(options.conflict ?? false), String(options.emptyChild ?? false)].join("\n");
      }
      return [CANDIDATE, PARENT, "false", "false"].join("\n");
    }
    if (args[0] === "file") return revision === PARENT && options.deleted ? "src/gone.ts\n" : "";
    if (args[0] === "diff") return JSON.stringify("tests/runner/fixtures/pipeline/landed.json") + "\n";
    throw new Error("Unexpected JJ query");
  };
  return { run, calls };
}

test("runtime fixture selection includes its reader; source includes every process caller", () => {
  const fixture = selectLandingTests(["tests/runner/fixtures/pipeline/landed.json"], []);
  assert.equal(fixture.kind, "related");
  if (fixture.kind === "related") assert.deepEqual(fixture.files, ["tests/runner/runner-pipeline-fixtures.test.ts"]);
  const source = selectLandingTests(["src/lib/runner/runner-log.ts"], []);
  assert.equal(source.kind, "related");
  if (source.kind === "related") for (const file of PROCESS_TESTS) assert.ok(source.files.includes(file));
});

test("untraceable changes fail closed; docs select no Vitest suites", () => {
  for (const file of ["package.json", "bun.lock", "vite.config.ts", "scripts/vitest-hermetic-env.ts", "tsconfig.json", "unknown.txt", "tests/unknown.json", "src/unknown.json", "tests/quarantine.json"]) {
    assert.equal(selectLandingTests([file], []).kind, "complete", file);
  }
  for (const file of ["src/deleted.ts", "tests/runner/fixtures/pipeline/gone.json", "docs/gone.md", "scripts/gone.ts", "tsconfig.json"]) assert.equal(selectLandingTests([], [file]).kind, "complete", file);
  const docs = selectLandingTests(["README.md", "docs/usage.md"], []);
  assert.equal(docs.kind, "none");
  assert.deepEqual(landingCommands(docs, []).map((entry) => entry.suite), ["runtimes"]);
});

test("a deleted test file selects nothing; a deleted non-test file still fails closed", () => {
  for (const deleted of ["tests/workspace/workspace-adopt.test.ts", "scripts/test-landing.test.ts"]) {
    for (const changed of [[], [deleted]]) {
      const plan = selectLandingTests(changed, [deleted]);
      assert.equal(plan.kind, "none", `${changed.length} changed, ${deleted} deleted`);
      assert.deepEqual(landingCommands(plan, []).map((entry) => entry.suite), ["runtimes"]);
    }
  }
  const deletedTest = "tests/runner/gone.test.ts";
  const withSource = selectLandingTests(["src/lib/runner/runner-log.ts", deletedTest], [deletedTest]);
  assert.equal(withSource.kind, "related");
  if (withSource.kind === "related") {
    assert.ok(!withSource.files.includes(deletedTest));
    assert.ok(withSource.files.includes("src/lib/runner/runner-log.ts"));
    for (const file of PROCESS_TESTS) assert.ok(withSource.files.includes(file), file);
  }
  assert.equal(selectLandingTests([deletedTest], [deletedTest, "src/gone.ts"]).kind, "complete");
});

test("no file, test files included, imports a test file, so a deleted test file has no dependants", () => {
  const SOURCE = /\.[cm]?[jt]sx?$/;
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const offenders: string[] = [];
  for (const dir of ["src", "tests", "scripts"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!SOURCE.test(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) continue;
        if (/\.test\.ts$/.test(path.resolve(path.dirname(file), specifier))) offenders.push(`${path.relative(ROOT, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("a release bump of package.json's version alone is no test input; any other package.json change is", () => {
  const before = JSON.stringify({ name: "slipjay", version: "3.31.0", scripts: { test: "vp test" } }, null, 2);
  assert.equal(versionOnlyChange(before, JSON.stringify({ name: "slipjay", version: "3.32.0", scripts: { test: "vp test" } })), true);
  assert.equal(versionOnlyChange(before, JSON.stringify({ name: "slipjay", version: "3.32.0", scripts: { test: "vp test --x" } })), false);
  assert.equal(versionOnlyChange(before, "{"), false);
});

test("diff uses immutable candidate and exact single integration parent, including empty continuation", () => {
  for (const emptyChild of [false, true]) {
    const fake = query({ emptyChild });
    const snapshot = candidateChanges(fake.run, "main");
    assert.equal(snapshot.candidate, CANDIDATE);
    assert.equal(snapshot.parent, PARENT);
    const diff = fake.calls.find((args) => args[0] === "diff")!;
    assert.equal(diff[diff.indexOf("--from") + 1], PARENT);
    assert.equal(diff[diff.indexOf("--to") + 1], CANDIDATE);
    assert.equal(selectLandingTests(snapshot.changed, snapshot.deleted).kind, "related");
    snapshot.assertUnchanged();
  }
  const deleted = candidateChanges(query({ deleted: true }).run, "main");
  assert.deepEqual(deleted.deleted, ["src/gone.ts"]);
  assert.equal(selectLandingTests(deleted.changed, deleted.deleted).kind, "complete");
});

test("unreadable, ambiguous, conflicted, stale and moving candidates run complete suite", () => {
  for (const options of [{ unreadable: true }, { parent: PARENT + " " + CHILD }, { conflict: true }, { parent: CHILD }, { integration: PARENT + CHILD }, { moving: true }]) {
    assert.equal(planCandidate(() => candidateChanges(query(options).run, "main")).kind, "complete", JSON.stringify(options));
  }
});

test("candidate mutation after selection refuses the old evidence", () => {
  let moved = false;
  const original = query().run;
  const snapshot = candidateChanges((args) => moved && args[0] === "log" && args.includes("@") ? [CHILD, PARENT, "false", "false"].join("\n") : original(args), "main");
  moved = true;
  assert.throws(snapshot.assertUnchanged, /changed during verification/);
});

test("quarantine excludes Vitest and runtime files even from complete landing runs", () => {
  const quarantine = readQuarantine(JSON.stringify([
    { file: "tests/integration/cli.test.ts", issue: 117, reason: "Investigating flake" },
    { file: RUNTIME_TESTS[0], issue: 117, reason: "Investigating runtime flake" },
  ]));
  for (const plan of [selectLandingTests(["bun.lock"], []), selectLandingTests(["src/lib/runner/runner-log.ts"], [])]) {
    const commands = landingCommands(plan, quarantine);
    assert.ok(commands[0]!.command.includes("--exclude"));
    assert.ok(commands[0]!.command.includes("tests/integration/cli.test.ts"));
    assert.ok(!commands[1]!.command.includes(RUNTIME_TESTS[0]!));
    assert.ok(!commands.some((entry) => entry.report || entry.command.some((arg) => arg.includes("reporter"))));
  }
  for (const entry of [{ file: "../escape.test.ts", issue: 1, reason: "x" }, { file: "tests/x.test.ts", issue: 0, reason: "x" }, { file: "tests/x.test.ts", issue: 1, reason: "" }]) assert.throws(() => readQuarantine(JSON.stringify([entry])));
});

test("runtime file inventory follows the complete-suite script", () => {
  assert.deepEqual(runtimeTestFiles("bun test scripts/a.test.ts scripts/b.test.ts"), ["scripts/a.test.ts", "scripts/b.test.ts"]);
  for (const command of ["bun test", "bun test scripts/*.test.ts", "bun run other", "bun test scripts/a.test.ts --timeout 1000"]) assert.throws(() => runtimeTestFiles(command));
});

test("every process lane entry is a real test file, and the lane keeps the CLI and installed package", () => {
  assert.equal(new Set(PROCESS_TESTS).size, PROCESS_TESTS.length, "no duplicate entries");
  for (const file of PROCESS_TESTS) {
    assert.match(file, /^tests\/.*\.test\.ts$/, file);
    assert.ok(existsSync(path.join(ROOT, file)), `${file} exists`);
  }
  assert.ok(PROCESS_TESTS.includes("tests/integration/cli.test.ts"));
  assert.ok(PROCESS_TESTS.includes("tests/integration/installed-package.test.ts"));
});

test("Vitest's graph selects fixture reader and process callers, and honors quarantine", async () => {
  const { createVitest } = await import("vite-plus/test/node");
  const fixture = selectLandingTests(["tests/runner/fixtures/pipeline/landed.json"], []);
  const source = selectLandingTests(["src/lib/runner/runner-log.ts"], []);
  assert.ok(fixture.kind === "related" && source.kind === "related");
  const ctx = await createVitest({ root: ROOT, watch: false, run: true, exclude: ["tests/integration/cli.test.ts"] });
  try {
    ctx.config.related = fixture.files.map((file) => path.join(ROOT, file));
    let selected = (await ctx.getRelevantTestSpecifications()).map((spec) => path.relative(ROOT, spec.moduleId));
    assert.ok(selected.includes("tests/runner/runner-pipeline-fixtures.test.ts"));
    ctx.config.related = source.files.map((file) => path.join(ROOT, file));
    selected = (await ctx.getRelevantTestSpecifications()).map((spec) => path.relative(ROOT, spec.moduleId));
    for (const file of PROCESS_TESTS.filter((file) => file !== "tests/integration/cli.test.ts")) assert.ok(selected.includes(file), file);
    assert.ok(!selected.includes("tests/integration/cli.test.ts"));
  } finally { await ctx.close(); }
}, 30_000);

test("gate writes opt-in manifest, tolerates missing reports and preserves test failure", () => {
  mkdirSync(path.join(ROOT, ".build"), { recursive: true });
  const scratch = mkdtempSync(path.join(ROOT, ".build/landing-test-"));
  try {
    const bin = path.join(scratch, "bin");
    mkdirSync(bin);
    const log = path.join(scratch, "commands.jsonl");
    const fake = [
      `#!${process.execPath}`,
      'const fs = require("node:fs"); const args = process.argv.slice(2);',
      'if (process.argv[1].endsWith("/jj")) {',
      'if(args.includes("main")) process.stdout.write("b".repeat(40));',
      'else if(args.includes("log")) process.stdout.write(["a".repeat(40),"b".repeat(40),"false","false"].join("\\n"));',
      'else if(args.includes("diff")) process.stdout.write(JSON.stringify("tests/runner/fixtures/pipeline/landed.json")+"\\n");',
      '} else { fs.appendFileSync(process.env.TEST_COMMANDS, JSON.stringify(args)+"\\n"); process.exit(Number(process.env.TEST_EXIT || 0)); }',
    ].join("\n");
    for (const name of ["jj", "bun", "bunx"]) writeFileSync(path.join(bin, name), fake, { mode: 0o755 });
    const reportDir = path.join(scratch, "reports");
    const invoke = (report: boolean, exit = 0, directory = reportDir, ...flags: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts/test-landing.ts"), ...flags], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_COMMANDS: log, TEST_EXIT: String(exit), SLIPJAY_TEST_REPORT_DIR: report ? directory : "" },
    });
    const noReports = invoke(false);
    assert.equal(noReports.status, 0, noReports.stderr);
    assert.ok(!existsSync(reportDir));
    assert.equal(invoke(true).status, 0, "missing reporter outputs cannot invalidate successful commands");
    const manifest = JSON.parse(readFileSync(path.join(reportDir, "slipjay-test-reports.json"), "utf8"));
    assert.deepEqual(manifest, { version: 1, reports: [
      { format: "vitest-json", path: "vitest.json", suite: "vitest", cwd: "." },
      { format: "bun-junit", path: "bun-junit.xml", suite: "runtimes", cwd: "." },
    ] });
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(!commands[0]!.some((arg) => arg.includes("reporter")));
    assert.ok(commands[2]!.includes("--reporter=default") && commands[2]!.includes("--reporter=json"));
    assert.ok(commands[3]!.includes("--reporter=junit"));
    assert.equal(invoke(true, 7).status, 7, "test command status remains authoritative");
    assert.equal(invoke(true, 0, log).status, 0, "unavailable report directory does not break tests");
    rmSync(log, { force: true });
    assert.equal(invoke(true, 0, reportDir, "--audit").status, 0);
    const audit = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(audit[0]!.slice(0, 3), ["vp", "test", "run"], "the audit runs the complete suite");
    assert.ok(!audit[0]!.includes("--exclude"), "quarantined tests stay in the audit");
    assert.ok(audit[0]!.includes("--reporter=json") && audit[1]!.includes("--reporter=junit"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
