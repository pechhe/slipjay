import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { commitItem, isUndescribed, withoutItemTrailers } from "../../src/lib/build/issue-references.ts";

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

test.each([
  ["Subject\n\nBuild: #7", { tracker: "build", number: 7, repository: null }],
  ["Subject\n\nForge: #8", { tracker: "forge", number: 8, repository: null }],
  ["Subject\n\nIssue: owner/repo#9", { tracker: "github", number: 9, repository: "owner/repo" }],
  ["Subject (#10)\n\nFixes #11", null], ["Subject\n\nForge: #1 and #2", null], ["", null],
] as const)("the item a message's trailer names in %j is %j", (message, expected) => {
  assert.deepEqual(commitItem(message), expected);
});

test("a body without its item trailers keeps every other line", () => {
  assert.equal(withoutItemTrailers("Why.\n\nSigned-off-by: A <a@b>\nForge: #3\n"), "Why.\n\nSigned-off-by: A <a@b>");
});
