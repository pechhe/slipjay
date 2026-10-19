import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { fixture, append } from "./fixtures/migration-candidate-fixture.ts";

for (const [name, source, pass] of [
  ["append", append, true], ["no-op", "", true],
  ["undeclared artifact", append + 'writeFileSync("unexpected", "bad");', false],
  ["failed generation rollback", append + 'console.error("generation evidence");process.exit(9);', false],
] as const) test(`the runner retains ${name} migration behaviour`, async () => {
  const f = await fixture(source);
  try {
    const base = f.remoteMain();
    const out = await f.land();
    assert.equal(out.ok, pass, out.output);
    if (!pass) {
      assert.equal(f.remoteMain(), base);
      if (name === "failed generation rollback") assert.match(out.output, /generation evidence/);
    }
  } finally { await f.dispose(); }
}, 60000);
