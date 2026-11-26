import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { candidateChanges, infrastructureScripts, landingCommands, launcherProcessTests, planCandidate, PROCESS_TEST_ENTRIES, PROCESS_TESTS, readQuarantine, RUNTIME_TESTS, runtimeTestFiles, selectLandingTests, versionOnlyChange, type JjQuery } from "./test-landing.ts";

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

test("runtime fixture selection includes its reader; source includes only process callers that can reach it", () => {
  const fixture = selectLandingTests(["tests/runner/fixtures/pipeline/landed.json"], []);
  assert.equal(fixture.kind, "related");
  if (fixture.kind === "related") assert.deepEqual(fixture.files, ["tests/runner/runner-pipeline-fixtures.test.ts"]);

  // Every CLI process caller loads workspace-paths.ts, so changing it reaches every process test.
  const shared = selectLandingTests(["src/lib/workspace/workspace-paths.ts"], []);
  assert.equal(shared.kind, "related");
  if (shared.kind === "related") for (const file of PROCESS_TESTS) assert.ok(shared.files.includes(file), file);

  // Runner-server modules are never loaded by CLI/client process tests.
  for (const serverFile of ["src/lib/runner/runner-log.ts", "src/lib/release/batch-check.ts"]) {
    const server = selectLandingTests([serverFile], []);
    assert.equal(server.kind, "related", serverFile);
    if (server.kind === "related") assert.deepEqual(server.files, [serverFile], serverFile);
  }

  // Scoped library modules reach only the process tests whose commands import them.
  const cutover = selectLandingTests(["src/lib/workspace/cutover.ts"], []);
  assert.equal(cutover.kind, "related");
  if (cutover.kind === "related") {
    assert.ok(cutover.files.includes("tests/workspace/cutover.test.ts"));
    assert.ok(cutover.files.includes("tests/integration/installed-package.test.ts"));
    assert.ok(!cutover.files.includes("tests/runner/command-artifact.test.ts"));
    assert.ok(!cutover.files.includes("tests/landing/repair-workspace.test.ts"));
  }
});

test("launcher changes scope to their command callers, while dispatcher changes select every launcher test", () => {
  // SJ-262's candidate changed only what src/launcher/workspace.ts prints, and dispatcher.test.ts, which runs it, went unselected.
  const dispatcher = selectLandingTests(["src/launcher/workspace.ts"], []);
  assert.equal(dispatcher.kind, "related");
  if (dispatcher.kind === "related") {
    assert.ok(dispatcher.files.includes("tests/integration/dispatcher.test.ts"));
    for (const file of launcherProcessTests()) assert.ok(dispatcher.files.includes(file), file);
  }

  // Changing one command handler selects dispatcher + its own command callers, not unrelated CLI suites.
  const release = selectLandingTests(["src/launcher/release-commands.ts"], []);
  assert.equal(release.kind, "related");
  if (release.kind === "related") {
    assert.ok(release.files.includes("tests/integration/dispatcher.test.ts"));
    assert.ok(release.files.includes("tests/release/deploy-output.test.ts"));
    assert.ok(!release.files.includes("tests/workspace/workspace-adopt-selection.test.ts"));
  }

  // A launcher handler imported by another launcher handler (disk-command -> retention-commands) includes both.
  const disk = selectLandingTests(["src/launcher/disk-command.ts"], []);
  assert.equal(disk.kind, "related");
  if (disk.kind === "related") {
    assert.ok(disk.files.includes("tests/integration/dispatcher.test.ts"));
    assert.ok(disk.files.includes("tests/workspace/host-disk-command.test.ts"));
    assert.ok(disk.files.includes("tests/workspace/workspace-maintain-output.test.ts"));
  }

  // Changing a detached background launcher selects its spawner module and process tests without pulling unrelated CLI handlers.
  const refill = selectLandingTests(["src/launcher/spare-refill.ts"], []);
  assert.equal(refill.kind, "related");
  if (refill.kind === "related") {
    assert.ok(refill.files.includes("src/lib/workspace/workspace-spares.ts"));
    assert.ok(refill.files.includes("tests/integration/installed-package.test.ts"));
    assert.ok(refill.files.includes("tests/workspace/workspace-spare-dependencies-allocation.test.ts"));
    assert.ok(!refill.files.includes("tests/integration/dispatcher.test.ts"));
  }

  const library = selectLandingTests(["src/lib/runner/runner-log.ts"], []);
  if (library.kind === "related") assert.ok(!library.files.includes("tests/integration/dispatcher.test.ts"), "a library change does not run unrelated launcher tests");

  const root = mkdtempSync(path.join(tmpdir(), "launcher-callers-"));
  try {
    const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
    write("tests/direct.test.ts", 'const cli = new URL("../src/launcher/workspace.ts", import.meta.url);');
    write("tests/support/run.ts", 'export const cli = "../../src/launcher/workspace.ts";');
    write("tests/support/case.ts", 'export { cli } from "./run.ts";');
    write("tests/helped.test.ts", 'import { cli } from "./support/case.ts";');
    write("tests/library.test.ts", 'import { log } from "../src/lib/runner/runner-log.ts";');
    assert.deepEqual(launcherProcessTests(root), ["tests/direct.test.ts", "tests/helped.test.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  const withSource = selectLandingTests(["src/lib/workspace/workspace-paths.ts", deletedTest], [deletedTest]);
  assert.equal(withSource.kind, "related");
  if (withSource.kind === "related") {
    assert.ok(!withSource.files.includes(deletedTest));
    assert.ok(withSource.files.includes("src/lib/workspace/workspace-paths.ts"));
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

test("every process lane entry is a real test file with real src/ entries, and the lane keeps the CLI and installed package", () => {
  assert.equal(new Set(PROCESS_TESTS).size, PROCESS_TESTS.length, "no duplicate entries");
  for (const [file, entries] of Object.entries(PROCESS_TEST_ENTRIES)) {
    assert.match(file, /^tests\/.*\.test\.ts$/, file);
    assert.ok(existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.ok(entries.length > 0, `${file} names at least one src/ entry`);
    for (const entry of entries) {
      assert.match(entry, /^src\/.*\.ts$/, `${file} -> ${entry}`);
      assert.ok(existsSync(path.join(ROOT, entry)), `${file} -> ${entry} exists`);
    }
  }
  assert.ok(PROCESS_TESTS.includes("tests/integration/cli.test.ts"));
  assert.ok(PROCESS_TESTS.includes("tests/integration/installed-package.test.ts"));
});

test("Vitest's graph selects fixture reader and process callers, and honors quarantine", async () => {
  const { createVitest } = await import("vite-plus/test/node");
  const fixture = selectLandingTests(["tests/runner/fixtures/pipeline/landed.json"], []);
  const source = selectLandingTests(["src/lib/workspace/workspace-paths.ts"], []);
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
  const scratch = mkdtempSync(path.join(tmpdir(), "slipjay-landing-test-"));
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
    assert.deepEqual(manifest, { version: 1, selection: { kind: "related" }, reports: [
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

test("a scripts/ change selects only the tests that can observe it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "scripts-selection-"));
  try {
    const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
    write("vite.config.ts", 'const setup = new URL("./scripts/my-setup.ts", import.meta.url); export default { setupFiles: [setup] };');
    write("tests/named.test.ts", 'const sh = new URL("../scripts/named.sh", import.meta.url);');
    write("tests/support/run.ts", 'export const sh = "../../scripts/helped.sh";');
    write("tests/helped.test.ts", 'import { sh } from "./support/run.ts";');
    write("tests/lib.test.ts", 'import { lib } from "../scripts/lib.ts";');
    write("scripts/lib.ts", 'import { deep } from "./deep.ts"; export const lib = deep;');
    write("scripts/deep.ts", "export const deep = 1;");
    write("scripts/orphan.ts", "export const orphan = 1;");
    write("tests/joined.test.ts", 'const sh = join(root, "scripts", "joined.sh");');
    write("scripts/install-outer.sh", 'cp "$DIR/inner.sh" /usr/local/bin/');
    write("scripts/install-outermost.sh", 'bash "$DIR/install-outer.sh"');
    write("scripts/inner.sh", "echo inner");
    write("tests/outermost.test.ts", 'const sh = join(root, "scripts", "install-outermost.sh");');
    write("tests/unrelated.test.ts", 'const sh = join(root, "scripts", "other-inner.sh.bak");');
    write("src/mod.ts", 'export const path = "scripts/srcnamed.sh";');
    write("tests/mod.test.ts", 'import { path } from "../src/mod.ts";');
    const select = (file: string) => selectLandingTests([file], [], root);
    const related = (file: string) => { const plan = select(file); assert.equal(plan.kind, "related", file); return plan.kind === "related" ? plan.files : []; };

    // Infrastructure fails closed, including the setup file read from the vite config.
    for (const file of ["scripts/my-setup.ts", "scripts/hermetic-home-guard.ts", "scripts/with-hermetic-home.ts", "scripts/fixture-scratch.ts", "scripts/fixture-new-helper.ts", "scripts/test-landing.ts", "scripts/test-file-cost.ts"]) {
      const plan = select(file);
      assert.equal(plan.kind, "complete", file);
      if (plan.kind === "complete") assert.match(plan.reason, /infrastructure/);
    }
    assert.ok(infrastructureScripts(ROOT).test("scripts/vitest-hermetic-env.ts"), "the real config's setup file is derived");
    // The runtime lane always runs its own files, so a change to one selects no Vitest file.
    assert.equal(select(RUNTIME_TESTS.find((file) => !/test-landing|test-file-cost|with-hermetic-home|fixture-/.test(file))!).kind, "none");
    assert.equal(select("scripts/test-landing.test.ts").kind, "none");
    // Code that tests import follows the graph, including transitive imports.
    assert.deepEqual(related("scripts/lib.ts"), ["scripts/lib.ts", "tests/lib.test.ts"]);
    assert.deepEqual(related("scripts/deep.ts"), ["scripts/deep.ts", "tests/lib.test.ts"]);
    // A script named by path selects the tests that name it, directly or through a helper.
    assert.deepEqual(related("scripts/named.sh"), ["tests/named.test.ts"]);
    assert.deepEqual(related("scripts/helped.sh"), ["tests/helped.test.ts"]);
    // Tests join the path, so the basename is the name; a script that names another is reached through it, transitively.
    assert.deepEqual(related("scripts/joined.sh"), ["tests/joined.test.ts"]);
    assert.deepEqual(related("scripts/inner.sh"), ["tests/outermost.test.ts"]);
    // A script named by a src module selects that module's graph and the process tests.
    const viaSource = related("scripts/srcnamed.sh");
    assert.ok(viaSource.includes("src/mod.ts"));
    for (const file of PROCESS_TESTS) assert.ok(viaSource.includes(file), file);
    // Anything no rule maps, or that is not a runtime-lane test, runs the complete suite with its reason.
    for (const file of ["scripts/orphan.ts", "scripts/unknown.sh", "scripts/stray.test.ts"]) {
      const plan = select(file);
      assert.equal(plan.kind, "complete", file);
      if (plan.kind === "complete") assert.match(plan.reason, /no known dependency mapping/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real scripts that tests name select tests rather than the complete suite", () => {
  for (const file of ["scripts/setup-runner.sh", "scripts/install-release-watchdog.sh", "scripts/release-watchdog-probe.ts", "scripts/disk-rescue.sh"]) assert.equal(selectLandingTests([file], []).kind, "related", file);
});

test("the real scripts select every test that runs them, directly or through the script that installs them", () => {
  const files = (file: string) => { const plan = selectLandingTests([file], []); assert.equal(plan.kind, "related", file); return plan.kind === "related" ? plan.files : []; };
  const setup = files("scripts/setup-runner.sh");
  for (const test of ["tests/runner/setup-runner.test.ts", "tests/infra/disk-rescue.test.ts"]) assert.ok(setup.includes(test), test);
  assert.ok(files("scripts/disk-rescue.sh").includes("tests/infra/disk-rescue.test.ts"));
  assert.ok(files("scripts/install-disk-guard.sh").includes("tests/infra/disk-rescue.test.ts"));
  assert.ok(files("scripts/maintain.sh").includes("tests/workspace/disk-guard-installer.test.ts"));
  assert.ok(files("scripts/release-watchdog-probe.ts").includes("tests/infra/release-watchdog.test.ts"));
});

test("a test that reads every script's text is selected by any scripts/ change", () => {
  for (const file of ["scripts/check-architecture.ts", "scripts/release-watchdog-probe.ts"]) {
    const plan = selectLandingTests([file], []);
    assert.equal(plan.kind, "related", file);
    if (plan.kind === "related") assert.ok(plan.files.includes("tests/infra/test-config-guard.test.ts"), file);
  }
});
