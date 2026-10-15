import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { landingBypass, landingGuardDecision } from "../src/lib/landing-guard.ts";

const branches = ["master"];

test("commands that publish or move the integration branch are refused", () => {
  for (const line of [
    "git push",
    "git push origin",
    "git push origin master",
    "git push origin HEAD:refs/heads/master",
    "git -C ../repo push --force origin +master",
    "git push --all origin",
    "jj git push",
    "jj --repository ../repo git push",
    "jj git push --tracked",
    "jj git push -b master",
    "jj git push --bookmark=master",
    "jj bookmark set master -r @",
    "jj b s master -r @-",
    "jj bookmark move master --to @",
    "git update-ref refs/heads/master HEAD",
    "git branch -f master HEAD",
    "gh pr merge 12 --squash",
    "cd ../repo && git push",
    "FOO=1 jj git push",
    "echo $(git push)",
    "bun run check; jj git push",
  ]) assert.ok(landingBypass(line, branches), line);
});

test("ordinary work and feature-branch publication are allowed", () => {
  for (const line of [
    "git status",
    "git log --oneline master",
    "jj new master",
    "jj rebase -d master",
    "jj describe -m 'git push later'",
    "echo \"jj git push\"",
    "git push origin feature/login",
    "jj git push -b feature/login",
    "jj git push -c @-",
    "jj bookmark set feature/login -r @",
    "jj bookmark list",
    "peach-workspace land",
    "slipjay land",
    "gh pr create --fill",
    "gh pr view 12",
  ]) assert.equal(landingBypass(line, branches), null, line);
});

test("slipjay.json governs the guard and the retired path beside it is ignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipjay-landing-guard-"));
  try {
    const neutral = path.join(root, "neutral");
    const both = path.join(root, "both");
    await mkdir(neutral, { recursive: true });
    await mkdir(both, { recursive: true });
    await writeFile(path.join(neutral, "slipjay.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    await writeFile(path.join(both, "slipjay.json"), JSON.stringify({ version: 1, integrationBranch: "trunk" }));
    await writeFile(path.join(both, "slipway.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (cwd: string, branch: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command: `jj git push -b ${branch}` } });
    assert.equal((await push(neutral, "develop"))?.hookSpecificOutput.permissionDecision, "deny");
    assert.equal((await push(both, "trunk"))?.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(await push(both, "develop"), null, "the retired file is ignored once slipjay.json exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declared release branch moves only through slipjay promote", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipjay-landing-guard-"));
  try {
    await writeFile(path.join(root, "slipjay.json"), JSON.stringify({
      version: 1, integrationBranch: "develop", releaseBranch: "master", requiredReleaseVerification: [] }));
    const decide = (command: string) => landingGuardDecision({ tool_name: "Bash", cwd: root, tool_input: { command } });
    for (const command of ["jj git push -b master", "jj bookmark set master -r @", "git push origin develop:master"]) {
      assert.match((await decide(command))?.hookSpecificOutput.permissionDecisionReason ?? "", /slipjay promote/, command);
    }
    assert.match((await decide("jj git push -b develop"))?.hookSpecificOutput.permissionDecisionReason ?? "", /slipjay land/);
    assert.equal(await decide("jj git push -b feature"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the former filename does not declare guarded branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipjay-landing-guard-retired-"));
  try {
    await writeFile(path.join(root, "slipway.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (branch: string) => landingGuardDecision({ tool_name: "Bash", cwd: root, tool_input: { command: `jj git push -b ${branch}` } });
    for (const branch of ["develop", "main", "master"]) {
      assert.equal(await push(branch), null, "only slipjay.json declares governance");
    }
    assert.equal(await push("feature"), null, "feature bookmarks stay pushable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hook decision applies only to Bash in a governed repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipjay-landing-guard-"));
  try {
    const governed = path.join(root, "governed", "nested");
    await mkdir(governed, { recursive: true });
    await writeFile(path.join(root, "governed", "slipjay.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (cwd: string, command: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command } });
    const denied = await push(governed, "jj git push -b develop");
    assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied!.hookSpecificOutput.permissionDecisionReason, /slipjay land/);
    assert.equal(await push(governed, "jj git push -b master"), null, "only the declared integration branch is guarded");
    assert.equal(await push(root, "git push"), null, "an ungoverned repository is untouched");
    assert.equal(await landingGuardDecision({ tool_name: "Read", cwd: governed, tool_input: { file_path: "x" } }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git -C and jj -R are judged by the repository they target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipjay-landing-guard-target-"));
  try {
    const governed = path.join(root, "governed");
    const plain = path.join(root, "plain");
    await mkdir(governed, { recursive: true });
    await mkdir(plain, { recursive: true });
    await writeFile(path.join(governed, "slipjay.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const denied = async (cwd: string, command: string) =>
      (await landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command } }))?.hookSpecificOutput.permissionDecision === "deny";

    for (const command of [
      `git -C ${plain} push`,
      "git -C ../plain push origin develop",
      `jj -R ${plain} git push`,
      "jj --repository=../plain git push",
      `git -c core.x=y -C ${plain} push`,
    ]) assert.equal(await denied(governed, command), false, `ungoverned target: ${command}`);

    for (const command of [
      `git -C ${governed} push`,
      `git -C ${plain} -C ../governed push`,
      `jj -R ${governed} git push`,
      `git -C ${plain} status && git push`,
      `cd ${plain} && git push`,
      `git -C ${root}/$X/governed push origin develop`,
      `git -C ${root}/g?verned push origin develop`,
      `git -C ${plain} --git-dir=${governed}/.git push origin develop`,
      `git -C ${plain} --git-dir ${governed}/.git push origin develop`,
      `GIT_DIR=${governed}/.git git -C ${plain} push origin develop`,
      `GIT_COMMON_DIR=${governed}/.git git -C ${plain} push origin develop`,
      `. ./env.sh && git -C ${plain} push origin develop`,
      `git -C ${governed}>/dev/null push origin develop`,
      `git -C ${governed}<-> push origin develop`,
    ]) assert.equal(await denied(governed, command), true, `governed or unknown target: ${command}`);

    for (const command of [`jj git push -R ${governed} -b develop`, `jj -R${governed} git push -b develop`]) {
      assert.equal(await denied(plain, command), true, `jj -R anywhere: ${command}`);
    }
    for (const command of [`jj git push -b develop -R ${plain}`, `jj -R${plain} git push`]) {
      assert.equal(await denied(governed, command), false, `jj -R anywhere: ${command}`);
    }

    assert.equal(await denied(plain, `git -C ${governed} push origin develop`), true, "a governed target is guarded from an ungoverned cwd");
    assert.equal(await denied(plain, `git -C ${governed} push origin feature`), false, "feature branches stay pushable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
