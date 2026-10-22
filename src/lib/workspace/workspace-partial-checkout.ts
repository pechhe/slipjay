import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../infra/workspace-jj.ts";

/** A checkout missing most of the tracked files it should hold. */
export type PartialCheckout = { workspace: string; root: string; missing: number; expected: number };

/** Fewer tracked files than this cannot tell a partial checkout from a deliberate deletion. */
const MINIMUM_EXPECTED_FILES = 10;
/** How many tracked files the cheap first look checks before counting them all. */
const SAMPLE_SIZE = 64;
const CONCURRENT_STATS = 256;

async function jjLines(root: string, args: string[]): Promise<string[]> {
  const result = await run("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd: root });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.split("\n").filter(Boolean);
}

/** Files in the checkout's last snapshot. Never snapshots. */
export const snapshotFileList = (root: string): Promise<string[]> => jjLines(root, ["file", "list"]);

/**
 * The files a checkout materialises: those in its last snapshot that its sparse patterns include.
 * A sparse checkout leaves the rest out on purpose, so they are never missing.
 */
export async function sparseFiles(root: string, files: string[]): Promise<string[]> {
  const prefixes = await jjLines(root, ["sparse", "list"]);
  if (prefixes.includes(".")) return files;
  return files.filter((file) => prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)));
}

async function countMissing(root: string, files: string[]): Promise<number> {
  let missing = 0;
  for (let start = 0; start < files.length; start += CONCURRENT_STATS) {
    const present = await Promise.all(files.slice(start, start + CONCURRENT_STATS).map((file) => lstat(join(root, file)).then(() => true, () => false)));
    missing += present.filter((exists) => !exists).length;
  }
  return missing;
}

/**
 * Whether a checkout lacks most of the tracked files its sparse patterns include, as a half-written
 * one does after an interrupted preparation. Reads the last snapshot and the disk and changes
 * neither: a snapshot here would record the missing files as deleted. A checkout JJ cannot read
 * is not judged partial.
 */
export async function partialCheckout(root: string, workspace: string): Promise<PartialCheckout | null> {
  const expected = await snapshotFileList(root).then((files) => sparseFiles(root, files)).catch(() => null);
  if (!expected || expected.length < MINIMUM_EXPECTED_FILES) return null;
  // A healthy checkout is the common case: look at an even sample before counting every file.
  const step = Math.max(1, Math.floor(expected.length / SAMPLE_SIZE));
  const sample = expected.filter((_, index) => index % step === 0);
  if (await countMissing(root, sample) * 4 <= sample.length) return null;
  const missing = await countMissing(root, expected);
  return missing * 2 > expected.length ? { workspace, root, missing, expected: expected.length } : null;
}

/** One human explanation of why a suspected partial checkout is kept, and the supported ways forward. */
export function describePartialCheckout({ workspace, root, missing, expected }: PartialCheckout): string {
  return `partially written checkout: ${missing} of ${expected} tracked files are missing on disk (files outside its sparse patterns are not counted). `
    + "That suggests an interrupted checkout, though deliberately deleting them looks the same. Nothing was snapshotted or changed, and its last snapshot is intact: "
    + `inspect it with \`jj --ignore-working-copy -R ${root} diff -r @\`. To restore it, copy out anything you need from the directory and, from another checkout such as the integration checkout (never from inside this one, which JJ would snapshot), run \`slipjay start --base ${workspace}@\`; `
    + `to delete it, run \`slipjay remove --discard ${root}\``;
}
