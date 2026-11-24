# Release

A repository that declares a `releaseBranch` in `slipjay.json` promotes its
integration branch to it only through `slipjay promote`:

```json
{ "integrationBranch": "develop", "releaseBranch": "master",
  "requiredReleaseVerification": [{ "executable": "bun", "args": ["run", "check:static"] }] }
```

`requiredReleaseVerification` takes the same command shape as
`requiredLandingVerification`. A release branch without it is refused; declare `[]`
to release without checks. The policy that applies is the one committed in the
candidate. The retired `slipjay release` command refuses with a pointer to
`slipjay promote`; it performs no promotion.

A candidate that declares a `production` deployment is a promotion. The plan reads
the runner: its candidate is the newest commit staging deployed (not the integration
tip), and it lists the paths the release touches. When the owner approved an earlier
candidate that did not ship (its verification failed and a fix landed), the plan's
`delta` and `subjects` show only the commits, paths and migration artifacts since
that approval. The runner refuses to release a commit staging did not deploy. Once
the release branch holds the candidate, the runner deploys production from exactly
that commit in the deploy lane, and `--confirm` follows it: the promotion ends
`deployed`, or `deploy failed: <project> (<reason>)` (exit 1). Rerunning `--confirm`
deploys a failed promotion again and reuses one that deployed.

By default the candidate is the newest staging-green commit. When Preview (staging) runs
newer, unaccepted work, `slipjay promote --candidate <commit>` plans the release of an
older commit instead, and `slipjay promote --confirm <commit>` releases it. It is allowed
only when staging recorded a green (deployed, health-passed) deploy of exactly that
commit, and it is on the integration branch and is not behind the release: it
contains every integration commit the release branch already holds, so it is a prefix of integration history. Anything else is refused with the
reason: a commit staging never deployed green, one that is behind the release or on
another line. Every other rule applies to it as to the newest:
the pre-verification, migrations, an audit refusal, and approval coverage computed against
that candidate. The deploy hooks map a commit to the images built at its staging deploy, so
promoting it ships exactly what staging verified for it. The plan's `candidateSource` is
`newest_green` or `requested`; for `requested`, `newerGreen` lists the newer green commits it
leaves out, newest first. A `--candidate` plan whose commit has no pre-verification asks the
runner to queue one (`POST /v1/verifications`), which neither supersedes nor delays the
newest green commit's; the plan reports it `queued` and a confirm before it passes verifies
as usual. A newer green staging deploy supersedes a queued requested pre-verification like any
queued one, and planning again requests it afresh (a superseded or cancelled one counts as none).
The runner lists the staging-green commits for this (`stagingGreenCommits` of the promotion
state); against an older runner that does not, only the newest green commit can be chosen, and
asking for another says the runner is too old to list older green commits. `--candidate` on a
repository that does not ship by promotion is refused. The runner also checks the prefix rule
itself when it runs the release, and refuses such a commit
before verifying or publishing.

## Pre-verification and approval coverage

A promotion is verified before anyone approves it. When staging records a green
deploy of a commit, the runner queues a **pre-verification** of it. This runs the
candidate's `requiredReleaseVerification` exactly as a confirm would, in the release
checkout, and publishes nothing. It is admitted like a release, in arrival order: it
starts once no reset of its repository runs and a worker is free, however many landings
arrived after its green deploy, and it neither
waits for the repository's landings nor is stopped by one. Landings, resets and
other repositories' work that arrive later wait for a free place instead of
stopping it, so release verification is never starved by a stream of landings, and the
workers still bound the total load. A release of the same commit waits for the
pre-verification and reuses its pass. So at most one pre-verification runs per
repository. Each pre-verification stage has a wall-clock deadline: five minutes
for fetching, thirty minutes for installing (including post-install inspection), and
one hour for verifying. A deadline fails the operation with its stage and elapsed
budget, freeing its worker and lane. `runner kill` interrupts these waits as well
as its subprocesses; late continuations cannot start another command or count as a pass.
A newer green staging deploy supersedes a queued pre-verification; a
running one finishes. Only a runner restart returns a running one to the queue
(`yielded`). The runner lists them at `GET
/v1/verifications?repo=`.

The plan reports the candidate's pre-verification. It also says whether the earlier
approval covers the candidate:

```json
"verification": { "status": "failed", "commit": "<candidate>", "operationId": "op_…",
  "failedCommand": "bun run verify:release" },
"approval": { "approvedCandidate": "<earlier candidate>", "covered": false,
  "reasons": ["4f0c2a9e1b7d (Add exports) names Forge: #2961, which the approved range does not"] }
```

- `verification.status` is `queued`, `running`, `failed` (with the `failedCommand`
  when a check failed), `passed`, or `none`. `passed` means the candidate's newest
  pre-verification passed against the current release base with the checks the
  candidate declares. A pass against an older base or other checks counts as `none`.
  `operationId` is null for `none`.
- `--confirm` of that candidate reuses a `passed` pre-verification. It skips
  installing and verifying, still rechecks the release base before publishing, and
  its result's `verification` is `{ "preverified": "<operationId>" }`. Otherwise it
  verifies as described below.
- `approval.covered` is true only when the owner approved an earlier candidate that
  has not shipped, and both of these hold:
  - no commit since it adds or changes a file under
    `migrationFinalization.artifactPaths`;
  - every commit since it names no work item, or only items the approved range
    (`base..approvedCandidate`) already names. Work items are read from `Forge: #N`
    and `Issue:` trailer lines.

  A re-ask of exactly the approved candidate is covered. `reasons` names each rule
  that failed and the commits involved. It is also non-empty when there is no such
  approval, when the candidate does not descend from it, or when SlipJay cannot
  compare them. When coverage holds, `next` says so. SlipJay decides no authority.
  `covered` is a conservative signal that the earlier yes saw everything that
  matters. Whether to act on it is the approver's policy.

Both fields appear on promotion plans that have commits to release.

## Publication policy

**Publication process (YS-565).** Every readable landing policy stamps the `landed` event, landing outcome and Forge publication receipt with `process: "development" | "standard"`. The stamp names the release policy actually applied (the release branch policy for a release repository; otherwise the landed repository policy), with `light` recorded as `standard`. Forge keeps it as publication evidence: later policy changes cannot change that publication's acceptance path. Older or unreadable policy evidence remains unstamped and Forge treats it as standard unless the same publication's runner history explicitly records its process. Deploy Forge's optional receipt field before installing this runner.

## Automatic promotion

**Automatic promotion (`process: "development"`).** When the policy committed on the release
branch, at the base the pre-verification ran against (never the candidate's policy), has
`process: "development"`, the runner skips staging: a landing is pre-verified as soon as it
publishes (the landing gate was its evidence), its `declaredEnvironments` omit `staging`, and no
scheduled staging deploy follows it (`slipjay deploy staging` still deploys by hand). The setting is read from the release branch, never the candidate. A human `slipjay promote --confirm` skips staging too: it goes straight to production with any commit whose pre-verification passed against the release base, which stands in for the staging deploy, and `slipjay promote` plans the integration head (or `--candidate`) without one. That confirm is how the owner ships what the runner leaves for them, such as non-additive migrations. Switching to `standard` restores the whole staging flow. It queues a
release by itself of the newest landed candidate whose pre-verification passed, looking back no further than the newest commit already released or
tried. A newer landing that is still verifying, or whose verification failed, does not hold it
back, so a stream of landings cannot keep every verified commit from shipping; the newer commit
ships in turn once its own verification passes. It is the release `slipjay promote --confirm`
submits, in the same release queue, so landings, resets and releases keep their order, and it reuses
the passed pre-verification. The release, its production deploy and the `slipjay promote --confirm`
and `slipjay deploys` output carry `automatic: { "setting": "process", "value": "development" }`, and
the runner log says `promoting <commit> automatically`. The safeguards stay: nothing is promoted
automatically when the candidate has `nonAdditiveMigrations`, when its verification failed or is
missing, or when the audits refuse a promotion; a failed production health check rolls back as
[described below](#rollback-and-non-additive-migrations). Such a candidate stays unpromoted, with the reason (`Not promoting <commit> automatically:
…`) on its pre-verification's log. That note also records what the promotion waits on, which
`slipjay watch --json` reports as `release.waitingOn.kind` (T3-700): `withheld` when someone must decide
(non-additive or unassessed migrations, a release base that does not promote), `scheduled` with the slot's
time in `waitingOn.at` for the routine wait below, and the step it waits on when running work holds it.
`failed` means a release step failed. A `withheld` promotion is reported ahead of an audit that also refuses it,
since it is the hold a person must clear. A reader of `waitingOn` must accept a kind before a runner sends it.
A candidate with a release, or a production deploy, on record, or
any release or production deploy in flight, is never released again; a newer verified candidate
replaces a queued automatic release of an older one, and an automatic release that starts after one
has passed fails as superseded. Under `standard` and `light` nothing promotes without a human `--confirm`.

## Batched promotion

**Batched promotion (`promotionSchedule`).** Undeclared, development mode promotes each verified
landing as soon as it can. A release-branch policy may batch them instead:
`"promotionSchedule": { "everyMinutes": 30, "from": "08:00", "until": "20:00", "timeZone": "Europe/London" }`.
The runner then starts an automatic promotion only while the repository's local time is from `from`
until `until` (a window may cross midnight), and no sooner than `everyMinutes` after the newest
release, automatic or confirmed; the landings between promotions ship together as the newest
verified candidate. A candidate it holds says `Not promoting <commit> automatically: waiting for the
next scheduled promotion: …` on its pre-verification's log, and the runner asks again when the next
slot opens. The slot comes before the safeguards: a candidate with non-additive migrations reads as
`scheduled` until its slot refuses it and `withheld` after, so the agent that landed it has until then
to release it. The schedule is read, like `process`, from the release base. It never holds an owner:
to ship now, `slipjay promote` shows the candidate and `slipjay promote --confirm <commit>` promotes
it at once, which also restarts the interval. Instead of an interval, `"promotionSchedule": { "at": ["00:00", "12:00", "18:00"], "timeZone": "Europe/London" }`
promotes at fixed times of the local day: each stays open for an hour, once, so a candidate ready or a check re-run within
that hour still ships in its slot, and later than that a candidate waits for the next time. An owner's promotion leaves
the next time in place. It needs a runner on SlipJay 3.47.0 or later: an older
runner keeps the field without reading it and promotes every verified landing, so restart the runner
on the new build before relying on it.

## Batch checks

**Batch checks (`batchVerification`, SJ-192).** A development-mode repository may move its broad tests
from every landing to a batch check, run when a promotion falls due and, with `everyMinutes`, continuously in the
background (below): `"batchVerification": { "machine": "release-check" }` beside
`promotionSchedule`. Like every promotion setting it is read from the release branch's policy, never the candidate's.
A landing then queues no pre-verification of its own; its landing gate can stay narrow. When a scheduled promotion
falls due and something new has landed, the runner freezes the integration head and queues its **batch check**: a
pre-verification that runs `requiredReleaseVerification` over the combined change from the commit Production serves
(its last healthy deploy, so a failed deploy or rollback is accounted for; the release branch while nothing is served)
to that head. Landings after the freeze wait for the next batch. The check runs on the build machine of pool
`machine`, a boat VM held for it alone (on the runner host when the runner has no remote verifier). A green check promotes and deploys as before; nothing deploys
without a complete green batch check of the exact commit, or, with `promoteFlaky`, a flaky one whose rerun passed every
suite that failed (below). `slipjay promote --confirm` of a candidate without one asks
the runner for its batch check at once, whatever the schedule, follows it to its end and confirms only if it passed;
an open or passed check of that commit is reused, and a red one refuses. Scheduled checks wait while any check is
open for the repository. Automatic checks cannot displace queued confirms, and confirms of different commits stay
queued in arrival order, ahead of automatic checks. A confirm can stop another batch's diagnosis (including a
background batch's): the batch remains red with incomplete diagnosis and no shorter candidate. The promotion plan's
`latestBatch` shows another batch, preferring the newest queued or running check, otherwise the newest completed
check and its failure reason if any. It is not verification of the plan's exact candidate.

**Continuous checks (`batchVerification.everyMinutes`, SJ-202).** With `everyMinutes` (1 to 1440), the runner also
checks the newest landing in the background, so a promotion usually finds its tip already checked and a breakage is
named soon after it lands. A background check is an ordinary batch check from the commit Production serves to the
newest landing. It waits while another check, release or production deploy is open, or a landing is queued or waiting
for a gate place. A pass against an older release branch tip no longer covers the landing: the runner checks it again
in the background or when a promotion is due. Automatic promotion selects the newest eligible landing with a pass
against the current release branch; a stale-base refusal does not disqualify a landing from trying again.

Normally the background interval runs from the last check's start. After a red, unverified flaky, or infrastructure
outcome, it runs from that check's finish instead, using `batchVerification.retryMinutes` (1 to 1440; defaults to the
lesser of `everyMinutes` and 10). A red head still waits for a new landing. A confirm of another commit stops a
running automatic check (background or scheduled batch) that has not entered diagnosis: it ends `stopped`
(cancelled, never a failure, never infrastructure, never routed) and its head is checked again later. Diagnosis of a red check
considers only the landings after the newest one whose complete check passed (`after` on `batch_started`), and a
culprit an earlier check already routed for the same suites is recorded `batch_unrouted` (`already routed by batch
check …`) instead of being sent to Forge again. When a runner machine's release-check place serves the pool `machine` names
([runner](runner.md#named-ssh-gate-places)), checks and the nightly audit run there, ranked above agent work for CPU, and on the
pool's boat VMs only while it is down (the audit, which never used boat, runs on the runner host then, and says so);
otherwise the audit runs on the runner host as before. A flaky or infrastructure background check is checked again on
the recovery interval, at most three complete checks of one head, unless `promoteFlaky` verified it.
A check that changed the source it ran on (a boat VM's tree differs once the check ends, or the host checkout differs
from the commit) is not evidence for it: the batch fails, routes nothing and is checked again like infrastructure.

Every release verification command (batch checks, their reruns and diagnosis, and pre-verifications alike) is given
its exact, immutable base and head as `SLIPJAY_RELEASE_BASE` and `SLIPJAY_RELEASE_HEAD`, so a selector never has to
assume the candidate's parent is the integration branch. A command that reports per-suite verdicts adds `outcomes`
(`[{ "suite", "outcome": "passed" | "failed" | "missing" }]`) to its test-report manifest; a rerun is then narrowed to
the failing suites with `SLIPJAY_RELEASE_SUITES` (comma-separated), and `missing` marks a suite the selection does
not hold at that revision. A command without `outcomes` is rerun whole.

A failed batch is handled in this order:

- **Infrastructure** (the VM never became ready, setup or install failed, a command could not be spawned, or a
  capability was missing) is never a regression: the batch ends `infrastructure`, routes nothing, and the same head is
  checked again, at most three complete checks in all.
- **Flaky:** what failed is rerun once on the same head; if it passes, or fails only tests the first run passed, the
  batch ends `flaky`, routes nothing, and the head needs another complete green check before it deploys. A regression
  is the same failure twice; a loaded machine fails a different timing test each time. When either run names no failing
  test, or either run's list reached its 100-test bound, any suite failing twice counts. A build failing twice is
  never flaky.
  With `batchVerification.promoteFlaky: true`, a flaky check whose rerun passed everything it ran (every test that
  failed once passed on the same head, and none failed twice) verifies its head instead, provided its images built,
  and its `batch_outcome` says `verified: true`. A rerun that failed other tests still needs a complete green check.
- **Red: diagnosis.** SlipJay bisects the batch for each key that still fails at the head, using the same base for
  every probe. Keys whose search windows overlap at a landing share the probe. A prebuild-only probe skips the
  checks; a probe that does not need prebuild skips the build. With conclusive probes this takes at most
  logarithmically many probes per key. Diagnosis locates a passing-to-failing boundary for each key, not every
  earlier break and repair. A missing test suite keeps its earlier state; an inconclusive prebuild is unknown.
  Build errors retain the image and specific causes rather than just the BuildKit wrapper. When both builds report a
  recognizable failure, a probe with a different image or without all the head's causes does not reproduce that
  failure. Diagnosis can reuse conclusive historical build and suite verdicts from bounded runner-memory caches
  (suite verdicts are scoped to the served base and check declarations). Complete checks and head reruns are fresh;
  a successful production deploy clears the repository's cached verdicts.
  A probe lost to infrastructure is retried once; a second loss leaves that probe unknown and diagnosis
  `incomplete`. If an unknown still lies at the boundary, the failure is **unattributed**, between the last
  passing landing (or the base) and the failing bound. An inconclusive prebuild outside the final boundary
  does not make diagnosis incomplete on its own.
  Diagnosis never promotes: the commit before the earliest possible culprit is queued for a complete batch check
  of its own and ships only if that passes.
- **Routing.** Each culprit commit maps to its landing operation in the ledger, and Forge maps that operation to its
  Spec through its own attempt records (never commit trailers): the runner calls Forge's `recordBatchCheck`, which
  records a failed `batch_check` run with a blocking finding on that Spec (base and head, culprit commit and operation,
  failing tests and output) and, while the Spec's lead session is open, a `batch_failure` note T3 delivers to the lead
  thread. The record is keyed by batch and culprit, so a restart or retry never records it twice; one Forge could not
  be reached for is sent again later and at startup. A culprit with no Forge association (a chore, or a landing Forge
  never recorded) is kept on the batch record (`batch_unrouted`) with its commit, operation and workspace. An earlier
  permanent refusal for the same landing and suites is recorded as already unassociated instead of sent again. The owner
  disposes the finding through Forge's usual route (`fix` makes a repair Ticket and reopens the Spec), and the fix lands
  through the ordinary landing gate. A revert is an ordinary landing too; the runner never reverts.

The ledger records `batch_started` (base, head, machine, the landings diagnosis considers, `after` and `background`), each `batch_run` (complete, rerun, diagnosis, with
its setup time), `batch_outcome`, and `batch_routed` / `batch_unrouted`. `slipjay metrics` reports per repository the
landing gate's time (verifying, or screening where a landing published without it, plus remote setup), the batch
checks run and how each ended, the culprits with their Forge items, red batches no green one has followed, the median
time from a red batch to the next green one, scheduled checks' setup, how many red batches had a culprit that
passed its own landing gate, background checks, stops, checks a day, the CPU time checks used on a machine place, and
the time from a landing published 08:00 to 20:00 London to the end of the first green or red check that covers it. It needs a runner on SlipJay 3.51.0 or later; an older runner ignores the field and
pre-verifies every landing.

## Rollback and non-additive migrations

When recovery can be proven, a failed production promotion is rolled back
automatically: production
keeps (or is moved back to) what it served before, the release branch returns to
the commit before the release merge (unless a later release moved it), and the
deploy's `rollback` and reason say so. `rollback.automatic` is true only after every
project is proven restored or unchanged and the release pointer actually returned.
An unknown outcome or a failed pointer return records `automatic: false`. So
`production` must declare `activate` for every project. A project that could not
be moved back is named, and the release branch stays on the release because
production may still serve the candidate. Rollback is
code only. The plan's `nonAdditiveMigrations` names migration artifacts not known to be additive:
any that is neither SQL nor JSON metadata (such as Drizzle's `meta/` snapshots and journal,
which are never counted), and SQL ones that drop,
rename, retype, delete or rewrite something, or tighten what an existing table accepts
(a heuristic, `nonAdditiveSql` in `src/lib/release/release.ts`: it does not flag tables or
columns the migration itself adds, or a CHECK dropped and added back under the same
name as an `IN (...)` list over one column, so an enum that gained a value is additive, or a plain index dropped
and then created again under the same name, as Drizzle writes when an index's columns change; whether the dropped
index was unique is not in the SQL, so uniqueness removed that way is not flagged), and its `next` repeats them: a
failed promotion carrying one, including a rerun confirm of it, is left as it is,
with nothing moved back, for the owner to decide, once its migrations may have changed
the schema: they were applied or failed part-way, were already in place, an earlier
deploy of the same commit did any of that, or the environment declares no `migrations`
(they may have been applied by hand). A deploy that failed before them (a build or
health check) or whose first verify refused, with no such earlier deploy, changed
nothing, so it rolls back and restores earlier projects as usual.

A migration's author can declare that the release before it works on the schema it leaves, until the new release
takes traffic and again after a rollback, with `-- slipjay:previous-release-compatible` as the first line of the SQL
(`PREVIOUS_RELEASE_COMPATIBLE`). `nonAdditiveSql` then takes the file as additive however it rewrites rows. The ordering
is still per promotion: when every migration file in it is additive or declared, they migrate before any project deploys,
so the candidate's app never starts against the old spelling, a failed promotion rolls back automatically, and the runner
promotes it without the owner; one undeclared non-additive file sends all of them last. It is a claim the plan cannot check, so the
declaring repository's review must. A rename the previous release cannot tolerate is not declarable: split it into a
release that accepts both spellings, the rewrite, and a later removal of the old spelling. Without the line the file is
classified and ordered as above, and the migration runs last, just before traffic moves, so the candidate must not
write the new spelling at start-up.

A generated migration cannot gain the line once it has landed, since landing refuses an edit to a generated artifact.
The repository declares such a file instead in `migrationFinalization.previousReleaseCompatible`, a list of its SQL
paths under `artifactPaths`; the candidate's policy is the one read, and the plan takes a listed file as it would one
carrying the line. It is the remedy for a file that landed undeclared but whose candidate cannot pass its health check
on the schema before it: one whose new code reads what the migration adds.

## Confirming and publishing

1. `slipjay promote` fetches and plans: the candidate (the integration branch on
   the remote), the base (the release branch on the remote), the commits between
   them, the declared checks, and any files under
   `migrationFinalization.artifactPaths` in that range. It publishes nothing.
2. After explicit human approval of that candidate, `slipjay promote --confirm
   <commit>` checks locally that the candidate is published on the integration
   branch (and, for a release that is not a promotion and carries migration
   artifacts, that `--migrations-ready` was given), then
   submits it to the runner (see [Runner](runner.md#runner)); a confirm needs a runner
   location. Releases take turns in their repository's release queue on the runner,
   beside its landings: the runner checks the exact candidate out in the release
   checkout, prepares its dependencies and runs the checks while landings go on
   (a promotion whose pre-verification passed skips this; see above).
   Their failure publishes nothing and prints the failing command and its output
   verbatim. A verified release then waits for the repository's running landing or
   reset (its progress says `Verified; publishing after <repo>'s running turn`), and
   a landing submitted meanwhile waits behind its publication, printing `queued
   (position 1, behind release 16bea7013436)`. Publication rechecks that the release
   branch is still the planned base, so a release branch moved during verification
   publishes nothing. If the install or a check changed tracked
   source, the verified tree is not the candidate's: the release publishes nothing,
   lists the changed paths and restores the candidate. The terminal follows the stages (`verifying`,
   `publishing`, `finalizing`); Ctrl-C stops following, and rerunning the same
   confirm follows the open release of that candidate instead of submitting a
   second.

   A confirm of a candidate the release branch already holds (a newer release
   shipped it) verifies nothing: it returns `"status": "released_by"` with the
   release `merge` that shipped it and that merge's candidate as `releasedBy`.
3. It builds the merge `Release <integration> to <release>` (parents: base, then
   candidate; a `Release-Candidate:` trailer) and refuses unless the merge is
   conflict-free and its tree is the candidate's, so a release branch with changes
   the integration branch lacks is refused rather than merged.
4. It pushes the release branch and fetches to confirm the merge reached the remote,
   even if the push reported an error. It retries known temporary remote storage or
   network errors at most twice, and only if the remote still points to the planned
   base. Returning a release uses the same retry limit, requiring the remote to still
   point to the release merge. The runner's operation log records the release.

## Migration readiness

A promotion's migration artifacts are applied by the runner (see [Production
migrations](deployments.md#deploys)): its production deployment must declare `migrations`, and
`--migrations-ready` is refused. A release that is not a promotion and whose range
carries migration artifacts needs `--migrations-ready`: apply those migrations
where the release branch deploys first; slipjay does not migrate it.

## Release watchdog

On a systemd runner host, `scripts/install-release-watchdog.sh` copies the standalone
probe and enables the user timer. It preserves
`~/.config/slipjay/release-watchdog-webhook.url`; provide the HTTP(S) endpoint in
that file (mode `0600`) before enabling the timer, or supply
`--webhook-url <url>` at install time to write it with owner-only permissions.
The existing runner host's user systemd session must stay up after logout.

The probe defaults to `pechhe/yardsmith`. It reads the runner service status
and opens `~/.slipjay/runner/operations.sqlite` read-only. It alerts for:

- An inactive runner (30-minute cooldown).
- A verification or release in its current stage for more than 45 minutes,
  or a deploy in its stage for more than 20 minutes (2 hours). Queued work is excluded.
- A fresh unassociated culprit in the newest completed red batch (24 hours per culprit),
  or an unbroken red streak lasting at least 45 minutes (2 hours). Superseded,
  cancelled and stopped batches are ignored.
- Two non-passing flaky or infrastructure batches in the last 3 hours (2 hours).
- The latest production deploy if it failed after the last success (2 hours).
- The latest nightly audit if it failed within the last 6 hours (6 hours).

A successful delivery starts cooldown; a later healthy observation clears
the recovered key. Failed deliveries remain due next run. Use
`bun scripts/release-watchdog-probe.ts --dry-run --repo owner/name` to inspect
without posting or updating state; `--db`, `--webhook-file` and `--cooldown-file`
override paths. This check is independent of the runner's immediate
[`releaseAlertWebhook`](runner.md#state) and never changes the ledger.
