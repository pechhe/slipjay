import assert from "node:assert/strict";
import { createBuildCheckAccess } from "../../src/lib/build/build-check-access.ts";
import { fixture, test } from "./fixtures/runner-queue-fixture.ts";

test("command evidence records execution environments for gates, installs, migrations, finalization and resets", async () => {
  const buildChecks = createBuildCheckAccess();
  buildChecks.serve("http://127.0.0.1:1");
  const f = await fixture(true, false, undefined, true, {
    buildChecks,
    gates: () => ['if(process.env.FIXTURE_KEY!==undefined)process.exit(8);if(!process.env.SLIPJAY_TEST_REPORT_DIR)process.exit(9);'],
  });
  try {
    const policy = JSON.parse(f.remoteFile("slipjay.json"));
    policy.tracker = "forge";
    policy.postIntegration.environmentKeys = ["FIXTURE_KEY"];
    await f.seedMain({
      "slipjay.json": JSON.stringify(policy),
      "package.json": JSON.stringify({ name: "gate-environment-fixture", version: "1.0.0", packageManager: "npm" }),
      "package-lock.json": JSON.stringify({ name: "gate-environment-fixture", version: "1.0.0", lockfileVersion: 3,
        packages: { "": { name: "gate-environment-fixture", version: "1.0.0" } } }),
    });
    const id = f.submit(await f.candidate("schema/environment.ts"));
    const landed = await f.land(id);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    const reset = await f.land(f.submitReset());
    assert.equal(reset?.type, "reset", JSON.stringify(reset));

    const runs = f.log.events().flatMap(({ event }) => event.type === "run_started" ? [event] : []);
    assert.equal(runs.length, f.requestedEnvironments.length);
    for (const purpose of ["gate", "dependencies", "migration_generate", "migration_verify", "finalization", "reset"]) {
      assert.ok(runs.some((run) => run.purpose === purpose), `exercised ${purpose}`);
    }
    for (const [index, run] of runs.entries()) {
      assert.equal(run.commandEvidence?.status, "recorded");
      if (run.commandEvidence?.status !== "recorded") continue;
      const actual = f.requestedEnvironments[index]!;
      const names = Object.keys(actual.env).filter((key) => actual.env[key] !== undefined).sort();
      assert.deepEqual(run.commandEvidence.environmentNames, names, `${run.purpose}: evidence matches execution`);
      assert.ok(names.includes("PATH"));
      if (run.purpose === "finalization" || run.purpose === "reset") {
        assert.equal(actual.env.FIXTURE_KEY, "from-runner");
        assert.ok(names.includes("FIXTURE_KEY"), "private credential appears by name in evidence");
      } else {
        assert.equal(actual.env.FIXTURE_KEY, undefined);
        assert.ok(!names.includes("FIXTURE_KEY"), "runner secret is absent from execution and evidence");
        assert.ok(actual.env.TMPDIR);
      }
      if (run.purpose === "gate") assert.ok(names.includes("SLIPJAY_TEST_REPORT_DIR"));
      if (["gate", "migration_generate", "migration_verify"].includes(run.purpose!)) {
        assert.ok(names.includes("SLIPJAY_BUILD_READ_URL"));
        assert.ok(names.includes("SLIPJAY_BUILD_READ_TOKEN"));
      }
      if (run.purpose === "migration_generate" || run.purpose === "migration_verify") {
        assert.ok(names.includes("SLIPJAY_MIGRATION_CONTEXT"));
      }
    }
    const resets = (await f.lines("reset.jsonl")).map((line) => JSON.parse(line));
    assert.ok(resets.length > 0);
    assert.ok(resets.every((entry) => entry.key === "from-runner"), "reset process actually receives its credential");
  } finally { await f.dispose(); }
}, 120_000);
