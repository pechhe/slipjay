import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, jj, test } from "./fixtures/runner-queue-fixture.ts";

for (const verificationDepth of [1, 2] as const) test(`depth ${verificationDepth} freezes one failed candidate's provenance after migration generation and before rollback`, async () => {
  const f = await fixture(true, false, undefined, false, { verificationDepth });
  try {
    const base = f.main();
    await f.candidate("schema/new.ts");
    await writeFile(join(f.author, "fail"), "fail gate");
    await writeFile(join(f.author, "bun.lock"), "checked lockfile");
    const request = await f.push();
    const id = f.submit(request);
    assert.equal((await f.land(id))?.type, "failed");
    const rows = f.log.events({ operationId: id });
    const evidence = rows.filter(row => row.event.type === "provenance");
    assert.equal(evidence.length, 1);
    const value = evidence[0]!.event;
    if (value.type !== "provenance") throw new Error("expected frozen provenance");
    assert.deepEqual(value.value.migrations, { paths: ["migrations/0001.sql", "schema/new.ts"] });
    const checked = rows.findLast(row => row.event.type === "verification_base")!.event;
    if (checked.type !== "verification_base" || !checked.candidate) throw new Error("expected checked candidate");
    assert.equal(checked.base, base);
    assert.notEqual(checked.candidate, request.commitId);
    const checkout = join(f.home, verificationDepth === 2 ? "verifiers" : "repos", "fixture/repo", ...verificationDepth === 2 ? ["0"] : []);
    const gitDirectory = jj(checkout, ["git", "root"]);
    const blob = execFileSync("git", ["--git-dir", gitDirectory, "rev-parse", `${checked.candidate}:bun.lock`], { encoding: "utf8" }).trim();
    assert.deepEqual(value.value.toolchain.lockfiles, [{ path: "bun.lock", blob }]);
    assert.deepEqual(value.value.fixture, { unavailable: "the repository declares no provenance.fixturePaths" });
    assert.ok(evidence[0]!.seq < rows.find(row => row.event.type === "failed")!.seq);
    await f.queue.recover();
    assert.equal(f.log.events({ operationId: id }).filter(row => row.event.type === "provenance").length, 1);
  } finally { await f.dispose(); }
});

test("restart freezes prepared candidate provenance once without a live run or attempt context", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2 });
  try {
    const request = await f.candidate("input.txt");
    const id = f.submit(request);
    const checkout = join(f.home, "repos", "fixture/repo");
    await mkdir(join(f.home, "repos", "fixture"), { recursive: true });
    jj(join(f.home, "repos", "fixture"), ["git", "clone", f.origin, checkout]);
    const base = f.main();
    f.log.append(id, { type: "stage", stage: "verifying" });
    f.log.append(id, { type: "attempt_prepared", attempt: 1, source: request.commitId, candidate: request.commitId, base, checkout, overlap: true });
    await f.queue.recover(); await f.queue.recover();
    const rows = f.log.events({ operationId: id }).filter(row => row.event.type === "provenance");
    assert.equal(rows.length, 1);
    const event = rows[0]!.event;
    if (event.type !== "provenance") throw new Error("expected provenance");
    assert.deepEqual(event.value.toolchain.runtime, { unavailable: "the failure has no recorded run" });
  } finally { await f.dispose(); }
});
