import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";

test("a green pre-verification that is not the newest candidate says on its own log why it did not promote", async () => {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" }, false, { process: "development" });
  try {
    // A carries a non-additive migration, so it is withheld with its reason.
    await f.land(f.submit(await f.candidate("schema/drop")));
    await settle(f);
    const a = f.main();
    const first = f.log.verifications(REPO).find((entry) => entry.commitId === a)!;
    assert.equal(first.status, "verified");
    const noted = (id: string) => f.log.events({ operationId: id }).some((stored) => stored.event.type === "progress" && /Not promoting .* automatically: /.test(stored.event.line));
    assert.ok(noted(first.id), "the withheld promotion says why on A's pre-verification");
    // A newer landing becomes the candidate this consideration asks about.
    await f.land(f.submit(await f.candidate("b.txt")));
    await settle(f);
    // A staging deploy of A goes green, so A is pre-verified again, and its pass promotes nothing.
    await f.deploy(a);
    await settle(f);
    const again = f.log.verifications(REPO).find((entry) => entry.commitId === a && entry.id !== first.id);
    assert.equal(again?.status, "verified", JSON.stringify(again?.result));
    assert.ok(noted(again!.id), "the second green pre-verification of A also says why it was withheld");
  } finally { await f.dispose(); }
}, 240_000);

test("a development release base that declares nothing to promote into says so on the pre-verification", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // The release branch stands on an ancestor whose policy is development but declares no production environment
    // to promote into; the integration branch declares it again, so the landing is pre-verified as usual.
    const promoting = JSON.parse(f.remoteFile("slipjay.json")) as Record<string, unknown>;
    const { deployments: _dropped, ...bare } = promoting;
    const base = await f.seedMain({ "slipjay.json": JSON.stringify(bare) }, "Release base policy");
    await f.seedMain({ "slipjay.json": JSON.stringify(promoting) }, "Promoting policy");
    f.updateRelease(base);
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    const verification = f.log.verifications(REPO)[0]!;
    assert.equal(verification.status, "verified", JSON.stringify(verification.result));
    assert.deepEqual(f.log.releases(REPO), []);
    const lines = f.log.events({ operationId: verification.id }).flatMap((stored) => stored.event.type === "progress" ? [stored.event.line] : []);
    assert.ok(lines.some((line) => /Not promoting .* automatically: the release base's policy does not promote: it declares no production environment/.test(line)), lines.join("\n"));
  } finally { await f.dispose(); }
}, 240_000);

test("a pre-verification whose promotion waits for an open release says which release holds it", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // The pre-verification holds in its release check, so a human's release of the commit before it is still open when it ends.
    const seed = f.main();
    await writeFile(join(f.root, "hold-release"), "");
    const landed = f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const human = f.submitRelease(seed);
    await rm(join(f.root, "hold-release"));
    await settle(f);
    assert.ok(f.log.operation(landed)?.result?.type === "landed");
    const verification = f.log.verifications(REPO)[0]!;
    assert.equal(verification.status, "verified");
    const lines = f.log.events({ operationId: verification.id }).flatMap((stored) => stored.event.type === "progress" ? [stored.event.line] : []);
    assert.deepEqual(lines.filter((line) => /^Not promoting /.test(line)), [`Not promoting ${verification.commitId.slice(0, 12)} automatically: a release (${human}) is already open`]);
  } finally { await f.dispose(); }
}, 240_000);
test("a pre-verification that promotes nothing names the release still open for its own commit, not a missing candidate", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // A human's release of this very commit is queued behind its held pre-verification.
    await writeFile(join(f.root, "hold-release"), "");
    const landed = f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const human = f.submitRelease(f.log.verifications(REPO)[0]!.commitId);
    await rm(join(f.root, "hold-release"));
    await settle(f);
    assert.ok(f.log.operation(landed)?.result?.type === "landed");
    const verification = f.log.verifications(REPO)[0]!;
    assert.equal(verification.status, "verified");
    const lines = f.log.events({ operationId: verification.id }).flatMap((stored) => stored.event.type === "progress" ? [stored.event.line] : []);
    const notes = lines.filter((line) => /^Not promoting /.test(line));
    assert.deepEqual(notes, [`Not promoting ${verification.commitId.slice(0, 12)} automatically: it has a release (${human}) still open`]);
    assert.doesNotMatch(lines.join("\n"), /no pre-verified candidate promotes right now/);
  } finally { await f.dispose(); }
}, 240_000);

test("a pre-verification older than a released landing names the landing that already stands", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    const a = f.main();
    const [release] = f.log.releases(REPO);
    assert.equal(release?.result?.type, "released");
    assert.ok(f.log.deployments(REPO, "production").some((entry) => entry.result?.type === "deployed"));
    // A commit that never landed here is pre-verified by its staging deploy; nothing may promote it, and the
    // newest landing has already been released and deployed.
    const seeded = await f.seedMain({ "seeded.txt": "seeded.txt\n" });
    await f.deploy(seeded);
    await settle(f);
    const verification = f.log.verifications(REPO).find((entry) => entry.commitId === seeded)!;
    assert.equal(verification.status, "verified", JSON.stringify(verification.result));
    const lines = f.log.events({ operationId: verification.id }).flatMap((stored) => stored.event.type === "progress" ? [stored.event.line] : []);
    assert.deepEqual(lines.filter((line) => /^Not promoting /.test(line)),
      [`Not promoting ${seeded.slice(0, 12)} automatically: the newest landing (${a.slice(0, 12)}) is already released, and is already live on production`]);
  } finally { await f.dispose(); }
}, 240_000);

test("a pre-verification of a commit nothing has been released or deployed for says nothing", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // The landing's pre-verification fails, so the newest landing has no release and no production deploy.
    await writeFile(join(f.root, "fail-release"), "");
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    assert.equal(f.log.verifications(REPO)[0]?.status, "failed");
    await rm(join(f.root, "fail-release"));
    const seeded = await f.seedMain({ "seeded.txt": "seeded.txt\n" });
    await f.deploy(seeded);
    await settle(f);
    const verification = f.log.verifications(REPO).find((entry) => entry.commitId === seeded)!;
    assert.equal(verification.status, "verified", JSON.stringify(verification.result));
    const lines = f.log.events({ operationId: verification.id }).flatMap((stored) => stored.event.type === "progress" ? [stored.event.line] : []);
    assert.deepEqual(lines.filter((line) => /^Not promoting /.test(line)), []);
  } finally { await f.dispose(); }
}, 240_000);
