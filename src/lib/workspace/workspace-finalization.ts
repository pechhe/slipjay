import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { landedHome } from "./workspace-paths.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";

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
  const same = previous.workspaceName === state.workspaceName && previous.integrationRoot === state.integrationRoot
    && previous.artifactCommitId === state.artifactCommitId && previous.artifactChangeId === state.artifactChangeId
    && previous.integrationBranch === state.integrationBranch && previous.issueNumber === state.issueNumber;
  return same ? null : previous;
}

/** Retain proven landing evidence independently of the disposable working directory. */
export async function archiveIntegratedWorkspaceEvidence(gitDirectory: string, state: LandingArchiveInput): Promise<void> {
  if (await conflictingArchive(gitDirectory, state)) throw new Error("Archived integrated delivery identity changed");
  const file = await archivePath(gitDirectory, state.artifactCommitId);
  if (existsSync(file)) return;
  await mkdir(landedHome(), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(file, { ...state, phase: "landed" });
}
