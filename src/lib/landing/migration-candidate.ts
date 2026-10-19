import type { MigrationCommand, MigrationFinalizationPolicy } from "../policy/execution-policy.ts";
import type { LandingRevision } from "./landing-steps.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
export type MigrationRunPurpose = "migration_generate" | "migration_verify";

/** Late-bound migration source belongs to the shared, serialized landing path. */
import { runBoundedProcess, sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { migrationCommandFailure, redactMigrationOutput } from "./migration-command-evidence.ts";
import { checkoutCwd } from "../infra/checkout-cwd.ts";
import { commitIssue, githubRepository } from "../build/issue-references.ts";

const matches = (roots: string[], file: string): boolean => roots.some(root => file === root || file.startsWith(root + "/"));
const changedPaths = (summary: string): string[] => summary.split(/\r?\n/).filter(Boolean).map(line => line.replace(/^[A-Z?]\s+/, ""));

/** The paths between two commits that the late-bound migration step owns (trigger or artifact paths), and every changed path (none without a policy). */
export async function migrationPaths(cwd: string, policy: MigrationFinalizationPolicy | null, base: string, candidate: string,
  jj: (cwd: string, args: string[]) => Promise<string>): Promise<{ owned: string[]; changed: string[] }> {
  if (!policy) return { owned: [], changed: [] };
  const changed = changedPaths(await jj(cwd, ["diff", "--from", base, "--to", candidate, "--summary"]));
  return { owned: changed.filter(file => matches([...policy.triggerPaths, ...policy.artifactPaths], file)), changed };
}

/** Called in the runner's serial queue, before the final rebase and held
 * through generation, verification and integration by the caller. No second lease. */
export async function migrationCandidate(cwd: string, context: {
  current: { root: string }; integrationBranch: string;
  configuration: { remote?: string | null; migrationFinalization?: MigrationFinalizationPolicy | null };
}, io: {
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
}, options: {
  onProgress?: (line: string) => void;
  environment?: () => NodeJS.ProcessEnv;
  runCommand?: (request: BoundedProcessRequest, purpose?: MigrationRunPurpose) => Promise<BoundedProcessResult>;
} = {}): Promise<{
  finalize(candidate: LandingRevision, base: LandingRevision): Promise<LandingRevision>;
  rollback(): Promise<void>;
}> {
  // Parsed from the integration bookmark's committed policy (see execution-policy).
  const policy = context.configuration.migrationFinalization ?? null;
  let generated: { semantic: LandingRevision; originalWorkingCopy: LandingRevision; originalParents: string; finalized: LandingRevision | null; base: LandingRevision } | null = null;
  return {
    async finalize(candidate: LandingRevision, base: LandingRevision): Promise<LandingRevision> {
      if (!policy) return candidate;
      const { owned, changed: semanticPaths } = await migrationPaths(cwd, policy, base.commitId, candidate.commitId, io.jj);
      if (!owned.length) return candidate;
      if (semanticPaths.some(file => matches(policy.artifactPaths, file))) throw new Error("Late-bound migration artifacts must be generated during landing, not committed in the semantic candidate");
      const remote = context.configuration.remote ?? "origin";
      const remoteList = await io.jj(cwd, ["git", "remote", "list"]);
      // githubRepository normally falls back to another remote; provenance must not.
      const selectedRemote = remoteList.split(/\r?\n/).filter(line => line.trim().split(/\s+/)[0] === remote).join("\n");
      const repository = githubRepository(selectedRemote, remote);
      // LandingRevision carries only the title; trailers belong to the full immutable source description.
      const description = repository ? await io.jj(cwd, ["log", "-r", candidate.commitId, "--no-graph", "-T", "description"]) : null;
      const issue = repository ? commitIssue(description, repository) : null;
      // Bind the rebased semantic source before generation changes its commit ID.
      const migrationContext = JSON.stringify({
        version: 1, repository, baseCommit: base.commitId, candidateCommit: candidate.commitId,
        candidateChangeId: candidate.changeId,
        issueNumber: issue !== null && Number.isInteger(issue) && issue > 0 ? issue : null,
      });
      // The candidate may be @- below an empty child; generation must edit it.
      const originalWorkingCopy = await io.revisionFacts(cwd, "@");
      const originalParents = await io.jj(cwd, ["log", "-r", "parents(@)", "--no-graph", "-T", 'commit_id ++ "\\n"']);
      generated = { semantic: candidate, originalWorkingCopy, originalParents: originalParents.trim(), finalized: null, base };
      await io.jj(cwd, ["edit", candidate.changeId]);
      const run = async (declaration: MigrationCommand, purpose: MigrationRunPurpose): Promise<void> => {
        const commandRoot = await checkoutCwd(context.current.root, declaration.cwd, "Migration command");
        const environment = { ...(options.environment ?? sanitizedProcessEnv)(), SLIPJAY_MIGRATION_CONTEXT: migrationContext };
        options.onProgress?.(`[migration] ${redactMigrationOutput([declaration.executable, ...declaration.args].join(" "), context.current.root, { ...process.env, ...environment }).slice(0, 1000)}`);
        const runCommand: NonNullable<typeof options.runCommand> = options.runCommand ?? runBoundedProcess;
        const result = await runCommand({ ...declaration, cwd: commandRoot, timeoutMs: 3600000, maxOutputBytes: 65536, env: environment, redactOutput: value => redactMigrationOutput(value, context.current.root, { ...process.env, ...environment }) }, purpose);
        if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal || result.error)
          throw migrationCommandFailure([declaration.executable, ...declaration.args].join(" "), result, context.current.root, { ...process.env, ...environment });
      };
      try {
        await run(policy.generate, "migration_generate");
        await io.jj(cwd, ["status"]);
        await run(policy.verify, "migration_verify");
        const finalized = await io.revisionFacts(cwd, candidate.changeId);
        const resultPaths = changedPaths(await io.jj(cwd, ["diff", "--from", base.commitId, "--to", finalized.commitId, "--summary"]));
        if (!resultPaths.some(file => matches(policy.artifactPaths, file))) {
          // A trigger path changed without a schema change (for example a table moved
          // between modules): generation and verification passed and wrote nothing.
          if (finalized.commitId !== candidate.commitId) throw new Error("Migration generator changed source without producing declared artifacts");
          generated.finalized = finalized;
          return finalized;
        }
        const unexpected = resultPaths.filter(file => !semanticPaths.includes(file) && !matches(policy.artifactPaths, file));
        if (unexpected.length) throw new Error("Migration generation changed undeclared paths: " + unexpected.join(", "));
        generated.finalized = finalized;
        return finalized;
      } catch (error) {
        generated.finalized = await io.revisionFacts(cwd, candidate.changeId);
        throw error;
      }
    },
    async rollback() {
      if (!generated) return;
      const { semantic, finalized, originalWorkingCopy, originalParents } = generated;
      if ((await io.revisionFacts(cwd, context.integrationBranch)).commitId === finalized?.commitId) return;
      const current = await io.revisionFacts(cwd, semantic.changeId);
      if (!finalized || current.commitId !== finalized.commitId)
        throw new Error("Migration candidate changed after generation; preserve it for reconciliation");
      // Restore only this candidate's tree. Never rewind the shared JJ operation log.
      await io.jj(cwd, ["restore", "--from", semantic.commitId, "--into", semantic.changeId]);
      if (originalWorkingCopy.changeId !== semantic.changeId) {
        // Editing its parent abandons an empty child; its old change ID no
        // longer resolves. Restore the checkout shape without rewinding history.
        const retained = await io.jj(cwd, ["log", "-r", `present(${originalWorkingCopy.changeId})`, "--no-graph", "-T", "commit_id"]);
        if (retained) {
          // Rebase of the empty descendant may change its commit ID; its tree
          // must still be empty and its sole parent must be this candidate.
          const facts = await io.revisionFacts(cwd, originalWorkingCopy.changeId);
          if (facts.empty && originalWorkingCopy.empty) {
            const parents = await io.jj(cwd, ["log", "-r", `parents(${originalWorkingCopy.changeId})`, "--no-graph", "-T", 'commit_id ++ "\\n"']);
            if (parents.trim() !== (await io.revisionFacts(cwd, semantic.changeId)).commitId)
              throw new Error("Original migration checkout ancestry changed; preserve it for reconciliation");
          } else {
            if (facts.commitId !== originalWorkingCopy.commitId) throw new Error("Original migration checkout changed; preserve it for reconciliation");
          }
          await io.jj(cwd, ["edit", originalWorkingCopy.changeId]);
        } else {
          if (!originalWorkingCopy.empty || originalParents !== semantic.commitId)
            throw new Error("Original migration checkout cannot be safely recreated; preserve it for reconciliation");
          await io.jj(cwd, ["new", semantic.changeId]);
        }
      }
    }
  };
}
