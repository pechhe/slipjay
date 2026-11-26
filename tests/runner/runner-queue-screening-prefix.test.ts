import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture, jj, test, until } from "./fixtures/runner-queue-fixture.ts";
import { controlledRemote, events } from "./fixtures/screening-fixture.ts";

test("a screen that conflicts with the screen ahead screens on the tip alone, and restarts on the new tip once that one lands", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const base = f.main();
    const ahead = f.submit(await f.candidate("shared.txt"));
    jj(f.author, ["new", "-m", "Rewrite shared.txt", "main@origin"]);
    await writeFile(join(f.author, "shared.txt"), "conflicting\n");
    const conflicting = f.submit(await f.push());
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.equal(r.opened[1]!.base, base, "the conflicting landing screens on the tip");
    r.opened[0]!.release();
    await until(() => f.result(ahead) || undefined);
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(ahead)?.type, "landed");
    const outcome = f.result(conflicting);
    assert.equal(outcome?.type, "failed", JSON.stringify(outcome));
    assert.match(outcome?.type === "failed" ? outcome.reason : "", /conflict/i);
    const starts = events(f, conflicting).filter((event) => event.type === "screen_started");
    // Behind the one ahead, then on the tip alone (the conflict), then once more on the tip it published.
    assert.equal(starts.length, 3);
    assert.equal(starts[0]?.type === "screen_started" ? starts[0].behind : undefined, ahead);
    assert.equal(starts[1]?.type === "screen_started" ? starts[1].behind : "x", undefined);
    assert.ok(events(f, conflicting).some((event) => event.type === "yielded" && event.to === "the moved integration tip"));
    assert.ok(events(f, conflicting).some((event) => event.type === "attempt_invalidated" && new RegExp(`${ahead} published past this screen's base`).test(event.reason)),
      "its screen on the old tip stops when the one ahead publishes, rather than running on to a pass it could not publish");
    assert.ok(!events(f, conflicting).some((event) => event.type === "publication_intent"));
    assert.equal(r.opened.length, 2, "the rebuilt attempt stops at its conflict, before any gate");
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a failing screen behind a prefix that lands keeps its verdict and screens no second time", async () => {
  const r = controlledRemote();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const ahead = f.submit(await f.candidate("ahead.txt"));
    const failing = f.submit(await f.candidate("fail"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    assert.ok(r.opened[1]!.files.includes("ahead.txt"));
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(ahead)?.type, "landed");
    assert.equal(f.result(failing)?.type, "failed", JSON.stringify(f.result(failing)));
    assert.equal(r.opened.length, 2, "its failure behind a prefix that landed is its verdict");
    assert.ok(!events(f, failing).some((event) => event.type === "yielded"));
    assert.equal(events(f, failing).find((event) => event.type === "classified")?.cause, "gate");
  } finally { r.releaseAll(); await f.dispose(); }
});

test("a screen ahead that changes migrations is not predicted past, and the screen behind it screens again on what it published", async () => {
  const r = controlledRemote();
  const f = await fixture(true, false, undefined, false, { screeningLanes: 3, workers: 1, remoteVerification: r.remote });
  try {
    const base = f.main();
    const migrating = f.submit(await f.candidate("schema/table.sql"));
    const behind = f.submit(await f.candidate("plain.txt"));
    f.queue.wake();
    await until(() => r.opened.length === 2 || undefined);
    const second = r.opened.find((entry) => entry.files.includes("plain.txt"))!;
    assert.equal(second.base, base, "a screen is not predicted past a migration change");
    assert.ok(!second.files.includes("schema"));
    r.opened.find((entry) => entry.files.includes("schema"))!.release();
    await until(() => f.result(migrating) || undefined);
    assert.equal(f.result(migrating)?.type, "landed", JSON.stringify(f.result(migrating)));
    const published = f.main();
    r.releaseAll();
    await f.queue.idle();
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
    assert.equal(r.opened.length, 3, "the overtaken screen stopped and screened once more");
    assert.equal(r.opened[2]!.screening, true, "a fresh screen, not an authoritative rebuild");
    assert.equal(r.opened[2]!.base, published);
    assert.ok(events(f, behind).some((event) => event.type === "attempt_invalidated" && new RegExp(`${migrating} published past this screen's base`).test(event.reason)));
    assert.equal(events(f, behind).find((event) => event.type === "screen_reused")?.base, published, "it publishes on its fresh screen with no second gate");
  } finally { r.releaseAll(); await f.dispose(); }
});
