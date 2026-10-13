// Tests must never write the developer's real SlipJay or Slipway state (for example
// ~/.slipjay/state/post-land, or ~/.slipway during a cutover test). `homedir()` follows HOME, but the
// account's home comes from the user database, so a test whose HOME was not
// isolated (a runner without the hermetic setup, or a runtime that fixes
// homedir() at startup) is caught before it writes anything.
import { homedir, userInfo } from "node:os";
import path from "node:path";

/** Throws when `homedir()` still resolves to the account's real home. */
export function assertHermeticHome(home = homedir(), accountHome = realAccountHome()) {
  if (accountHome && path.resolve(home) === path.resolve(accountHome)) {
    throw new Error(`Tests must run under a hermetic HOME, but homedir() is the real home ${home}. `
      + "Run them through the package test script (Vitest loads scripts/vitest-hermetic-env.mjs) "
      + "or scripts/with-hermetic-home.mjs, under Node.");
  }
}

function realAccountHome() {
  try { return userInfo().homedir; } catch { return null; }
}
