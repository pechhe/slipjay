import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseTestReport, readRetainedLogs, readTestReports, TEST_REPORT_LOGS, TEST_REPORT_MANIFEST } from "../../src/lib/runner/test-reports.ts";

const junit = `<?xml version="1.0"?><testsuites><testsuite name="a.test.ts" file="a.test.ts" tests="2" failures="0" errors="0" skipped="0" time="0.25">`
  + `<testsuite name="nested" file="a.test.ts" tests="1" failures="1" time="0.1"></testsuite></testsuite>`
  + `<testsuite name="b.test.ts" file="b &amp; c.test.ts" tests="1" failures="0" errors="0" skipped="1" time="0"></testsuite></testsuites>`;

async function reportDir(write: (directory: string, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "test-reports-")));
  const directory = join(root, ".reports");
  await mkdir(directory);
  await write(directory, root);
  return { root, directory, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("parses Vitest JSON and Bun JUnit, counting a nested Bun suite once per file", () => {
  assert.deepEqual(parseTestReport(JSON.stringify({ testResults: [{ name: "/r/a.test.ts", startTime: 10, endTime: 760, status: "failed" }] }), "vitest-json"),
    [{ file: "/r/a.test.ts", ms: 750, status: "failed" }]);
  assert.deepEqual(parseTestReport(junit, "bun-junit"), [{ file: "a.test.ts", ms: 250, status: "passed" }, { file: "b & c.test.ts", ms: 0, status: "skipped" }]);
  // A writer stopped partway: every complete-looking prefix is partial, never a shorter run.
  for (const end of [junit.indexOf("<testsuite name=\"nested\""), junit.indexOf("<testsuite name=\"b.test.ts\""), junit.length - "</testsuites>".length]) {
    assert.throws(() => parseTestReport(junit.slice(0, end), "bun-junit"), /partial report/, String(end));
  }
});

test("reads every report a command listed, each relative to its own working directory", async () => {
  const fixture = await reportDir(async (directory, root) => {
    await writeFile(join(directory, "vitest.json"), JSON.stringify({ testResults: [{ name: join(root, "tests/x.test.ts"), startTime: 0, endTime: 40.4, status: "passed" }] }));
    await writeFile(join(directory, "junit.xml"), junit);
    await writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [
      { format: "vitest-json", path: "vitest.json", suite: "vitest", cwd: "." },
      { format: "bun-junit", path: "junit.xml", suite: "runtimes", cwd: "packages/tool" },
    ] }));
  });
  try {
    assert.deepEqual(await readTestReports(fixture.directory, fixture.root), { status: "recorded", files: [
      { file: "tests/x.test.ts", suite: "vitest", ms: 40, status: "passed" },
      { file: "packages/tool/a.test.ts", suite: "runtimes", ms: 250, status: "passed" },
      { file: "packages/tool/b & c.test.ts", suite: "runtimes", ms: 0, status: "skipped" },
    ] });
  } finally { await fixture.dispose(); }
});

test("no manifest is a missing report; a malformed or escaping one is malformed and keeps no rows", async () => {
  const cases: [string, (directory: string) => Promise<void>, RegExp | null][] = [
    ["none", async () => {}, null],
    ["bad json", (directory) => writeFile(join(directory, TEST_REPORT_MANIFEST), "{"), /JSON/],
    ["wrong version", (directory) => writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 2, reports: [] })), /version 1/],
    ["unknown format", (directory) => writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [{ format: "junit", path: "r", suite: "s" }] })), /unknown format/],
    ["escaping path", (directory) => writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [{ format: "vitest-json", path: "../outside.json", suite: "s" }] })), /leaves its directory/],
    ["missing report", (directory) => writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [{ format: "vitest-json", path: "absent.json", suite: "s" }] })), /ENOENT/],
    ["partial", async (directory) => {
      await writeFile(join(directory, "good.json"), JSON.stringify({ testResults: [{ name: "a.test.ts", startTime: 0, endTime: 5, status: "passed" }] }));
      await writeFile(join(directory, "bad.json"), JSON.stringify({ testResults: [{ name: "b.test.ts" }] }));
      await writeFile(join(directory, TEST_REPORT_MANIFEST), JSON.stringify({ version: 1, reports: [{ format: "vitest-json", path: "good.json", suite: "s" }, { format: "vitest-json", path: "bad.json", suite: "s" }] }));
    }, /lacks name, startTime or endTime/],
  ];
  for (const [name, write, reason] of cases) {
    const fixture = await reportDir((directory) => write(directory));
    try {
      const reading = await readTestReports(fixture.directory, fixture.root);
      if (!reason) assert.deepEqual(reading, { status: "missing" }, name);
      else {
        assert.equal(reading?.status, "malformed", name);
        assert.match(reading!.status === "malformed" ? reading!.reason : "", reason, name);
        assert.equal("files" in reading!, false, name);
      }
    } finally { await fixture.dispose(); }
  }
});

test("a manifest's optional selection is kept, and a kind the contract does not name is dropped", async () => {
  const manifest = (selection: unknown) => JSON.stringify({ version: 1, ...(selection === undefined ? {} : { selection }), reports: [{ format: "vitest-json", path: "vitest.json", suite: "vitest", cwd: "." }] });
  const cases: [string, unknown, string | undefined][] = [
    ["related", { kind: "related" }, "related"],
    ["complete", { kind: "complete" }, "complete"],
    ["none", { kind: "none" }, "none"],
    ["absent", undefined, undefined],
    ["unknown kind", { kind: "everything" }, undefined],
  ];
  for (const [name, selection, expected] of cases) {
    const fixture = await reportDir(async (directory, root) => {
      await writeFile(join(directory, "vitest.json"), JSON.stringify({ testResults: [{ name: join(root, "tests/x.test.ts"), startTime: 0, endTime: 5, status: "passed" }] }));
      await writeFile(join(directory, TEST_REPORT_MANIFEST), manifest(selection));
    });
    try {
      const reading = await readTestReports(fixture.directory, fixture.root);
      assert.equal(reading.status, "recorded", name);
      assert.deepEqual(reading.status === "recorded" ? reading.files : [], [{ file: "tests/x.test.ts", suite: "vitest", ms: 5, status: "passed" }], name);
      assert.equal(reading.status === "recorded" ? reading.selection : "missing", expected, name);
    } finally { await fixture.dispose(); }
  }
});

test("a run's logs are the regular files under logs/, in path order, a long one read from its end", async () => {
  const { directory, root, dispose } = await reportDir(async (directory, root) => {
    await mkdir(join(directory, TEST_REPORT_LOGS, "static"), { recursive: true });
    await writeFile(join(directory, TEST_REPORT_LOGS, "static", "architecture.log"), "private feature access\n");
    await writeFile(join(directory, TEST_REPORT_LOGS, "big.log"), `${"x".repeat(5 * 1024 * 1024)}\nlast line\n`);
    await writeFile(join(directory, TEST_REPORT_MANIFEST), "{}");
    await writeFile(join(root, "outside.log"), "not a log of this run");
    await symlink(join(root, "outside.log"), join(directory, TEST_REPORT_LOGS, "linked.log"));
  });
  try {
    const logs = await readRetainedLogs(directory);
    assert.deepEqual(logs.map(({ path, truncated }) => ({ path, truncated })), [{ path: "big.log", truncated: true }, { path: "static/architecture.log", truncated: false }]);
    assert.match(logs[0]!.content, /last line\n$/);
    assert.equal(logs[1]!.content, "private feature access\n");
    assert.deepEqual(await readRetainedLogs(join(root, "missing")), []);
  } finally { await dispose(); }
});
