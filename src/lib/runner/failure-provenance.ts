import type { ExecutionPolicy } from "../policy/execution-policy.ts";
import type { CommandEvidence, FailureProvenance, OperationEvent, StoredEvent } from "./runner-types.ts";
import { jj, run } from "../infra/workspace-jj.ts";
import { matchesMigrationRoot } from "../landing/migration-candidate.ts";

type Unavailable = { unavailable: string };
const unavailable = (reason: string): Unavailable => ({ unavailable: reason.slice(0, 300) });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const boundedPaths = (paths: string[], count: number) => {
  const sorted = [...new Set(paths)].sort();
  const kept = sorted.filter(path => path.length <= 500).slice(0, count);
  return { paths: kept, ...kept.length < sorted.length ? { truncated: true as const } : {} };
};

/** Read immutable VCS objects only. Call once at failure; receipts never call this reader. */
export async function failureProvenance(input: {
  checkout: string; checked?: { candidate: string; base: string }; policy?: Pick<ExecutionPolicy, "migrationFinalization" | "provenance">;
  runtime?: CommandEvidence;
}): Promise<FailureProvenance> {
  const recorded = input.runtime?.status === "recorded" ? input.runtime.runtime : undefined;
  // Forge's schema bounds: a 64-hex sha256 and a name and version of at most 100 characters each.
  const runtime = recorded && /^[a-f0-9]{64}$/.test(recorded.sha256) && recorded.name.length && recorded.name.length <= 100 && recorded.version.length && recorded.version.length <= 100
    ? { name: recorded.name, version: recorded.version, sha256: recorded.sha256 }
    : unavailable(input.runtime ? "the failing run recorded no runtime identity" : "the failure has no recorded run");
  const result: FailureProvenance = {
    migrations: unavailable("the failure has no checked candidate"), toolchain: { runtime, lockfiles: [] },
    fixture: unavailable(input.policy?.provenance ? "the failure has no checked candidate" : "the repository declares no provenance.fixturePaths"),
  };
  if (!input.checked) return result;
  const { candidate, base } = input.checked;
  try {
    if (!objectId.test(candidate) || !objectId.test(base)) throw new Error("the checked candidate or base is not an exact object id");
    const gitDirectory = await jj(input.checkout, ["--ignore-working-copy", "git", "root"]);
    const git = async (args: string[]) => {
      const answer = await run("git", ["--git-dir", gitDirectory, "--literal-pathspecs", ...args], { cwd: input.checkout });
      if (answer.code !== 0 || answer.truncated) throw new Error("the checked commit's objects could not be read completely");
      return answer.stdout;
    };
    const roots = [...input.policy?.migrationFinalization?.triggerPaths ?? [], ...input.policy?.migrationFinalization?.artifactPaths ?? []];
    if (!roots.length) result.migrations = unavailable("the repository declares no migrationFinalization paths");
    else {
      try {
        const changed = (await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, candidate, "--"])).split("\0").filter(Boolean);
        result.migrations = boundedPaths(changed.filter(path => matchesMigrationRoot(roots, path)), 100);
      } catch { result.migrations = unavailable("the checked candidate's migration diff could not be read"); }
    }
    const entries = async (paths: string[]) => (await git(["ls-tree", "-z", candidate, "--", ...paths])).split("\0").filter(Boolean).map(row => {
      const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]*)$/.exec(row);
      if (!match || !objectId.test(match[3]!)) throw new Error("the checked commit contains an unsupported object id");
      return { kind: match[2]!, id: match[3]!, path: match[4]! };
    });
    result.toolchain.lockfiles = (await entries(lockfiles)).filter(entry => entry.kind === "blob" && lockfiles.includes(entry.path))
      .map(entry => ({ path: entry.path, blob: entry.id })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(0, 10);
    if (input.policy?.provenance) {
      const paths = boundedPaths(input.policy.provenance.fixturePaths, 50);
      // Read each literal path separately: a parent directory and its child can
      // both be declared, and ls-tree path filtering must not collapse either.
      const found = (await Promise.all(paths.paths.map(async path => (await entries([path])).find(entry => entry.path === path))))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      result.fixture = found.length === paths.paths.length
        ? { paths: found.map(entry => ({ path: entry.path, tree: entry.id })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), ...paths.truncated ? { truncated: true } : {} }
        : unavailable("a declared provenance.fixturePaths path is absent from the checked commit");
    }
  } catch {
    result.migrations = unavailable("the checked commit's objects could not be read");
    if (input.policy?.provenance) result.fixture = unavailable("the checked commit's fixture objects could not be read");
  }
  return result;
}

/** Recovered failures reuse the exact prepared candidate and recorded command, never submitted or moving revisions. */
export function provenanceSource(events: readonly StoredEvent[], failure: Extract<OperationEvent, { type: "failed" }>) {
  const prepared = events.findLast(row => row.event.type === "attempt_prepared" || row.event.type === "verification_base")?.event;
  const checked = prepared && (prepared.type === "attempt_prepared" || prepared.type === "verification_base") && prepared.candidate
    ? { candidate: prepared.candidate, base: prepared.base } : undefined;
  const runs = events.filter(row => row.event.type === "run_started");
  const run = runs.findLast(row => row.event.type === "run_started" && row.event.command === failure.command) ?? runs.at(-1);
  return { checked, runtime: run?.event.type === "run_started" ? run.event.commandEvidence : undefined };
}
