import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { landedHome } from "./workspace-paths.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { frozenAdoptions } from "./workspace-coverage.ts";
import { workspaceMetadata } from "./workspace-state.ts";
import { revisionExists, workspaceContext } from "../infra/workspace-jj.ts";

/** Landing identity retained outside the disposable checkout. */
export type LandingArchiveInput = {
  version: number;
  workspaceName: string;
  workspacePath: string;
  integrationBranch: string;
  artifactCommitId: string;
  /** Integration checkout used to identify the archived delivery. */
  integrationRoot?: string;
  /** JJ change identity compared when an archive already exists. */
  artifactChangeId?: string;
  /** Issue identity compared when an archive already exists. */
  issueNumber?: number;
  operationId?: string;
  /** Names this workspace had before a rename; an archive written under one is still its own. */
  previousWorkspaceNames?: string[];
  /**
   * The commit this workspace submitted, when its own landing delivered it. A landing that ran on a
   * runner archives only in the runner's state home, so recording the source here is what lets this
   * machine prove the delivery afterwards.
   */
  publishedSource?: string;
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const archivePath = async (gitDirectory: string, artifactCommitId: string): Promise<string> =>
  join(landedHome(), "artifact-" + digest([await realpath(gitDirectory), artifactCommitId]) + ".json");

/** The archive already retained for `state`'s artifact under a different delivery identity, if there is one. */
export async function conflictingArchive(gitDirectory: string, state: LandingArchiveInput): Promise<LandingArchiveInput | null> {
  let previous: LandingArchiveInput;
  try {
    previous = JSON.parse(await readFile(await archivePath(gitDirectory, state.artifactCommitId), "utf8")) as LandingArchiveInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  const sameWorkspace = previous.workspaceName === state.workspaceName || !!state.previousWorkspaceNames?.includes(previous.workspaceName);
  const same = sameWorkspace && previous.integrationRoot === state.integrationRoot
    && previous.artifactCommitId === state.artifactCommitId && previous.artifactChangeId === state.artifactChangeId
    && previous.integrationBranch === state.integrationBranch && previous.issueNumber === state.issueNumber;
  return same ? null : previous;
}

/** Retain proven landing evidence independently of the disposable working directory. */
export async function archiveIntegratedWorkspaceEvidence(gitDirectory: string, state: LandingArchiveInput): Promise<void> {
  if (await conflictingArchive(gitDirectory, state)) throw new Error("Archived integrated delivery identity changed");
  const file = await archivePath(gitDirectory, state.artifactCommitId);
  const metadata = await workspaceMetadata(state.workspaceName);
  const frozen = state.operationId ? Object.values(frozenAdoptions(metadata?.landingAdoptions)).find((item) => item.operationId === state.operationId) : undefined;
  const context = state.integrationRoot ? await workspaceContext(state.integrationRoot) : null;
  const remote = context?.configuration.remote;
  const published = context && await revisionExists(context.integration.root,
    `${state.artifactCommitId} & ::${state.integrationBranch}${remote ? `@${remote}` : ""}`);
  // A helper's frozen source proves the lead's ancestry; a workspace that landed its own commit names
  // that commit instead, so cleanup here can see what the runner's own archive recorded there.
  const source = frozen?.source ?? state.publishedSource;
  const owned = frozen ? metadata?.integrationRoot === state.integrationRoot : true;
  const provenance = source && published && owned ? {
    coverageRepository: await realpath(gitDirectory), publishedSource: source,
    ...frozen ? { adoptionCoverage: frozen.adoptions.map(({ workspaceName, base, revisions }) => ({ workspaceName, base, revisions })) } : {},
  } : undefined;
  if (existsSync(file) && !provenance) return;
  const previous = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> : {};
  await mkdir(landedHome(), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(file, { ...previous, ...state, phase: "landed", ...provenance });
}
