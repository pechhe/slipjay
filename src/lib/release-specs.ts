/**
 * Half-built Specs in a release range: open parent Issues (not Programmes) of the
 * Issues the range's commits served. A release only warns about them; it never
 * refuses. Every failure to look them up becomes `{ checked: false, reason }`.
 */
import { runBoundedProcess } from "./bounded-process.ts";
import { originatingIssue } from "./post-land-issue.ts";

export type HalfBuiltSpec = {
  number: number;
  title: string;
  url: string;
  closedTickets: number;
  totalTickets: number;
  /** `#N Title: C of T Tickets closed`. */
  summary: string;
};

export type HalfBuiltSpecs =
  | { checked: true; specs: HalfBuiltSpec[] }
  | { checked: false; reason: string };

export type GraphqlRunner = (query: string) => Promise<unknown>;

const GH_TIMEOUT_MS = 60_000;
/** Issues looked up per GraphQL query. */
const BATCH = 100;

/** The parent Issue fields the parent query reads. */
type ParentIssue = {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: { nodes: { name: string }[] };
  subIssuesSummary: { total: number; completed: number };
};

/** The response shape of the parent query; each alias is one looked-up Issue. */
type ParentQueryResponse = {
  data?: { repository?: Record<string, { parent?: ParentIssue | null } | null> | null };
  errors?: { message: string }[];
};

/** The Issue a commit description served in `repository`: its `Issue:` trailer, else a closing reference or `(#N)`. */
export function commitIssue(description: string | null | undefined, repository: string | null): number | null {
  for (const match of (description ?? "").matchAll(/^Issue: ([\w.-]+\/[\w.-]+)?#(\d+)\s*$/gm)) {
    if (!match[1] || match[1] === repository) return Number(match[2]);
  }
  return originatingIssue(null, description);
}

/**
 * `gh api graphql` prints partial data with a non-zero exit when an aliased Issue
 * does not exist (for example a PR number), so the response, not the exit code,
 * decides. Injectable for tests.
 */
const ghGraphql = async (query: string): Promise<unknown> => {
  const result = await runBoundedProcess({ executable: "gh", args: ["api", "graphql", "-f", `query=${query}`],
    cwd: process.cwd(), timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    const detail = result.timedOut ? `timed out after ${GH_TIMEOUT_MS / 1000}s` : (result.stderr || result.stdout || result.signal || "no output").toString().trim();
    throw new Error(`gh api graphql failed: ${detail}`);
  }
};

const parentQuery = (repository: string, numbers: number[]): string => {
  const [owner, name] = repository.split("/");
  const issues = numbers.map((number) => `i${number}: issue(number: ${number}) { parent { number title url state `
    + "labels(first: 50) { nodes { name } } subIssuesSummary { total completed } } }").join(" ");
  return `{ repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${issues} } }`;
};

/**
 * The half-built Specs among `descriptions` (the release range's commit
 * descriptions) in GitHub `repository` (`owner/name`, or null without a GitHub remote).
 */
export async function halfBuiltSpecs(
  repository: string | null,
  descriptions: string[],
  { graphql = ghGraphql }: { graphql?: GraphqlRunner } = {},
): Promise<HalfBuiltSpecs> {
  if (!repository) return { checked: false, reason: "the repository has no GitHub remote" };
  const numbers = [...new Set(descriptions.map((description) => commitIssue(description, repository)).filter((number): number is number => Boolean(number)))];
  const specs = new Map<number, ParentIssue>();
  try {
    for (let start = 0; start < numbers.length; start += BATCH) {
      const response = await graphql(parentQuery(repository, numbers.slice(start, start + BATCH))) as ParentQueryResponse | null;
      const found = response?.data?.repository;
      if (!found) throw new Error(response?.errors?.map((error) => error.message).join("; ") || "no repository in the GitHub response");
      for (const issue of Object.values(found)) {
        const parent = issue?.parent;
        if (!parent || parent.state !== "OPEN" || parent.labels.nodes.some((label) => label.name === "programme")) continue;
        specs.set(parent.number, parent);
      }
    }
  } catch (error) {
    return { checked: false, reason: `could not check for half-built Specs: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    checked: true,
    specs: [...specs.values()].sort((a, b) => a.number - b.number).map((spec) => {
      const { total, completed } = spec.subIssuesSummary;
      return { number: spec.number, title: spec.title, url: spec.url, closedTickets: completed, totalTickets: total,
        summary: `#${spec.number} ${spec.title}: ${completed} of ${total} Tickets closed` };
    }),
  };
}
