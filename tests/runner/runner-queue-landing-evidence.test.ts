import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, test, fixture } from "./fixtures/runner-queue-fixture.ts";

test("gate commands get a temporary directory of their own checkout, emptied at each turn", async () => {
  const f = await fixture(false, true);
  try {
    for (const file of ["a.txt", "b.txt"]) {
      assert.equal((await f.land(f.submit(await f.candidate(file))))?.type, "landed");
      const outcome = await f.land(f.submitRelease(f.main()));
      assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    }
    const turns = (await f.lines("release-tmp.jsonl")).map((line) => JSON.parse(line) as { tmp: string; stale: boolean });
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.tmp, turns[1]!.tmp);
    assert.notEqual(turns[0]!.tmp, tmpdir());
    assert.deepEqual(turns.map((turn) => turn.stale), [false, false]);
  } finally { await f.dispose(); }
}, 120_000);

test("a gate run's test reports become per-file rows, a missing or malformed one is recorded as such, and each stage records runner health", async () => {
  const reportingGate = () => 'const fs=require("node:fs"),p=require("node:path"),d=process.env.SLIPJAY_TEST_REPORT_DIR;'
    + 'if(!d)process.exit(9);'
    + 'if(fs.existsSync("report")){fs.writeFileSync(p.join(d,"v.json"),JSON.stringify({testResults:[{name:p.resolve("tests/a.test.ts"),startTime:0,endTime:120,status:"passed"}]}));'
    + 'fs.writeFileSync(p.join(d,"slipjay-test-reports.json"),JSON.stringify({version:1,reports:[{format:"vitest-json",path:"v.json",suite:"vitest",cwd:"."}]}));}'
    + 'if(fs.existsSync("bad-report"))fs.writeFileSync(p.join(d,"slipjay-test-reports.json"),"{");';
  const f = await fixture(false, false, undefined, false, { prefixGate: reportingGate });
  try {
    const reports = (id: string) => f.log.events({ operationId: id }).flatMap((row) => row.event.type === "test_report" ? [row.event] : []);
    // Each candidate builds on the last, so the files that make reports are added in this order.
    const silent = f.submit(await f.candidate("plain.txt"));
    assert.equal((await f.land(silent))?.type, "landed");
    assert.deepEqual(reports(silent).map((report) => report.status), ["missing"], "a gate that writes no report is recorded as missing");
    const reported = f.submit(await f.candidate("report"));
    assert.equal((await f.land(reported))?.type, "landed");
    assert.deepEqual(reports(reported).map(({ status, ...rest }) => [status, "files" in rest ? rest.files : []]),
      [["recorded", [{ file: "tests/a.test.ts", suite: "vitest", ms: 120, status: "passed" }]]]);
    const operation = f.log.operation(reported)!;
    assert.equal(operation.runs.find((run) => run.testReport)?.testReport?.status, "recorded");
    assert.ok(operation.startedAt && operation.startedAt >= operation.submittedAt);
    const stages = f.log.events({ operationId: reported }).flatMap((row) => row.event.type === "stage" ? [row.event] : []);
    assert.ok(stages.length && stages.every((stage) => stage.health && stage.health.cpus > 0 && stage.health.totalMemoryBytes > 0 && stage.health.running >= 1));

    const malformed = f.submit(await f.candidate("bad-report"));
    assert.equal((await f.land(malformed))?.type, "landed", "a malformed report never fails the gate");
    assert.deepEqual(reports(malformed).map((report) => report.status), ["malformed"]);

  } finally { await f.dispose(); }
}, 120_000);
