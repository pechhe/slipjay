import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import type { BuildItem } from "../../src/lib/build/tracker.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner, withTestRunner } from "../support/test-runner.ts";
import { item, buildServer, SESSION } from "./fixtures/build-tracker-fixture.ts";

/**
 * A repository check that records what SlipJay gave it from Build, appending to `file` under `label`: the binding, and
 * what the runner answered its token for a read of Build #`number`, an unknown item, a write and another route. It prints
 * the token, which must never reach the runner's records. A migration generator also writes a migration.
 */
const buildProbe = (file: string, label: string, number: number, migration = false) => `(async () => {
const fs = require("node:fs"); const e = process.env; const url = e.SLIPJAY_BUILD_READ_URL; let answers = null;
if (url) {
  const headers = { authorization: "Bearer " + e.SLIPJAY_BUILD_READ_TOKEN, "content-type": "application/json" };
  const post = async (action, input) => { const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action, input }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  answers = { read: await post("read", { number: ${number} }), unknown: await post("read", { number: 1 }), write: await post("setStatus", {}),
    other: (await fetch(new URL("/v1/queue", url), { headers })).status };
}
${migration ? 'fs.mkdirSync("migrations", { recursive: true }); fs.writeFileSync("migrations/0001.sql", "-- 1\\n");' : ""}
fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ label: ${JSON.stringify(label)}, context: e.SLIPJAY_BUILD_CONTEXT ?? null, url: url ?? null, token: e.SLIPJAY_BUILD_READ_TOKEN ?? null, answers }) + "\\n");
console.log("token " + e.SLIPJAY_BUILD_READ_TOKEN);
})()`;

type Probe = { label: string; context: string | null; url: string | null; token: string | null;
  answers: { read: { status: number; body: { value?: BuildItem } }; unknown: { status: number; body: unknown }; write: { status: number }; other: number } | null };

/** Every file under `directory`, as bytes. */
async function filesUnder(directory: string): Promise<Buffer[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name))));
}

test("a Build-tracked landing's checks get its admitted binding and read Build with a token that ends with the operation", async () => {
  const probes = join(await mkdtemp(join(tmpdir(), "build-probe-")), "probes.jsonl");
  const spec = item({ number: 96630, kind: "spec", status: "in_progress", title: "Gated Spec", bodyRevision: 2 });
  const ticket = item({ number: 96631, parentId: spec.id });
  const f = await project({ verify: () => buildProbe(probes, "gate", spec.number), policy: { tracker: "build", migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "node", args: ["-e", buildProbe(probes, "generate", spec.number, true)] },
    verify: { executable: "node", args: ["-e", buildProbe(probes, "verify", spec.number)] } } } });
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, [spec, ticket], { [spec.id]: [{ generation: 1, endedAt: null }] });
  const bound = await createWorkspace("Placeholder task", f.repo, { issueNumber: ticket.number });
  const chore = await createWorkspace("Tidy", f.repo);
  const read = (lines: string) => lines.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Probe);
  try {
    await mkdir(join(bound.workspacePath, "schema"), { recursive: true });
    await writeFile(join(bound.workspacePath, "schema", "table.ts"), "table\n");
    await writeFile(join(chore.workspacePath, "a.txt"), "a\n");
    jj(chore.workspacePath, ["describe", "-m", "Tidy the readme"]);
    await withTestRunner(f, async ({ location, env }) => {
      const landed = await landThroughRunner(bound.workspacePath, { location, env, session: SESSION, onLine: () => {} });
      assert.equal(landed.ok, true);
      const runs = read(await readFile(probes, "utf8"));
      assert.deepEqual(runs.map((run) => run.label), ["generate", "verify", "gate"]);
      for (const run of runs) {
        assert.deepEqual(JSON.parse(run.context!), { version: 1, specId: spec.id, specNumber: spec.number, ticketNumbers: [ticket.number], sessionId: SESSION }, run.label);
        assert.equal(run.url, `${location}/v1/build/read`);
        assert.equal(run.token, runs[0]!.token, "one token for the operation's checks");
        assert.notEqual(run.token, "test-token");
        assert.notEqual(run.token, buildToken);
        // Build's own answers, and nothing beyond its read actions.
        assert.equal(run.answers!.read.status, 200);
        assert.equal(run.answers!.read.body.value?.title, "Gated Spec");
        assert.deepEqual(run.answers!.unknown, { status: 409, body: { code: "build_item_unavailable" } });
        assert.equal(run.answers!.write.status, 400);
        assert.equal(run.answers!.other, 401);
      }
      assert.equal(fake.requests.some((request) => request.action === "setStatus"), false);
      // The operation has ended: its token reads nothing now.
      const after = await fetch(runs[0]!.url!, { method: "POST", headers: { authorization: `Bearer ${runs[0]!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "read", input: { number: spec.number } }) });
      assert.equal(after.status, 401);

      // A chore is bound to no Spec: it may read Build, with a token of its own, but has no binding.
      const tidy = await landThroughRunner(chore.workspacePath, { location, env, onLine: () => {} });
      assert.equal(tidy.ok, true);
      const choreRun = read(await readFile(probes, "utf8")).at(-1)!;
      assert.equal(choreRun.context, null);
      assert.equal(choreRun.answers!.read.status, 200);
      assert.notEqual(choreRun.token, runs[0]!.token);
      for (const token of [runs[0]!.token!, choreRun.token!])
        for (const file of await filesUnder(join(f.root, "runner"))) assert.equal(file.includes(token), false, "a check's token never reaches the runner's records");
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    for (const workspace of [bound, chore]) await rm(workspace.workspacePath, { recursive: true, force: true });
    await rm(dirname(probes), { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 180_000);

test("a GitHub-tracked landing's checks get nothing from Build, even on a runner connected to it", async () => {
  const probes = join(await mkdtemp(join(tmpdir(), "build-probe-")), "probes.jsonl");
  const f = await project({ verify: () => buildProbe(probes, "gate", 1) });
  const fake = await buildServer("build-secret", []);
  try {
    await writeFile(join(f.repo, "a.txt"), "a\n");
    jj(f.repo, ["describe", "-m", "Add a"]);
    const landed = await landThroughTestRunner(f, f.repo, { direct: true, build: { origin: fake.origin, token: "build-secret" } });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    const [run] = (await readFile(probes, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Probe);
    assert.deepEqual([run!.context, run!.url, run!.token], [null, null, null]);
  } finally {
    await rm(dirname(probes), { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);
