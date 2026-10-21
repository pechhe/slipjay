import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { jj, workspaceUnintegratedRevset } from "../infra/workspace-jj.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { landedHome, metadataHome } from "./workspace-paths.ts";

/** Original helper identities, independent of the lead's rewritten content. */
export type Adoption = { workspaceName: string; base: string; revisions: string[]; adoptedCommit?: string };
export type FrozenAdoption = { source: string; adoptions: Adoption[]; operationId?: string };
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function adoptions(value: unknown): Adoption[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Adoption => Boolean(item && typeof item.workspaceName === "string"
    && revision(item.base) && Array.isArray(item.revisions) && item.revisions.length > 0 && item.revisions.every(revision)));
}

export function frozenAdoptions(value: unknown): Record<string, FrozenAdoption> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, FrozenAdoption] => {
    const item = entry[1] as Partial<FrozenAdoption> | null;
    return Boolean(item && revision(item.source) && Array.isArray(item.adoptions)
      && adoptions(item.adoptions).length === item.adoptions.length
      && (item.operationId === undefined || typeof item.operationId === "string"));
  }));
}

/** Publication evidence shared by coverage and later submission freezes. */
export async function publishedLandingArchives(context: WorkspaceContext): Promise<Record<string, unknown>[]> {
  const repository = await realpath(await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]));
  const records: Record<string, unknown>[] = [];
  for (const file of await readdir(landedHome()).catch(() => [])) {
    if (!file.startsWith("artifact-") || !file.endsWith(".json")) continue;
    const record = await readFile(join(landedHome(), file), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    if (record?.coverageRepository !== repository && record?.adoptionRepository !== repository) continue;
    records.push(record!);
  }
  return records;
}

/**
 * Only repository-scoped published archives prove delivery; helpers in a handoff never do.
 * `covered` includes exact adoption evidence; `source-covered` alone grants no Issue exemption.
 */
export async function workspaceCoverage(context: WorkspaceContext, workspaceName: string, tip = "@", cwd = context.current.root): Promise<"covered" | "source-covered" | "pending" | "uncovered" | "integrated"> {
  const unintegrated = workspaceUnintegratedRevset(context.integrationBranch, tip);
  const revisions = (await jj(cwd, ["--ignore-working-copy", "log", "-r", unintegrated, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
  if (!revisions.length) return "integrated";
  const covered = new Set<string>();
  const sources = new Set<string>();
  for (const record of await publishedLandingArchives(context)) {
    if (revision(record.publishedSource)) sources.add(record.publishedSource);
    for (const adoption of adoptions(record.adoptionCoverage)) {
      if (adoption.workspaceName !== workspaceName) continue;
      for (const commit of adoption.revisions) covered.add(commit);
    }
  }
  const adopted = new Set(covered);
  if (sources.size) {
    // A published source proves its complete ancestry, including review/verify
    // workspaces based on it. Helper branches still require exact adoption coverage.
    const inherited = await jj(cwd, ["--ignore-working-copy", "log", "-r",
      `(${unintegrated}) & ::(${[...sources].join(" | ")})`,
      "--no-graph", "-T", 'commit_id ++ "\\n"']);
    for (const commit of inherited.split("\n").filter(Boolean)) covered.add(commit);
  }
  if (revisions.every((commit) => covered.has(commit))) return revisions.some((commit) => adopted.has(commit)) ? "covered" : "source-covered";
  for (const file of await readdir(metadataHome()).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const record = await readFile(join(metadataHome(), file), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    if (record?.integrationRoot !== context.integration.root) continue;
    const pending = [...adoptions(record.adoptions), ...Object.values(frozenAdoptions(record.landingAdoptions)).flatMap((item) => item.adoptions)];
    if (pending.some((item) => item.workspaceName === workspaceName && item.revisions.some((commit) => revisions.includes(commit) && !covered.has(commit)))) return "pending";
  }
  return "uncovered";
}
