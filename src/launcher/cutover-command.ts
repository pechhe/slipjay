import { cutover } from "../lib/slipjay.ts";

/** `cutover [--check]`: move Slipway's state from ~/.slipway to ~/.slipjay once, or only report whether it would. */
export async function runCutover(args: string[]): Promise<number> {
  if (args.some((flag) => flag !== "--check")) throw new Error("Usage: slipjay cutover [--check]");
  const result = await cutover({ check: args.includes("--check") });
  if (result.status === "refused") {
    console.error(`Refusing the cutover while ${result.holders.length === 1 ? "this holds" : "these hold"} slipjay state; wait for ${result.holders.length === 1 ? "it" : "them"} to finish, then rerun:`);
    for (const holder of result.holders) console.error(`  - ${holder}`);
  }
  if (result.status === "already-cut-over" && result.reappeared) {
    console.error(`Old-location state exists again (${result.reappeared.join(", ")}): something still running Slipway wrote it after the cutover. slipjay ignores it; stop that process.`);
  }
  console.log(JSON.stringify(result, null, 2));
  return result.status === "refused" ? 1 : 0;
}
