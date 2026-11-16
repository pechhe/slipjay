import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { isUndescribed } from "../../src/lib/build/issue-references.ts";

test.each([
  ["", true], [" \n\t", true], ["Build: #1", true], ["Forge: #22\n", true],
  ["Issue: #3", true], ["Issue: owner/repo#4", true],
  ["\nBuild: #1\n\nForge: #2\nIssue: owner/repo#3\n", true],
  ["Subject\n\nBuild: #1", false], ["Build: #1\nBody", false],
  ["Signed-off-by: Person <person@example.com>", false], ["Fixes #1", false],
  ["Build: #oops", false], ["Issue: #1 extra", false], ["Forge: #1 and #2", false],
] as const)("undescribed status of %j is %s", (description, expected) => {
  assert.equal(isUndescribed(description), expected);
});
