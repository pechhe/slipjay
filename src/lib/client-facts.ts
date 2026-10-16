#!/usr/bin/env bun
// The detached client-facts recorder (`recordClientFactsInBackground`): records the facts
// given as JSON in its second argument for the checkout given as its first, and writes one
// line to the log when the runner could not take them. It is a closure entry beside
// runner-client.ts.
import { recordClientFacts } from "./runner-client.ts";
import type { ClientFact } from "./runner-contract.ts";

try {
  const [cwd, facts] = process.argv.slice(2);
  if (!cwd || !facts) throw new Error("client-facts needs a checkout and its facts");
  await recordClientFacts(cwd, JSON.parse(facts) as ClientFact[]);
} catch (caught) {
  console.error(new Date().toISOString(), "runner client facts not recorded:", (caught as Error | null | undefined)?.message ?? caught);
  process.exitCode = 1;
}
