import { join } from "node:path";

export const OP_STORE_WARN_BYTES: number = 5 * 1024 ** 3;
export type OperationStoreReport = { repository: string; path: string; sizeBytes: number | null; warning: string | null };

/** Read-only accounting. Abandoning operations rewrites even retained IDs and invalidates other workspaces. */
export async function operationStoreReports(roots: string[], sizeOf: (path: string) => Promise<number | null>): Promise<OperationStoreReport[]> {
  const reports: OperationStoreReport[] = [];
  for (const repository of [...new Set(roots)]) {
    const path = join(repository, ".jj", "repo", "op_store");
    const sizeBytes = await sizeOf(path);
    const warning = sizeBytes === null ? `WARNING: cannot measure JJ operation store for ${repository}`
      : sizeBytes >= OP_STORE_WARN_BYTES ? `WARNING: JJ operation store for ${repository} is ${(sizeBytes / 1024 ** 3).toFixed(1)} GiB (warning threshold 5 GiB); manual coordinated maintenance required` : null;
    reports.push({ repository, path, sizeBytes, warning });
  }
  return reports;
}
