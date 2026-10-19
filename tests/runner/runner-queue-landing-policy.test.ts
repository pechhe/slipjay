import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPolicyPatch, POLICY_BASE_TRAILER, policyDigest } from "../../src/lib/policy/policy-settings.ts";
import type { PolicyPatch } from "../../src/lib/policy/policy-settings.ts";
import { gate, command, test, jj, fixture, generate } from "./fixtures/runner-queue-fixture.ts";

test("a rebase conflict in the policy returns the runner to integration before an independent landing", async () => {
  const f = await fixture();
  try {
    const makePolicyCandidate = async (projectCode: string) => {
      jj(f.author, ["new", "main"]);
      const path = join(f.author, "slipjay.json");
      const policy = JSON.parse(await readFile(path, "utf8"));
      policy.projectCode = projectCode;
      await writeFile(path, JSON.stringify(policy));
      jj(f.author, ["describe", "-m", `Set project code ${projectCode}`]);
      return f.push();
    };
    const first = await makePolicyCandidate("aa");
    const conflicting = await makePolicyCandidate("bb");
    const independent = await f.candidate("independent.txt");
    assert.equal((await f.land(f.submit(first)))?.type, "landed");
    const failed = f.submit(conflicting);
    const failure = await f.land(failed);
    assert.ok(failure?.type === "failed", JSON.stringify(failure));
    assert.equal(failure.stage, "rebasing");
    assert.match(failure.reason, /conflict/i);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "-r", "@", "--no-graph", "-T", "conflict"]), "false");
    assert.equal(jj(checkout, ["log", "-r", "parents(@)", "--no-graph", "-T", "commit_id"]), f.main());
    assert.equal(f.candidateAtVerdict.get(failed), false);
    assert.equal(JSON.parse(await readFile(join(checkout, "slipjay.json"), "utf8")).projectCode, "aa");
    assert.equal((await f.land(f.submit(independent)))?.type, "landed");
    assert.equal(f.remoteFile("independent.txt"), "independent.txt");
  } finally { await f.dispose(); }
}, 120_000);

test("a settings landing skips the gate only when policy settings are all it changes, and refuses a stale base or an unresolvable check", async () => {
  const f = await fixture();
  try {
    // A change on the integration tip that rewrites the policy and adds `files`; `base` is the digest of the policy it was read from.
    const change = async (edit: (text: string) => string, files: Record<string, string> = {}, base?: string) => {
      jj(f.author, ["git", "fetch", "--remote", "origin"]);
      jj(f.author, ["new", "main@origin"]);
      const text = await readFile(join(f.author, "slipjay.json"), "utf8");
      await writeFile(join(f.author, "slipjay.json"), edit(text));
      for (const [file, content] of Object.entries(files)) {
        await mkdir(join(f.author, file, ".."), { recursive: true });
        await writeFile(join(f.author, file), content);
      }
      jj(f.author, ["describe", "-m", `Settings change${base ? `\n\n${POLICY_BASE_TRAILER}: ${base}` : ""}`]);
      return { request: await f.push() };
    };
    const patch = (fields: PolicyPatch) => (text: string) => applyPolicyPatch(text, fields).text;
    const skipped = (id: string) => f.log.events({ operationId: id }).some((row) => row.event.type === "verification_skipped");
    const gated = (id: string) => f.log.operation(id)!.runs.some((run) => run.command === command);
    const landed = async (id: string) => { const result = await f.land(id); assert.equal(result?.type, "landed", JSON.stringify(result)); };

    // A JSON-only edit of a settings field lands without the gate, recording the skip and its reason.
    const spares = f.submit((await change(patch({ spares: 3 }))).request);
    await landed(spares);
    assert.ok(skipped(spares) && !gated(spares));
    const skip = f.log.events({ operationId: spares }).find((row) => row.event.type === "verification_skipped")?.event;
    assert.ok(skip?.type === "verification_skipped");
    assert.deepEqual(skip.fields, ["spares", "unattendedMergeToIntegration"]);
    assert.match(skip.reason, /landing checks are not run/);
    assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 3);

    // A script alone, or the policy with another file, takes the normal route.
    const script = f.submit(await f.candidate("scripts/settings.ts"));
    await landed(script);
    assert.ok(gated(script) && !skipped(script));
    const mixed = f.submit((await change(patch({ spares: 4 }), { "other.txt": "other\n" })).request);
    await landed(mixed);
    assert.ok(gated(mixed) && !skipped(mixed));

    // Two patches read from one base: the second is refused as stale once the first has changed the policy.
    const read = policyDigest(f.remoteFile("slipjay.json"));
    const firstId = f.submit((await change(patch({ spares: 5 }), {}, read)).request);
    const second = f.submit((await change(patch({ requiredLandingVerification: [{ executable: "node", args: ["-e", gate], concurrent: true }] }), {}, read)).request);
    await landed(firstId);
    const stale = await f.land(second);
    assert.equal(stale?.type, "failed", JSON.stringify(stale));
    assert.match(stale?.type === "failed" ? stale.reason : "", /refused as stale/);
    assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 5);

    // An edit that reaches a migration field is not a settings change.
    const migration = f.submit((await change((text) => JSON.stringify({ ...JSON.parse(text), spares: 6, migrationFinalization: {
      mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
      generate: { executable: "node", args: ["-e", generate] }, verify: { executable: "node", args: ["-e", ""] } } }, null, 2))).request);
    await landed(migration);
    assert.ok(gated(migration) && !skipped(migration));

    // A new check whose executable the runner cannot find is refused before integration.
    const before = f.main();
    const missing = f.submit((await change(patch({ requiredLandingVerification: [{ executable: "slipjay-no-such-tool", args: [] }] }))).request);
    const refused = await f.land(missing);
    assert.equal(refused?.type, "failed", JSON.stringify(refused));
    assert.match(refused?.type === "failed" ? refused.reason : "", /slipjay-no-such-tool, which does not resolve on the runner host/);
    assert.equal(f.main(), before);

    // Removing the gate is itself a settings change.
    const removal = f.submit((await change(patch({ requiredLandingVerification: [] }))).request);
    await landed(removal);
    assert.ok(skipped(removal) && !gated(removal));
    assert.deepEqual(JSON.parse(f.remoteFile("slipjay.json")).requiredLandingVerification, []);
  } finally { await f.dispose(); }
}, 300_000);
