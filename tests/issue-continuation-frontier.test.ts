import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { assertIssueEligible, selectImplementationIssue } from "../src/lib/issue-eligibility.ts";

test("Epic selection refreshes child readiness and dependency state on every transition", async () => {
  let landed = false;
  const commit = "a".repeat(40);
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return args[0] === "git" ? "origin https://github.com/owner/repo.git" : landed ? commit : "";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic"] }]);
    if (url.includes("/sub_issues") && !url.includes("/10/")) return "[[]]";
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: landed ? "closed" : "open", state_reason: landed ? "completed" : null }, { number: 12, state: "open" }]]);
    if (url.endsWith("issues/11")) return JSON.stringify([{ number: 11, state: landed ? "closed" : "open", labels: ["ready-for-agent"] }]);
    if (url.endsWith("issues/12")) return JSON.stringify([{ number: 12, state: "open", labels: ["ready-for-agent"] }]);
    if (url.includes("/dependencies/blocked_by")) return JSON.stringify([url.includes("/12/") ? [{ number: 11, state: landed ? "closed" : "open", state_reason: landed ? "completed" : null }] : []]);
    if (url.includes("/comments")) return JSON.stringify([[{ body: `Completed via Peach local integration.\nVerification: passed\nDelivery: local integration\nIntegrated commit: \`${commit}\`\n<!-- peach-local-completion:11:${commit} -->` }]]);
    throw new Error(url);
  };
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 11);
  await assert.rejects(selectImplementationIssue("/repo", 12, "main", run), /blocked/);
  landed = true;
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 12);
  assert.ok(calls.filter((call) => call.includes("issues/10/sub_issues")).length === 2);
});

test("no route or parent readiness admits a parked or unready child", async () => {
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic", "ready-for-agent"] }]);
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: "open" }]]);
    return JSON.stringify([{ number: 11, state: "open", labels: ["ready-for-agent", "someday"] }]);
  };
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => null), /not ready/);
});

test("canonical external blocker prevents unattended implementation", async () => {
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic"] }]);
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: "open" }]]);
    return JSON.stringify([{ number: 11, state: "open", labels: ["ready-for-agent", "blocked: external"] }]);
  };
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => null), /not ready/);
});

test("a coherent Epic with internal phases stays its own live delivery unit", async () => {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    if (args[1]!.includes("/sub_issues") || args[1]!.includes("/dependencies/")) return "[[]]";
    return JSON.stringify([{ number: 10, state: "open", labels: ["epic", "ready-for-agent"], body: "## Phase 1\n- [ ] Implement\n## Phase 2\n- [ ] Checkpoint and verify" }]);
  };
  for (let step = 0; step < 3; step++) assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 10);
  assert.ok(calls.every((call) => !call.includes("--method") && !call.includes("issues/11")));
});

function unblockedEpic() {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.includes("/dependencies/")) return "[[]]";
    if (url.includes("/sub_issues")) return JSON.stringify([url.includes("/10/") ? [
      { number: 11, state: "open" }, { number: 12, state: "open" },
    ] : []]);
    if (url.endsWith("issues/10")) return JSON.stringify([{
      number: 10, state: "open", labels: ["epic", "ready-for-agent"],
      body: '<!-- peach-route {"version":1,"preferredNext":[11],"parallelNow":[11,12],"futureAfter":[]} -->',
    }]);
    const number = Number(url.split("/").at(-1));
    return JSON.stringify([{ number, state: "open", labels: ["ready-for-agent"] }]);
  };
  return { run, calls };
}

test("Epic selection resumes an assigned child without needing an owner lease", async () => {
  const { run, calls } = unblockedEpic();
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async (number) => number === 12 ? { name: "repo-i12" } : null), 12);
  assert.ok(calls.every((call) => !/--method|workspace add/.test(call)), "selection allocates and publishes nothing");
});

test("Epic selection needs no ownership evidence but preserves assignment lookup failures", async () => {
  const { run } = unblockedEpic();
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run), 11);
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => { throw new Error("Workspace lookup unavailable"); }), /Workspace lookup unavailable/);
});

test("an explicit leaf still reaches owned-task recovery instead of sibling selection", async () => {
  const { run } = unblockedEpic();
  assert.equal(await selectImplementationIssue("/repo", 11, "main", run, async () => {
    assert.fail("A direct Issue request must use the existing recovery ownership boundary");
  }), 11);
});


test("not-planned prerequisites never become satisfied through an old commit receipt", async () => {
  const run = async (command: string) => command === "jj" ? "origin https://github.com/owner/repo.git" : JSON.stringify([[{ number: 11, state: "closed", state_reason: "not_planned" }]]);
  await assert.rejects(assertIssueEligible("/repo", 12, "main", run), /only completed delivery/);
});

test("a dependency closed as completed satisfies its dependents without a receipt", async () => {
  const run = async (command: string) => command === "jj" ? "origin https://github.com/owner/repo.git"
    : JSON.stringify([[{ number: 11, repository_url: "https://api.github.com/repos/owner/other", state: "closed", state_reason: "completed" }]]);
  await assertIssueEligible("/repo", 12, "main", run);
});
