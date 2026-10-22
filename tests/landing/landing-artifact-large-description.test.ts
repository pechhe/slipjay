import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { duplicateLandingSource } from "../../src/lib/landing/landing-artifact.ts";
import { jj, project } from "../support/workspace-project.ts";

/** One process argument cannot exceed 128 KiB on Linux; each description here is over half of that. */
const paragraph = (tag: string) => `${tag}\n\n${`${tag} line of a long retained description.\n`.repeat(2200)}`.trimEnd();
const commit = (cwd: string, revision: string) => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);
/** Descriptions this size cannot be given with -m either, so the test itself sends them on stdin. */
const describeFromStdin = (cwd: string, text: string) => execFileSync("jj", ["--color=never", "describe", "--stdin"], { cwd, input: text, encoding: "utf8" });

test("a stack whose first-parent descriptions together exceed one argument is assembled with every description intact", async () => {
  const f = await project();
  try {
    const first = paragraph("first");
    const second = paragraph("second");
    assert.ok(Buffer.byteLength(first + second) > 128 * 1024);
    await writeFile(join(f.repo, "first"), "first\n");
    describeFromStdin(f.repo, first);
    jj(f.repo, ["new", "@"]);
    await writeFile(join(f.repo, "second"), "second\n");
    describeFromStdin(f.repo, second);
    const source = commit(f.repo, "@");
    const candidate = await duplicateLandingSource(f.repo, source, "main");
    assert.equal(jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", "description"]), `${first}\n\n${second}`);
    assert.equal(jj(f.repo, ["file", "show", "-r", candidate, "second"]), "second");
    assert.equal(commit(f.repo, `${candidate}-`), commit(f.repo, "main"));
  } finally { await f.dispose(); }
}, 120_000);

test("a merge-bearing source whose first-parent descriptions exceed one argument is assembled on its first-parent line with the same parents", async () => {
  const f = await project();
  try {
    const base = commit(f.repo, "main");
    jj(f.repo, ["new", base, "-m", "Upstream"]);
    await writeFile(join(f.repo, "upstream"), "upstream\n");
    const upstream = commit(f.repo, "@");
    jj(f.repo, ["new", base]);
    await writeFile(join(f.repo, "feature"), "feature\n");
    const feature = paragraph("feature");
    describeFromStdin(f.repo, feature);
    jj(f.repo, ["new", "@", upstream]);
    await writeFile(join(f.repo, "merged"), "merged\n");
    const merge = paragraph("merge");
    describeFromStdin(f.repo, merge);
    const source = commit(f.repo, "@");
    assert.ok(Buffer.byteLength(feature + merge) > 128 * 1024);
    const candidate = await duplicateLandingSource(f.repo, source, base);
    assert.equal(jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", "description"]), `${feature}\n\n${merge}`);
    const parents = jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", 'parents.map(|parent| parent.commit_id()).join(" ")']).split(" ");
    assert.deepEqual(parents, [base, upstream], "the exact base stays the first parent and the upstream side is kept");
    assert.equal(jj(f.repo, ["diff", "--from", source, "--to", candidate, "--git"]), "", "the source's tree is kept");
  } finally { await f.dispose(); }
}, 120_000);
