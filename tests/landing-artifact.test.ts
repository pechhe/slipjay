import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { artifactBookmark, duplicateLandingSource, importLandingArtifact, retainLandingArtifact, retainLandingSource, RETAINED_ARTIFACT_REVISIONS } from "../src/lib/landing-artifact.ts";
import { publishIntegration } from "../src/lib/landing-steps.ts";
import { jj, project } from "./support/workspace-project.ts";

test("assembled prefix preserves every source-stack change in one exact-parent artifact", async () => {
  const f = await project();
  try {
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    await writeFile(join(f.repo, "first"), "first\n"); jj(f.repo, ["describe", "-m", "feat: first\n\nFeature details.\n\nIssue: pechhe/slipjay#59"]);
    jj(f.repo, ["new", "@", "-m", "fix: review feedback\n\nFix details."]);
    await writeFile(join(f.repo, "second"), "second\n");
    const source = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    await retainLandingSource(f.repo, "stack", 1, source);
    const candidate = await duplicateLandingSource(f.repo, source, "main");
    await retainLandingArtifact(f.repo, { operationId: "stack", attempt: 1, source, base, candidate });
    assert.equal(jj(f.repo, ["file", "show", "-r", candidate, "first"]), "first");
    assert.equal(jj(f.repo, ["file", "show", "-r", candidate, "second"]), "second");
    assert.equal(jj(f.repo, ["log", "-r", `${candidate}-`, "--no-graph", "-T", "commit_id"]), base);
    assert.equal(jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", "description"]),
      "feat: first\n\nFeature details.\n\nIssue: pechhe/slipjay#59\n\nfix: review feedback\n\nFix details.");
    assert.equal(jj(f.repo, ["file", "show", "-r", source, "first"]), "first", "original source remains recoverable");
  } finally { await f.dispose(); }
}, 120_000);

test("a private exact prefix survives slot reuse and independently imports into the publisher", async () => {
  const f = await project();
  try {
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    await writeFile(join(f.repo, "A"), "A\n");
    jj(f.repo, ["describe", "-m", "A"]);
    const candidate = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const artifact = { operationId: "A", attempt: 1, source: candidate, base, candidate };
    await retainLandingArtifact(f.repo, artifact);
    assert.ok(jj(f.repo, ["log", "-r", RETAINED_ARTIFACT_REVISIONS, "--no-graph", "-T", 'commit_id ++ "\\n"']).split("\n").includes(candidate));
    const publisher = join(f.root, "publisher");
    jj(f.root, ["git", "clone", f.remote, publisher]);
    await importLandingArtifact(publisher, f.repo, artifact);
    jj(f.repo, ["new", "main", "-m", "reused slot"]);
    // Even a later JJ rewrite of its visible bookmark cannot rewrite the raw attempt pin.
    jj(f.repo, ["rebase", "-r", candidate, "--onto", "@"]);
    jj(f.repo, ["git", "export"]);
    const laterConsumer = join(f.root, "later-consumer");
    jj(f.root, ["git", "clone", f.remote, laterConsumer]);
    await importLandingArtifact(laterConsumer, f.repo, artifact);
    assert.equal(jj(laterConsumer, ["log", "-r", artifactBookmark(artifact), "--no-graph", "-T", "commit_id"]), candidate);
    // GC/reopen cannot remove the consumer's own durable ref.
    execFileSync("git", ["--git-dir", jj(publisher, ["git", "root"]), "gc", "--prune=now"]);
    assert.equal(jj(publisher, ["log", "-r", artifactBookmark(artifact), "--no-graph", "-T", "commit_id"]), candidate);
    jj(publisher, ["new", candidate, "-m", "B"]);
    await writeFile(join(publisher, "B"), "B\n");
    const dependent = jj(publisher, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    await retainLandingArtifact(publisher, { operationId: "B", attempt: 1, source: dependent, base: candidate, candidate: dependent });
    assert.equal(jj(publisher, ["file", "show", "-r", dependent, "A"]), "A");
    await assert.rejects(retainLandingArtifact(publisher, { ...artifact, candidate: dependent }), /exact expected base/);
    await assert.rejects(retainLandingArtifact(publisher, { ...artifact, base: candidate, candidate: dependent }), /artifact was changed/);
    const refs = execFileSync("git", ["--git-dir", f.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim();
    assert.equal(refs, "refs/heads/main", "private retention never writes upstream");
  } finally { await f.dispose(); }
}, 120_000);

test("exact-parent publication rejects stale remote tracking even when the update would fast-forward", async () => {
  const f = await project();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
    const base = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    await writeFile(join(f.repo, "A"), "A\n"); jj(f.repo, ["describe", "-m", "A"]);
    const a = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["new", a, "-m", "B"]); await writeFile(join(f.repo, "B"), "B\n");
    const b = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", b]);
    git("--git-dir", jj(f.repo, ["git", "root"]), "push", f.remote, `${a}:refs/heads/main`);
    const stale = await publishIntegration(f.repo, "origin", "main", b, base);
    assert.equal(stale.ok, false);
    assert.equal(git("--git-dir", f.remote, "rev-parse", "main"), a);
    // A caller must explicitly adopt the new exact predecessor; a failed push never does it.
    const wrong = await publishIntegration(f.repo, "origin", "main", b, a);
    assert.equal(wrong.ok, false, "tracking still names the old expected parent");
    jj(f.repo, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    const published = await publishIntegration(f.repo, "origin", "main", b, a);
    assert.equal(published.ok, true);
    assert.equal(git("--git-dir", f.remote, "rev-parse", "main"), b);
  } finally { await f.dispose(); }
}, 120_000);

test("merge artifact retention requires its exact first parent and submitted side ancestry", async () => {
  const f = await project();
  try {
    const commit = (revision: string) => jj(f.repo, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);
    const base = commit("main");
    jj(f.repo, ["new", base, "-m", "Upstream"]);
    await writeFile(join(f.repo, "upstream"), "upstream\n");
    const upstream = commit("@");
    jj(f.repo, ["new", base, upstream, "-m", "Merge upstream"]);
    await writeFile(join(f.repo, "feature"), "feature\n");
    const source = commit("@");
    await retainLandingSource(f.repo, "merge", 1, source);
    const candidate = await duplicateLandingSource(f.repo, source, base);
    const artifact = { operationId: "merge", attempt: 1, source, base, candidate };
    await retainLandingArtifact(f.repo, artifact);
    assert.notEqual(candidate, source, "preparation leaves the original source immutable");
    assert.equal(jj(f.repo, ["diff", "--from", source, "--to", candidate, "--git"]), "");
    await assert.rejects(retainLandingArtifact(f.repo, { ...artifact, operationId: "wrong-first-parent", base: upstream }), /exact expected base/);
    jj(f.repo, ["new", base, "-m", "Unrelated"]);
    const unrelated = commit("@");
    jj(f.repo, ["new", base, unrelated, "-m", "Untrusted merge"]);
    await assert.rejects(retainLandingArtifact(f.repo, { ...artifact, operationId: "untrusted-parent", candidate: commit("@") }), /outside submitted source ancestry/);
    assert.equal(commit(source), source);
  } finally { await f.dispose(); }
}, 120_000);
