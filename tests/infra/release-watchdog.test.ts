import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vite-plus/test";

const probe = fileURLToPath(new URL("../../scripts/release-watchdog-probe.ts", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-release-watchdog.sh", import.meta.url));
const repo = "pechhe/yardsmith";
const now = Date.parse("2026-05-21T12:00:00Z");
const min = 60_000;
const endpoint = "https://example.test/fixture-webhook";
let home: string;
let cooldownFile: string;
let webhookFile: string;
let db: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "release-watchdog-scratch-"));
  cooldownFile = join(home, "cooldown.json");
  db = join(home, "operations.sqlite");
  webhookFile = join(home, "webhook");
  writeFileSync(webhookFile, endpoint, { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Event = [id: string, minutesAgo: number, type: string, data?: object];
const submit = (id: string, ago: number, kind = "verification", environment?: string, repository = repo): Event =>
  [id, ago, "submitted", { repo: repository, kind, environment }];
const stage = (id: string, ago: number, name: string): Event => [id, ago, "stage", { stage: name }];
const batch = (id: string, ago: number, outcome: string, verdict = outcome === "green" ? "verified" : "failed", verified?: boolean): Event[] =>
  [submit(id, ago + 1), [id, ago, "batch_outcome", { outcome, verified }], [id, ago, verdict]];
const unrouted = (id: string, ago: number, commitId: string, reason = "batch_culprit_unassociated: no Forge association"): Event =>
  [id, ago, "batch_unrouted", { commitId, reason }];

// Vitest runs on Node. Exercise the real readonly SQLite reader in a disposable Bun process,
// keeping wall clock, transport and systemd deterministic.
const driver = `
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { runReleaseWatchdog } from ${JSON.stringify(probe)};
const { db, events, now, nowMs, active, endpoint, delivery, dryRun, webhookFile, cooldownFile } = JSON.parse(process.env.SCENARIO);
const ledger = new Database(db);
ledger.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, operation_id TEXT, at TEXT, type TEXT, data TEXT)");
const insert = ledger.prepare("INSERT INTO events (operation_id, at, type, data) VALUES (?, ?, ?, ?)");
for (const [id, ago, type, data] of events) insert.run(id, new Date(now - ago * 60000).toISOString(), type, JSON.stringify(data ?? {}));
ledger.close();
let posts = 0;
await runReleaseWatchdog({ db, webhookFile, cooldownFile, nowMs, runnerActive: active, dryRun,
  post: async (url, request) => {
    posts++;
    assert.equal(url, endpoint);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    assert.ok(request.signal instanceof AbortSignal);
    console.log("POST " + request.body);
    if (delivery === "throw") throw new Error("secret " + url);
    return new Response(null, { status: delivery });
  },
});
console.log("POSTS " + posts);
`;
type Report = { repo: string; alerts: { key: string; operationId?: string; stage?: string }[]; suppressed?: string[] };
function scan(events: Event[] = [], { active = true, nowMs = now, delivery = 204 as number | "throw", dryRun = false } = {}) {
  const run = spawnSync("bun", ["-e", driver], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, HOME: home, SCENARIO: JSON.stringify({ db, events, now, nowMs, active, endpoint, delivery, dryRun, webhookFile, cooldownFile }) } });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  const line = run.stdout.split("\n").find((entry) => /^(HEALTHY|ALERT_SENT|ALERT_FAILED|DRY_RUN_ALERT) /.test(entry))!;
  const payload = JSON.parse(line.slice(line.indexOf("{"))) as Report;
  const posts = run.stdout.includes("POSTS 1") ? 1 : 0;
  if (posts) assert.ok(run.stdout.includes("POST " + JSON.stringify(payload)));
  assert.ok(!run.stdout.includes(endpoint) && !run.stderr.includes(endpoint));
  return { line, posts, payload, keys: payload.alerts.map(({ key }) => key) };
}

test("healthy and dry-run probes don't POST or create cooldown state", () => {
  const healthy = scan();
  assert.match(healthy.line, /^HEALTHY /);
  assert.equal(healthy.posts, 0);
  const dry = scan([], { active: false, dryRun: true });
  assert.match(dry.line, /^DRY_RUN_ALERT /);
  assert.deepEqual(dry.keys, ["runner_inactive"]);
  assert.equal(dry.posts, 0);
  assert.ok(!existsSync(cooldownFile));
});

test("runner inactive cools down for 30 minutes and recovery clears its key", () => {
  const first = scan([], { active: false });
  assert.match(first.line, /^ALERT_SENT 204 /);
  assert.equal(first.posts, 1);
  assert.deepEqual(first.keys, ["runner_inactive"]);
  const suppressed = scan([], { active: false, nowMs: now + 29 * min });
  assert.equal(suppressed.posts, 0);
  assert.deepEqual(suppressed.payload.suppressed, ["runner_inactive"]);
  assert.equal(scan([], { active: false, nowMs: now + 30 * min }).posts, 1);
  assert.equal(scan([], { nowMs: now + 31 * min }).posts, 0);
  assert.deepEqual(JSON.parse(readFileSync(cooldownFile, "utf8")), {});
  assert.equal(scan([], { active: false, nowMs: now + 32 * min }).posts, 1);
});

test("wedges use the current stage, distinct deploy/release thresholds and open operations in the chosen repo", () => {
  const result = scan([
    submit("verify", 90), stage("verify", 46, "verifying"),
    submit("release", 50, "release"), stage("release", 46, "publishing"),
    submit("deploy", 40, "deploy", "production"), stage("deploy", 21, "deploying"),
    submit("deploy-edge", 40, "deploy", "production"), stage("deploy-edge", 20, "deploying"),
    submit("recent-stage", 80), stage("recent-stage", 70, "fetching"), stage("recent-stage", 45, "verifying"),
    submit("queued", 240), submit("yielded", 200), stage("yielded", 190, "verifying"), ["yielded", 180, "yielded"],
    submit("done", 130), stage("done", 120, "verifying"), ["done", 5, "verified"],
    submit("other", 80, "release", undefined, "other/repo"), stage("other", 79, "publishing"),
  ]);
  assert.deepEqual(result.payload.alerts, [
    { key: "release_op_wedged:verify", operationId: "verify", stage: "verifying" },
    { key: "release_op_wedged:release", operationId: "release", stage: "publishing" },
    { key: "release_op_wedged:deploy", operationId: "deploy", stage: "deploying" },
  ]);
});

test("red is measured from the first completed batch in the uninterrupted streak; newest real unrouted verdict wins", () => {
  const commit = "abcdef1234567890";
  const result = scan([
    ...batch("old-red", 120, "red"), ...batch("green", 75, "green"),
    ...batch("red-a", 20, "red"), ...batch("red-b", 5, "red"), unrouted("red-b", 4, commit),
    unrouted("red-b", 4, "ignored", "already unassociated in batch check red-a"),
    ...batch("superseded", 3, "red", "superseded"), ...batch("stopped", 2, "stopped"),
    submit("open", 1), ["open", 0, "batch_outcome", { outcome: "red" }],
  ]);
  assert.deepEqual(result.keys, ["unrouted_red_culprit:abcdef123456", "red_batch_stalled"]);
  const recovered = scan(batch("recovery", 0, "green"));
  assert.equal(recovered.posts, 0);
  assert.deepEqual(JSON.parse(readFileSync(cooldownFile, "utf8")), {});
  assert.deepEqual(scan(batch("new-red", 0, "red")).keys, []);
});

test("red_batch_stalled is not due one millisecond before 20 minutes", () => {
  assert.deepEqual(scan(batch("red", 20, "red"), { nowMs: now - 1 }).keys, []);
});

test("latest failed release alerts until a success is recorded later in ledger order", () => {
  const result = scan([
    submit("successful", 30, "release"), submit("failed", 20, "release"),
    ["failed", 10, "failed", { reason: "publication failed" }],
  ]);
  assert.deepEqual(result.payload.alerts, [{ key: "release_failed:failed", operationId: "failed" }]);
  assert.deepEqual(scan([], { nowMs: now + 120 * min - 1 }).payload.suppressed, ["release_failed:failed"]);
  assert.deepEqual(scan([], { nowMs: now + 120 * min }).keys, ["release_failed:failed"]);
  assert.deepEqual(scan([["successful", 11, "released"]], { nowMs: now + 240 * min }).keys, []);
});

test.each([
  ["Pre-verification of abc passed against 012abc, not 987def", false],
  ["no pre-verification of abc passed against master 987def", false],
  ["no pre-verification of abc passed against a readable release base", true],
  ["superseded by a newer candidate", true],
])("automatic release ending with %s: alerts = %s", (reason, alerts) => {
  const result = scan([
    ["auto", 10, "submitted", { repo, kind: "release", automatic: { setting: "process", value: "development" } }],
    ["auto", 9, "failed", { reason: `Not promoted automatically: ${reason}` }],
  ]);
  assert.deepEqual(result.keys, alerts ? ["release_failed:auto"] : []);
});

test("only two recent non-passing flaky/infrastructure batches form a burst", () => {
  assert.deepEqual(scan([...batch("old", 181, "flaky"), ...batch("infra", 60, "infrastructure")]).keys, []);
  assert.deepEqual(scan(batch("passing-flaky", 40, "flaky", "verified", true)).keys, []);
  assert.deepEqual(scan(batch("fresh", 20, "flaky")).keys, []);
  assert.deepEqual(scan(batch("new-infra", 1, "infrastructure")).keys, ["flaky_or_infra_burst"]);
});

test("latest failed production deploy must follow the last success; fresh but not stale audits alert", () => {
  const result = scan([
    submit("good", 70, "deploy", "production"), ["good", 60, "deployed"],
    submit("bad", 10, "deploy", "production"), ["bad", 9, "failed"],
    submit("stage", 6, "deploy", "staging"), ["stage", 4, "failed"],
    submit("stale", 375, "audit"), ["stale", 361, "failed"],
  ]);
  assert.deepEqual(result.keys, ["production_deploy_failed:bad"]);
  assert.deepEqual(scan([
    submit("fixed", 5, "deploy", "production"), ["fixed", 4, "deployed"],
    submit("recent", 360, "audit"), ["recent", 359, "failed"],
  ]).keys, ["nightly_audit_failed:recent"]);
  assert.deepEqual(scan([], { nowMs: now + 2 * min }).keys, []);
  assert.deepEqual(scan([
    submit("previous", 5, "deploy", "production"), submit("fails-first", 4, "deploy", "production"),
    ["fails-first", 3, "failed"], ["previous", 2, "deployed"],
  ], { nowMs: now + 2 * min }).keys, []);
});

test("webhook network and HTTP failures don't crash or mark undelivered alerts as sent", () => {
  for (const [delivery, status] of [["throw", "unavailable"], [503, "503"]] as const) {
    const failed = scan([], { active: false, delivery });
    assert.match(failed.line, new RegExp(`^ALERT_FAILED ${status} `));
    assert.equal(failed.posts, 1);
    assert.ok(!existsSync(cooldownFile));
  }
  assert.match(scan([], { active: false }).line, /^ALERT_SENT 204 /);
});

test("installer preserves a private webhook, writes user units and enables the timer", () => {
  const stub = join(home, "bin");
  mkdirSync(stub);
  const calls = join(home, "systemctl-calls");
  writeFileSync(join(stub, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${stub}:${process.env.PATH}`, CALLS: calls };
  const install = (args: string[] = []) => {
    const result = spawnSync("bash", [installer, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.ok(!result.stdout.includes(endpoint));
  };
  install(["--webhook-url", endpoint]);
  install();
  const webhook = join(home, ".config/slipjay/release-watchdog-webhook.url");
  const installed = join(home, ".local/bin/slipjay-release-watchdog-probe.ts");
  const unit = join(home, ".config/systemd/user/slipjay-release-watchdog-probe");
  assert.equal(readFileSync(webhook, "utf8"), endpoint + "\n");
  assert.equal(statSync(webhook).mode & 0o777, 0o600);
  assert.equal(statSync(installed).mode & 0o777, 0o755);
  assert.equal(readFileSync(installed, "utf8"), readFileSync(probe, "utf8"));
  assert.match(readFileSync(unit + ".service", "utf8"), /^Environment=PATH=%h\/\.bun\/bin:/m);
  assert.match(readFileSync(unit + ".service", "utf8"), /^ExecStart=.*%h\/\.local\/bin\/slipjay-release-watchdog-probe\.ts/m);
  const timer = readFileSync(unit + ".timer", "utf8");
  for (const property of ["OnBootSec=3min", "OnUnitActiveSec=10min", "Persistent=true", "WantedBy=timers.target"]) assert.ok(timer.split("\n").includes(property));
  assert.equal(readFileSync(calls, "utf8"), ("--user daemon-reload\n--user enable --now slipjay-release-watchdog-probe.timer\n").repeat(2));

  // The copied probe has no dependencies on the checkout and accepts CLI overrides.
  const probeCli = spawnSync("bun", [installed, "--dry-run", "--repo", "other/repo", "--db", db,
    "--webhook-file", webhook, "--cooldown-file", cooldownFile], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(probeCli.status, 0, probeCli.error?.message ?? probeCli.stderr);
  assert.match(probeCli.stdout, /^DRY_RUN_ALERT .*"repo":"other\/repo".*"key":"runner_inactive"/);
  assert.match(readFileSync(calls, "utf8"), /--user is-active slipjay-runner\.service/);
  assert.ok(!existsSync(cooldownFile));
});
