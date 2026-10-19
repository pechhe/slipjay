import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { AUDIT_OVERDUE_AFTER_MS, auditSummariesFromEvents, auditSummary, auditToExplain, promotionRefusal, resolveCulprits } from "../../src/lib/release/audit-ledger.ts";
import { AUDIT_INTERRUPTED_REASON } from "../../src/lib/runner/runner-contract.ts";
import type { AuditCause } from "../../src/lib/runner/runner-contract.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";

const REPO = "owner/repo";
const sha = (name: string) => name.padEnd(40, "0");
const sleep = () => new Promise((resolve) => setTimeout(resolve, 3));

/** A repository's ledger: landings published in a chain on the integration branch, and audits of its heads. */
function ledger() {
  const log = openOperationLog(":memory:");
  let audits = 0;
  let landings = 0;
  let previous = sha("base");
  return {
    log,
    /** Publish a landing of `name` on `base` (default: the previous landing), its gate green, skipped for a settings landing, or never run. */
    landing(name: string, { gate = "green", base = previous }: { gate?: "green" | "skipped" | "none"; base?: string } = {}) {
      const id = `landing-${String((landings += 1)).padStart(3, "0")}`;
      const commit = sha(name);
      log.append(id, { type: "submitted", repo: REPO, changeId: `change${name}`, commitId: sha(`src${name}`), bookmark: `slipjay/changes/${name}`, submittedBy: "test" });
      if (gate !== "none") log.append(id, { type: "verification_passed", base, candidate: commit });
      if (gate === "skipped") log.append(id, { type: "verification_skipped", base, candidate: commit, fields: ["spares"], reason: "settings" });
      log.append(id, { type: "landed", base, commitId: commit, branch: "main", remote: "origin" });
      previous = commit;
      return id;
    },
    audit(outcome: "green" | "failed" | "cancelled" | "interrupted" | "running", head: string | null = previous, extra: { skipped?: string[]; reused?: string[]; passed?: string[] } = {}) {
      const id = `audit-${String((audits += 1)).padStart(3, "0")}`;
      log.append(id, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
      log.append(id, { type: "stage", stage: "verifying" });
      if (head) log.append(id, { type: "audit_head", commit: head });
      if (outcome === "green") log.append(id, { type: "audited", commit: head!, commands: ["install", "test"], passed: extra.passed ?? ["install", "test"], skipped: extra.skipped ?? [], reused: extra.reused ?? [] });
      else if (outcome === "failed") log.append(id, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "bun run test" });
      else if (outcome !== "running") log.append(id, { type: "cancelled", reason: outcome === "interrupted" ? AUDIT_INTERRUPTED_REASON : "cancelled by the author" });
      return id;
    },
    cause(audit: string, cause: AuditCause) { log.append(audit, { type: "audit_cause", cause, by: "henry" }); },
    summary(now = new Date()) { return auditSummary({ audits: log.audits(REPO), landings: log.landings(REPO) }, now); },
  };
}

test("suspects are the landings published between the last green audit's commit and the failing one, by recorded ancestry", async () => {
  const l = ledger();
  try {
    for (const name of ["a1", "a2", "a3"]) l.landing(name);
    l.audit("green", sha("a3"));
    for (const name of ["a4", "a5", "a6"]) l.landing(name);
    await sleep();
    l.audit("failed", sha("a6"));
    const { openFailure, lastGreen, latest } = l.summary();
    assert.deepEqual(openFailure?.suspects, [sha("a4"), sha("a5"), sha("a6")]);
    assert.equal(lastGreen?.commit, sha("a3"));
    assert.deepEqual({ status: latest?.status, commit: latest?.commit }, { status: "failed", commit: sha("a6") });
  } finally { l.log.close(); }
});

test("with no green audit every landing up to the first failing audit is a suspect, found by ancestry and not by submission or ledger order", () => {
  const l = ledger();
  try {
    const [b1, b2, b3] = [sha("b1"), sha("b2"), sha("b3")];
    // Submitted newest first, and b3 reported published before the older two (a recovered publication): ledger order
    // contradicts the integration branch's order, which the recorded bases give.
    for (const [id, commit] of [["z-b3", b3], ["y-b2", b2], ["x-b1", b1]] as const)
      l.log.append(id, { type: "submitted", repo: REPO, changeId: `change${commit.slice(0, 2)}`, commitId: sha(`src${commit.slice(0, 2)}`), bookmark: "slipjay/changes/x", submittedBy: "test" });
    l.log.append("z-b3", { type: "landed", base: b2, commitId: b3, branch: "main", remote: "origin" });
    l.log.append("x-b1", { type: "landed", base: sha("base"), commitId: b1, branch: "main", remote: "origin" });
    l.log.append("y-b2", { type: "landed", base: b1, commitId: b2, branch: "main", remote: "origin" });
    l.audit("failed", b3);
    assert.deepEqual(l.summary().openFailure?.suspects, [b1, b2, b3]);
    assert.equal(l.summary().lastGreen, null);
  } finally { l.log.close(); }
});

test("a green audit that is not an ancestor of the failing commit excludes only the landings the two share", async () => {
  const l = ledger();
  try {
    l.landing("c1");
    const shared = sha("c1");
    // The integration branch forked from c1 (a rewound branch): a side line c2x, audited green, then abandoned.
    l.landing("c2x", { base: shared });
    l.audit("green", sha("c2x"));
    l.landing("c2", { base: shared });
    l.landing("c3");
    await sleep();
    l.audit("failed", sha("c3"));
    assert.deepEqual(l.summary().openFailure?.suspects, [sha("c2"), sha("c3")]);
  } finally { l.log.close(); }
});

test("a failing audit whose commit the ledger never published has no suspects, and one that resolved no head none either", async () => {
  const l = ledger();
  try {
    l.landing("d1");
    l.audit("failed", sha("pushed-elsewhere"));
    assert.deepEqual(l.summary().openFailure?.suspects, []);
    await sleep();
    l.audit("failed", null);
    const failure = l.summary().openFailure;
    assert.deepEqual(failure?.suspects, []);
    assert.equal(failure?.audits.length, 2);
  } finally { l.log.close(); }
});

test("repeated failing audits of one defect are one open failure, a green audit closes it, and the next failure is a new one", async () => {
  const l = ledger();
  try {
    for (const name of ["e1", "e2"]) l.landing(name);
    l.audit("green", sha("e2"));
    l.landing("e3");
    await sleep();
    const first = l.audit("failed", sha("e3"));
    l.landing("e4");
    await sleep();
    const second = l.audit("failed", sha("e4"));
    await sleep();
    l.audit("cancelled");
    const open = l.summary().openFailure;
    assert.deepEqual(open?.audits, [first, second]);
    assert.deepEqual(open?.suspects, [sha("e3"), sha("e4")], "the failure's suspects grow as its audits repeat");
    await sleep();
    l.audit("green", sha("e4"));
    assert.equal(l.summary().openFailure, null);
    l.landing("e5");
    await sleep();
    const third = l.audit("failed", sha("e5"));
    const next = l.summary().openFailure;
    assert.deepEqual(next?.audits, [third]);
    assert.deepEqual(next?.suspects, [sha("e5")]);
  } finally { l.log.close(); }
});

test("a cancelled, interrupted or still running audit is no verdict: the earlier verdict stands", async () => {
  const l = ledger();
  try {
    l.landing("f1");
    l.audit("green", sha("f1"));
    await sleep();
    l.audit("interrupted");
    await sleep();
    l.audit("cancelled");
    await sleep();
    l.audit("running");
    const { latest, openFailure, lastGreen } = l.summary();
    assert.equal(latest?.status, "green");
    assert.equal(openFailure, null);
    assert.equal(lastGreen?.commit, sha("f1"));
  } finally { l.log.close(); }
});

test("an audit that skipped or reused anything, or ran fewer commands than it declared, is never green", async () => {
  for (const extra of [{ skipped: ["test"], passed: ["install"] }, { reused: ["test"] }, { passed: ["install"] }, { skipped: ["test"] }]) {
    const l = ledger();
    try {
      l.landing("g1");
      l.audit("green", sha("g1"), extra);
      const summary = l.summary();
      assert.equal(summary.lastGreen, null, JSON.stringify(extra));
      assert.equal(summary.latest?.status, "failed", JSON.stringify(extra));
      assert.ok(summary.openFailure, JSON.stringify(extra));
      assert.match(promotionRefusal(summary) ?? "", /no cause is recorded/);
    } finally { l.log.close(); }
  }
  const empty = ledger();
  try {
    empty.landing("g2");
    empty.log.append("audit-x", { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    empty.log.append("audit-x", { type: "audited", commit: sha("g2"), commands: [], passed: [], skipped: [], reused: [] });
    assert.equal(empty.summary().lastGreen, null, "an audit that ran nothing is not green");
  } finally { empty.log.close(); }
});

test("every kind of cause is recorded against the open failure and lifts the promotion refusal; the newest record stands", async () => {
  const causes: AuditCause[] = [{ kind: "culprits", landings: [sha("h2")] }, { kind: "culprits", landings: [sha("h1"), sha("h2")] }, { kind: "flake" }, { kind: "infrastructure" }, { kind: "unresolved" }];
  for (const cause of causes) {
    const l = ledger();
    try {
      l.landing("h1");
      l.landing("h2");
      const audit = l.audit("failed", sha("h2"));
      assert.match(promotionRefusal(l.summary()) ?? "", /The latest audit failed at .* and no cause is recorded/);
      assert.equal(l.summary().openFailure?.cause, null);
      l.cause(audit, cause);
      const failure = l.summary().openFailure;
      assert.ok(failure);
      const { by, at, ...recorded } = failure.cause!;
      assert.deepEqual(recorded, cause);
      assert.equal(by, "henry");
      assert.ok(at);
      assert.equal(promotionRefusal(l.summary()), null, JSON.stringify(cause));
    } finally { l.log.close(); }
  }
  const l = ledger();
  try {
    l.landing("h3");
    const audit = l.audit("failed", sha("h3"));
    l.cause(audit, { kind: "unresolved" });
    await sleep();
    l.cause(audit, { kind: "flake" });
    assert.equal(l.summary().openFailure?.cause?.kind, "flake");
  } finally { l.log.close(); }
});

test("a cause recorded on a failure stays with it as the defect repeats, and a new failure after a green audit has none", async () => {
  const l = ledger();
  try {
    l.landing("i1");
    const first = l.audit("failed", sha("i1"));
    l.cause(first, { kind: "flake" });
    await sleep();
    l.audit("failed", sha("i1"));
    assert.equal(l.summary().openFailure?.cause?.kind, "flake");
    assert.equal(promotionRefusal(l.summary()), null);
    await sleep();
    l.audit("green", sha("i1"));
    await sleep();
    l.audit("failed", sha("i1"));
    assert.equal(l.summary().openFailure?.cause, null);
    assert.match(promotionRefusal(l.summary()) ?? "", /Record one with slipjay audit cause/);
  } finally { l.log.close(); }
});

test("only a culprit whose landing had a green gate is an escape, and each is counted once across every failure", async () => {
  const l = ledger();
  try {
    l.landing("j1"); // green gate
    l.landing("j2", { gate: "skipped" }); // a settings landing: its checks did not run
    l.landing("j3", { gate: "none" }); // published without a recorded gate
    l.landing("j4"); // green gate
    const first = l.audit("failed", sha("j4"));
    l.cause(first, { kind: "culprits", landings: [sha("j1"), sha("j2"), sha("j3")] });
    assert.equal(l.summary().escapes, 1, "only j1's gate was green");
    await sleep();
    l.audit("green", sha("j4"));
    await sleep();
    const second = l.audit("failed", sha("j4"));
    l.cause(second, { kind: "culprits", landings: [sha("j1"), sha("j4"), sha("never-landed")] });
    assert.equal(l.summary().escapes, 2, "j1 again is the same escape; j4 is a second; an unknown commit counts for nothing");
    await sleep();
    l.audit("green", sha("j4"));
    await sleep();
    const third = l.audit("failed", sha("j4"));
    l.cause(third, { kind: "flake" });
    assert.equal(l.summary().escapes, 2, "a flake blames no landing");
  } finally { l.log.close(); }
});

test("the log reads each published landing's gate: green, skipped for a settings landing, or none, oldest first", () => {
  const l = ledger();
  try {
    l.landing("k1");
    l.landing("k2", { gate: "skipped" });
    l.landing("k3", { gate: "none" });
    l.log.append("landing-failed", { type: "submitted", repo: REPO, changeId: "changek4", commitId: sha("srck4"), bookmark: "slipjay/changes/k4", submittedBy: "test" });
    l.log.append("landing-failed", { type: "failed", stage: "verifying", reason: "no" });
    l.log.append("landing-elsewhere", { type: "submitted", repo: "owner/other", changeId: "changek5", commitId: sha("srck5"), bookmark: "slipjay/changes/k5", submittedBy: "test" });
    l.log.append("landing-elsewhere", { type: "landed", base: sha("x"), commitId: sha("k5"), branch: "main", remote: "origin" });
    const landings = l.log.landings(REPO);
    assert.deepEqual(landings.map(({ commitId, base, gate, changeId }) => ({ commitId, base, gate, changeId })), [
      { commitId: sha("k1"), base: sha("base"), gate: "green", changeId: "changek1" },
      { commitId: sha("k2"), base: sha("k1"), gate: "skipped", changeId: "changek2" },
      { commitId: sha("k3"), base: sha("k2"), gate: "none", changeId: "changek3" },
    ]);
    assert.deepEqual(l.log.landings("owner/other").map((landing) => landing.commitId), [sha("k5")]);
    assert.deepEqual(l.log.landings("owner/none"), []);
  } finally { l.log.close(); }
});

test("a repository is overdue when its last green audit finished more than 26 hours ago", () => {
  const l = ledger();
  try {
    assert.equal(l.summary().overdue, false, "a repository with no audits is not late");
    l.landing("m1");
    l.audit("green", sha("m1"));
    const finished = Date.parse(l.summary().lastGreen!.finishedAt);
    assert.equal(l.summary(new Date(finished + AUDIT_OVERDUE_AFTER_MS)).overdue, false);
    assert.equal(l.summary(new Date(finished + AUDIT_OVERDUE_AFTER_MS + 1)).overdue, true);
    // Failing audits since do not make the green one fresher.
    l.audit("failed", sha("m1"));
    assert.equal(l.summary(new Date(finished + AUDIT_OVERDUE_AFTER_MS + 1)).overdue, true);
  } finally { l.log.close(); }
});

test("a repository that audits but was never green is overdue from its first audit, not before", () => {
  const l = ledger();
  try {
    l.landing("n1");
    l.audit("failed", sha("n1"));
    const submitted = Date.parse(l.log.audits(REPO)[0]!.submittedAt);
    assert.equal(l.summary(new Date(submitted + 3_600_000)).overdue, false);
    assert.equal(l.summary(new Date(submitted + AUDIT_OVERDUE_AFTER_MS + 1)).overdue, true);
  } finally { l.log.close(); }
});

test("the promotion is refused only while the latest audit's failure has no cause", async () => {
  const l = ledger();
  try {
    assert.equal(promotionRefusal(l.summary()), null, "no audits, nothing to refuse");
    l.landing("o1");
    const audit = l.audit("failed", sha("o1"));
    const refusal = promotionRefusal(l.summary());
    assert.match(refusal ?? "", new RegExp(`latest audit failed at ${sha("o1").slice(0, 12)}`));
    assert.match(refusal ?? "", new RegExp(`Suspects: ${sha("o1").slice(0, 12)}\\.`));
    await sleep();
    l.audit("interrupted");
    assert.ok(promotionRefusal(l.summary()), "an interrupted run after the failure does not clear it");
    l.cause(audit, { kind: "infrastructure" });
    assert.equal(promotionRefusal(l.summary()), null);
  } finally { l.log.close(); }
});

test("a cause attaches to the open failure's newest audit, or to a failing audit named, and never to one that did not fail", async () => {
  const l = ledger();
  try {
    l.landing("p1");
    const green = l.audit("green", sha("p1"));
    assert.deepEqual(auditToExplain(l.log.audits(REPO), l.summary()), { ok: false, reason: "The latest audit did not fail, so there is no open failure to explain; name an earlier failing audit with --audit" });
    await sleep();
    const first = l.audit("failed", sha("p1"));
    await sleep();
    const second = l.audit("failed", sha("p1"));
    const audits = l.log.audits(REPO);
    const target = auditToExplain(audits, l.summary());
    assert.ok(target.ok && target.audit.id === second);
    const named = auditToExplain(audits, l.summary(), first);
    assert.ok(named.ok && named.audit.id === first);
    assert.equal(auditToExplain(audits, l.summary(), green).ok, false);
    assert.equal(auditToExplain(audits, l.summary(), "audit-unknown").ok, false);
  } finally { l.log.close(); }
});

test("culprits resolve by landing operation id or published commit, in full or by a 12-digit prefix, and must be landings of the repository", () => {
  const l = ledger();
  try {
    const first = l.landing("abcdef012345");
    l.landing("abcdef012399");
    const landings = l.log.landings(REPO);
    assert.deepEqual(resolveCulprits([first], landings), { ok: true, commits: [sha("abcdef012345")] });
    assert.deepEqual(resolveCulprits([sha("abcdef012399")], landings), { ok: true, commits: [sha("abcdef012399")] });
    assert.deepEqual(resolveCulprits(["abcdef012345", first, sha("abcdef012345")], landings), { ok: true, commits: [sha("abcdef012345")] }, "named three ways, one culprit");
    assert.deepEqual(resolveCulprits(["abcdef0123"], landings), { ok: false, reason: "abcdef0123 is not a landing this runner published for the repository" }, "too short to name a commit");
    assert.deepEqual(resolveCulprits(["abcdef01234"], landings), { ok: false, reason: "abcdef01234 is not a landing this runner published for the repository" });
    assert.deepEqual(resolveCulprits([], landings), { ok: false, reason: "Name at least one culprit landing" });
    assert.equal(resolveCulprits(["f".repeat(40)], landings).ok, false);
  } finally { l.log.close(); }
});

test("the metrics export's stored events give every repository the same summary as the log's projections", async () => {
  const l = ledger();
  try {
    l.landing("q1");
    l.landing("q2", { gate: "skipped" });
    l.landing("q3");
    l.audit("green", sha("q1"));
    await sleep();
    const failed = l.audit("failed", sha("q3"));
    l.cause(failed, { kind: "culprits", landings: [sha("q3"), sha("q2")] });
    await sleep();
    l.audit("cancelled");
    // Another repository, whose audit is its own.
    l.log.append("other-audit", { type: "submitted", kind: "audit", repo: "Owner/Other", commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    l.log.append("other-audit", { type: "audit_head", commit: sha("o1") });
    l.log.append("other-audit", { type: "failed", stage: "verifying", reason: "no" });
    const now = new Date(Date.now() + 30 * 3_600_000);
    const fromEvents = auditSummariesFromEvents(l.log.events(), now);
    assert.deepEqual([...fromEvents.keys()].sort(), ["owner/other", REPO]);
    assert.deepEqual(fromEvents.get(REPO), l.summary(now));
    assert.equal(fromEvents.get(REPO)?.escapes, 1);
    assert.equal(fromEvents.get(REPO)?.overdue, true);
    assert.equal(fromEvents.get("owner/other")?.openFailure?.audits[0], "other-audit");
    assert.equal(fromEvents.get("owner/other")?.escapes, 0);
    assert.equal(auditSummariesFromEvents([], now).size, 0);
  } finally { l.log.close(); }
});

test("a commit a recovery published stays in the audit ancestry, in the log's projections and the metrics export alike", () => {
  const l = ledger();
  try {
    l.landing("r1");
    l.audit("green", sha("r1"));
    // r2 integrated, was held when publication failed, and a recovery published it.
    l.log.append("landing-held", { type: "submitted", repo: REPO, changeId: "changer2", commitId: sha("srcr2"), bookmark: "slipjay/changes/r2", submittedBy: "test" });
    l.log.append("landing-held", { type: "integrated", base: sha("r1"), commitId: sha("r2") });
    l.log.append("landing-held", { type: "failed", stage: "publishing", reason: "remote unavailable" });
    l.log.append("recovery-r2", { type: "submitted", kind: "recovery", repo: REPO, commitId: sha("r2"), submittedBy: "runner:recovery" });
    l.log.append("recovery-r2", { type: "landed", base: sha("r1"), commitId: sha("r2"), branch: "main", remote: "origin" });
    l.audit("failed", sha("r2"));
    const now = new Date();
    assert.deepEqual(l.summary(now).openFailure?.suspects, [sha("r2")]);
    assert.deepEqual(auditSummariesFromEvents(l.log.events(), now).get(REPO), l.summary(now));
  } finally { l.log.close(); }
});
