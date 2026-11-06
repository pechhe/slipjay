import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import type { RunnerConfig } from "../../src/lib/runner/runner-types.ts";

const config = (places: unknown): RunnerConfig => ({ jj: { "user.name": "n", "user.email": "e@x" }, repos: {},
  machines: { "peach-box": { ssh: "peach-box", root: "/srv/slipjay-gate", account: "ubuntu", ...places === undefined ? {} : { places } } } } as RunnerConfig);

test("a machine's place count is a whole number from 1 to 8, and defaults to one", () => {
  for (const places of [undefined, 1, 3, 8]) assert.equal(runnerConfigProblem(config(places)), null, String(places));
  for (const places of [0, 9, 1.5, "3"]) assert.match(runnerConfigProblem(config(places)) ?? "", /"places" to a whole number from 1 to 8/, String(places));
});
