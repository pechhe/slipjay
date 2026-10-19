import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { generatedPathMatchers } from "../../src/lib/policy/execution-policy.ts";

const covers = (declared: string[], path: string) => generatedPathMatchers(declared).some((matcher) => matcher.test(`${path}/`));

test("declared generated paths cover their subtree with segment-bounded globs", () => {
  assert.equal(covers(["apps/*/src/paraglide"], "apps/web/src/paraglide"), true);
  assert.equal(covers(["apps/*/src/paraglide"], "apps/web/nested/src/paraglide"), false);
  assert.equal(covers(["**/cache"], "packages/l10n/project.inlang/cache"), true);
  assert.equal(covers([".tool/diagnostics/**"], ".tool/diagnostics"), true);
  assert.equal(covers(["project.inlang/.meta.json"], "project.inlang/.meta.jsonx"), false);
  assert.equal(covers(["a.b"], "aXb"), false);
  assert.deepEqual(generatedPathMatchers(undefined), []);
});

test("invalid generated path declarations fail closed", () => {
  for (const invalid of [["/abs"], ["../up"], ["a/../b"], ["a//b"], ["./a"], [""], ["a\\b"], ["a**"], ["**"], ["*/**"], [7]]) {
    assert.throws(() => generatedPathMatchers(invalid), /generatedPaths entry/, JSON.stringify(invalid));
  }
  assert.throws(() => generatedPathMatchers("apps"), /must be an array/);
});

test("a retained workspace explains which files keep it and how to release it", async () => {
  const { describeRetention } = await import("../../src/lib/workspace/workspace-lifecycle.ts");
  const text = describeRetention({ reason: "unique-files", paths: ["secret.env", "gen/a.js"] });
  assert.match(text, /secret\.env, gen\/a\.js/);
  assert.match(text, /generatedPaths/);
  assert.equal(describeRetention({ reason: "not-published" }), "not-published");
});
