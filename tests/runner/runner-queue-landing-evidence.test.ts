import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommandArtifact } from "../../src/lib/runner/command-artifact.ts";
import { COMMAND_ARTIFACT_PAGE_BYTES } from "../../src/lib/runner/runner-contract.ts";
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

test("a failed gate run keeps the logs it wrote under its report directory", async () => {
  const loggingGate = () => 'const fs=require("node:fs"),p=require("node:path"),d=process.env.SLIPJAY_TEST_REPORT_DIR;'
    + 'if(!d)process.exit(9);fs.mkdirSync(p.join(d,"logs","static"),{recursive:true});'
    + 'fs.writeFileSync(p.join(d,"logs","static","architecture.log"),"feature runtime cycle: a -> b -> a\\n");'
    + 'if(fs.existsSync("fail"))process.exit(1);';
  const f = await fixture(false, false, undefined, false, { prefixGate: loggingGate });
  try {
    const id = f.submit(await f.candidate("fail"));
    assert.equal((await f.land(id))?.type, "failed");
    const run = f.log.operation(id)!.runs.find((entry) => entry.purpose === "gate" && entry.exitCode === 1)!;
    assert.equal(run.artifact?.status, "retained");
    if (run.artifact?.status !== "retained") throw new Error("Expected retained command artifact");
    assert.deepEqual(run.artifact.logs, ["static/architecture.log"]);
    const artifact = JSON.parse(Buffer.from((await readCommandArtifact(f.home, id, run.runId, run.artifact, 0, COMMAND_ARTIFACT_PAGE_BYTES)).dataBase64, "base64").toString("utf8"));
    assert.deepEqual(artifact.logs.map((log: { path: string; text: string }) => [log.path, log.text]), [["static/architecture.log", "feature runtime cycle: a -> b -> a\n"]]);
  } finally { await f.dispose(); }
}, 120_000);
