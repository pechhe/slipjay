import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { sanitizedProcessEnv } from "../infra/bounded-process.ts";
import type { RuntimeIdentity } from "./runner-types.ts";

const versionOf = (binary: string, env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile(binary, ["--version"], { env, timeout: 5_000, maxBuffer: 1024 }, (error, stdout) => {
    if (error) reject(new Error(`Could not probe Bun runtime ${binary}: ${error.message}`));
    else resolve(stdout.trim());
  });
});

async function globalBun(path: string | undefined): Promise<string | undefined> {
  for (const directory of (path ?? "").split(delimiter).filter(Boolean)) {
    const binary = join(directory, "bun");
    if (await access(binary, constants.X_OK).then(() => true, () => false)) return binary;
  }
}

/**
 * Select only an already installed, exact Bun version. Provisioning belongs to the
 * runner owner, never to a candidate's packageManager declaration. The global
 * executable remains unchanged, including for other operations already running.
 */
export async function candidateBun(root: string, env: NodeJS.ProcessEnv | undefined, home: string): Promise<{
  environment: NodeJS.ProcessEnv; runtime?: RuntimeIdentity;
}> {
  env ??= sanitizedProcessEnv();
  const source = await readFile(join(root, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return { environment: env };
  let manifest: unknown;
  try { manifest = JSON.parse(source); }
  catch {
    // Dependency preparation and gate commands own invalid-manifest diagnostics.
    // Runtime selection must not replace their recorded failure with a parse error.
    return { environment: env };
  }
  const declared: unknown = manifest && typeof manifest === "object" && "packageManager" in manifest ? manifest.packageManager : undefined;
  if (typeof declared !== "string" || !declared.startsWith("bun@")) return { environment: env };
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(declared)?.[1];
  if (!version) throw new Error(`Candidate Bun runtime requires an exact stable version: ${declared}`);
  const installed = join(home, "toolchains", "bun", version, "bin", "bun");
  const provisioned = await access(installed, constants.X_OK).then(() => true, () => false);
  const binary = provisioned ? installed : await globalBun(env.PATH);
  if (!binary || await versionOf(binary, env) !== version)
    throw new Error(`Bun ${version} is not installed for this candidate. Provision ${installed}; the runner never downloads candidate-selected runtimes.`);
  const path = await realpath(binary);
  if (provisioned) {
    const directory = dirname(binary);
    if ((await readdir(directory)).some((name) => name !== "bun" && name !== "bunx"))
      throw new Error(`Bun runtime directory contains other tools: ${directory}`);
    if (await realpath(join(directory, "bunx")).catch(() => null) !== path)
      throw new Error(`Bun runtime requires a bunx alias to the same executable: ${directory}`);
  }
  const runtime: RuntimeIdentity = { name: "bun", version, path,
    sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
  return { environment: provisioned ? { ...env, PATH: [dirname(binary), env.PATH].filter(Boolean).join(delimiter) } : env, runtime };
}
