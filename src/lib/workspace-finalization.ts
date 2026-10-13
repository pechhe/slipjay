import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { landedHome } from "./workspace-paths.ts";
import { writeWorkspaceJson } from "./workspace-transaction.ts";

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

/** Retain proven landing evidence independently of the disposable working directory. */
export async function archiveIntegratedWorkspaceEvidence(gitDirectory: string, state: LandingArchiveInput): Promise<void> {
  const artifactDirectory = landedHome();
  const file = join(artifactDirectory, "artifact-" + digest([await realpath(gitDirectory), state.artifactCommitId]) + ".json");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(file, "utf8")) as LandingArchiveInput;
    if (previous.workspaceName !== state.workspaceName || previous.integrationRoot !== state.integrationRoot
      || previous.artifactCommitId !== state.artifactCommitId || previous.artifactChangeId !== state.artifactChangeId
      || previous.integrationBranch !== state.integrationBranch || previous.issueNumber !== state.issueNumber) {
      throw new Error("Archived integrated delivery identity changed");
    }
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  await writeWorkspaceJson(file, { ...state, phase: "landed" });
}
