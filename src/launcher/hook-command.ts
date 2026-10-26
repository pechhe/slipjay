import { landingGuardDecision } from "../lib/landing/landing-guard.ts";

export async function runGuard(): Promise<void> {
  // Claude Code PreToolUse hook: reads the tool call on stdin, prints a deny decision.
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const decision = await landingGuardDecision(input.trim() ? JSON.parse(input) : {});
  if (decision) console.log(JSON.stringify(decision));
}
