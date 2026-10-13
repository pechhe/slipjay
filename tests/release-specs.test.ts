import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { commitIssue, halfBuiltSpecs } from "../src/lib/release-specs.ts";

const REPO = "owner/app";

type Parent = { number: number; title: string; state: "OPEN" | "CLOSED"; labels?: string[]; total: number; completed: number };
const parent = ({ number, title, state, labels = ["spec"], total, completed }: Parent) => ({
  number, title, url: `https://github.com/${REPO}/issues/${number}`, state,
  labels: { nodes: labels.map((name) => ({ name })) }, subIssuesSummary: { total, completed },
});

/** A GraphQL stub answering each queried Issue from `parents` (null means no such Issue). */
function github(parents: Record<number, ReturnType<typeof parent> | null | undefined>) {
  const queries: string[] = [];
  const graphql = async (query: string) => {
    queries.push(query);
    const numbers = [...query.matchAll(/i(\d+): issue/g)].map((match) => Number(match[1]));
    return { data: { repository: Object.fromEntries(numbers.map((number) =>
      [`i${number}`, parents[number] === null ? null : { parent: parents[number] ?? null }])) } };
  };
  return { graphql, queries };
}

test("a commit's Issue comes from its trailer for this repository, else a closing reference or (#N)", () => {
  assert.equal(commitIssue("Add a thing\n\nIssue: owner/app#12", REPO), 12);
  assert.equal(commitIssue("Add a thing\n\nIssue: #13", REPO), 13);
  assert.equal(commitIssue("Add a thing (#14)\n\nIssue: other/repo#99", REPO), 14);
  assert.equal(commitIssue("Fix it\n\nCloses #15", REPO), 15);
  assert.equal(commitIssue("Tidy up", REPO), null);
});

test("an open Spec with a Ticket in the range is reported with its Ticket progress", async () => {
  const spec = parent({ number: 10, title: "Build the CRM", state: "OPEN", total: 7, completed: 3 });
  const { graphql, queries } = github({ 11: spec, 12: spec });
  const result = await halfBuiltSpecs(REPO, ["Add records (#11)", "Add links\n\nIssue: owner/app#12", "Add records again (#11)"], { graphql });
  assert.deepEqual(result, { checked: true, specs: [{ number: 10, title: "Build the CRM", url: `https://github.com/${REPO}/issues/10`,
    closedTickets: 3, totalTickets: 7, summary: "#10 Build the CRM: 3 of 7 Tickets closed" }] });
  assert.equal(queries.length, 1);
  assert.equal([...String(queries[0]).matchAll(/: issue\(/g)].length, 2, "each Issue is looked up once");
});

test("closed Specs, Programmes, parentless Issues, unknown numbers and commits without Issues are not reported", async () => {
  const { graphql } = github({
    21: parent({ number: 20, title: "Done", state: "CLOSED", total: 2, completed: 2 }),
    31: parent({ number: 30, title: "Strategy", state: "OPEN", labels: ["programme"], total: 4, completed: 1 }),
    41: undefined,
    51: null,
  });
  const result = await halfBuiltSpecs(REPO, ["A (#21)", "B (#31)", "C (#41)", "D (#51)", "E without an Issue"], { graphql });
  assert.deepEqual(result, { checked: true, specs: [] });
});

test("a repository without a GitHub remote, or an unreachable GitHub, records that the check could not run", async () => {
  assert.deepEqual(await halfBuiltSpecs(null, ["A (#1)"]), { checked: false, reason: "the repository has no GitHub remote" });
  const failed = await halfBuiltSpecs(REPO, ["A (#1)"], { graphql: async () => { throw new Error("gh api graphql failed: HTTP 502"); } });
  assert.deepEqual(failed, { checked: false, reason: "could not check for half-built Specs: gh api graphql failed: HTTP 502" });
  const denied = await halfBuiltSpecs(REPO, ["A (#1)"], { graphql: async () => ({ errors: [{ message: "Bad credentials" }] }) });
  assert.deepEqual(denied, { checked: false, reason: "could not check for half-built Specs: Bad credentials" });
});
