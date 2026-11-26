import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import type { RemoteVerification } from "../../../src/lib/runner/runner-types.ts";

/**
 * The fake check protocol both batch commands share: where the command records its environment (`batch-env.jsonl`)
 * and the report manifest it writes for the runner from `outcomes`.
 */
export const checkPrelude = (root: string) => `const fs=require("node:fs"), path=require("node:path"); const at=(name)=>path.join(${JSON.stringify(root)}, name);
const suites = process.env.SLIPJAY_RELEASE_SUITES ?? null;
fs.appendFileSync(at("batch-env.jsonl"), JSON.stringify({ base: process.env.SLIPJAY_RELEASE_BASE, head: process.env.SLIPJAY_RELEASE_HEAD, suites }) + "\\n");`;
export const checkReport = `const reports = process.env.SLIPJAY_TEST_REPORT_DIR;
if (reports) fs.writeFileSync(path.join(reports, "slipjay-test-reports.json"), JSON.stringify({ version: 1, reports: [], outcomes }));`;

/**
 * YardSmith's batch command in miniature: two independent suites fail when their respective break lands.
 * The workbench fails once while `flaky-once` exists. The command honors suite selection and records its environment.
 */
export const batchCheck = (root: string) => `${checkPrelude(root)}
let workbench = fs.existsSync("break-a");
if (fs.existsSync(at("flaky-once"))) { fs.rmSync(at("flaky-once")); workbench = true; }
const states = { workbench, yard: fs.existsSync("break-b") };
const outcomes = Object.entries(states).filter(([suite]) => !suites || suites.split(",").includes(suite))
  .map(([suite, broken]) => ({ suite, outcome: broken ? "failed" : "passed" }));
${checkReport}
for (const { suite, outcome } of outcomes) if (outcome === "failed") {
  process.stderr.write("FAIL tests/" + suite + ".test.ts > " + suite + " > " + (suite === "yard" ? "b" : "a") + " breaks\\n");
  if (suite === "yard") {
    for (let n = 0; n < 40; n++) process.stderr.write("FAIL tests/yard.test.ts > yard > case " + n + "\\n");
    process.stderr.write("x".repeat(5000) + "\\n");
  }
  process.exitCode = 1;
}`;

/** A remote verifier whose machine runs each command here, in the runner's own checkout, as a warm boat VM would. */
export function localRemote(): RemoteVerification {
  return {
    async open() {
      return { executor: { host: "boat:slipjay-fixture-repo-batch", run: runBoundedProcess }, machine: { verifier: "boat", id: "vm-1", name: "slipjay-fixture-repo-batch", size: "fixture", image: "fixture" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() {} };
    },
  };
}

/** The preemption tests hold a check open while more landings run git/jj, so each queue transition gets room on a busy runner. */
export const preemptionWaitMs = 120_000;
