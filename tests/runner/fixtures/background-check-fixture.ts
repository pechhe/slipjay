import { schedule } from "./automatic-promotion.ts";
import { checkPrelude, checkReport } from "./batch-check-fixture.ts";

/**
 * The batch command, in miniature: suite `workbench` fails while `break-a` is in the tree, and the check waits
 * while `hold` exists beside the fixture, so a test can catch it running.
 */
export const workbenchCheck = (root: string) => `${checkPrelude(root)}
const wait = Date.now() + 60000; while (fs.existsSync(at("hold")) && Date.now() < wait) { fs.writeFileSync(at("held"), ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); }
const broken = fs.existsSync("break-a");
const outcomes = [{ suite: "workbench", outcome: broken ? "failed" : "passed" }];
${checkReport}
if (broken) { process.stderr.write("FAIL tests/workbench.test.ts > workbench > a breaks\\n"); process.exit(1); }`;

/** As `workbenchCheck`, failing `workbench` once while `flaky-once` exists beside the fixture. */
export const flakyOnce = (root: string) => workbenchCheck(root).replace(`const broken = fs.existsSync("break-a");`,
  `let broken = fs.existsSync("break-a"); if (fs.existsSync(at("flaky-once"))) { fs.rmSync(at("flaky-once")); broken = true; }`);

/** Promotions every ten hours, so only the background interval checks anything during a test. */
export const tenHourSchedule = schedule(600);
export const MINUTE = 60_000;

/** As `workbenchCheck`, with a second suite, `ledger`, that `break-a` also breaks. */
export const twoSuites = (root: string) => workbenchCheck(root).replace(
  `const outcomes = [{ suite: "workbench", outcome: broken ? "failed" : "passed" }];`,
  `const outcomes = [{ suite: "workbench", outcome: broken ? "failed" : "passed" }, { suite: "ledger", outcome: broken ? "failed" : "passed" }];`);
