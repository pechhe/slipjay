# Changelog

## v3.46.3

- **A partially written checkout is named, not reported as edited or unlanded work:** a workspace missing most of the tracked files
  its sparse patterns include (as an interrupted checkout leaves it) used to read as edits since its last snapshot or unlanded work,
  and a sweep, cleanup or `remove` would snapshot the missing files as deletions. Inspection, the sweep, `prune --plan`, `cleanup` and
  `remove` now read the last snapshot and the disk, name the missing and expected tracked-file counts, and snapshot and remove nothing;
  the message says how to inspect the last snapshot, restore the checkout (`slipjay start --base <workspace>@`) or delete it
  (`remove --discard`). Files outside a sparse checkout's patterns no longer count as edited. A few deleted files remain ordinary edits.
## v3.46.2

- **Large retained descriptions no longer break landing assembly:** assembling a submitted stack or merge into its landing
  candidate passed the first-parent commits' descriptions together as one `--message` argument, and a total over the operating
  system's per-argument limit (128 KiB on Linux) failed with `spawn E2BIG`. That also made the runner's conflict probe skip its check
  for the submission. The description now goes to `jj describe --stdin`; first-parent selection, source identity and the probe's
  advisory behaviour are unchanged. The bounded process interface (`runWorkspaceCommand`) gained an `input` for stdin.

## v3.46.1

- **A candidate refused before queuing no longer leaves a copy on the remote:** when the runner refuses a submission without
  creating an operation, `slipjay land` now deletes the candidate it pushed and forgets its local bookmark. The retained copy made
  an author's full fetch import it beside the rewrite of the same change (a rebase after the refusal), so the change was divergent
  and the next `slipjay land` failed on it until the author abandoned a commit by hand.

## v3.46.0

- **Promote an older staging-green commit:** `slipjay promote --candidate <commit>` plans, and `--confirm <commit>` releases,
  a commit older than the newest one staging is green on, for when Preview runs newer, unaccepted work. It must have a green
  staging deploy of exactly that commit and not be behind the release branch (a prefix of integration history containing every integration commit it holds);
  anything else is refused with the reason. Pre-verification, migrations, audit refusal and approval coverage apply to it as to
  the newest. The plan reports `candidateSource` (`newest_green` or `requested`) and, for `requested`, the `newerGreen`
  commits it leaves out. A requested commit without a pre-verification gets one queued through the new `POST /v1/verifications`,
  which never supersedes or delays the newest green commit's. Without `--candidate`, behaviour is unchanged.

## v3.45.1

- **A published landing is always reported as landed:** `slipjay land` now prints the runner's verdict (the published commit
  and the operation id) the moment the operation lands, before any local step. A local step after publication that fails (fetching
  or looking up the published commit, recording the landing, updating a stale working copy, dropping a superseded candidate,
  releasing the workspace) is a `warning:` line after the verdict, with a pointer to rerunning `slipjay land`, which reattaches to the landed operation and finishes the recording, and no longer replaces it
  or stops the later steps that do not depend on it.

## v3.45.0

- **Automatic promotion no longer waits for a quiet moment:** in `development` mode the runner released only the newest green
  staging commit, and only when its own pre-verification had passed, so under steady landings every verified commit was already
  superseded by a newer, still-unverified one and nothing shipped. It now releases the newest green commit whose
  pre-verification passed, looking back no further than the newest commit already released or tried; a newer commit that is still
  verifying or whose verification failed no longer holds it back (and a failed one is still reported on its log). A newer verified
  commit replaces a queued automatic release of an older one. `standard` and `light` are unchanged.

## v3.44.0

- **A pre-verification is never starved or stopped by landings:** it is admitted like a release, in arrival order, beside its
  repository's landings (its own release checkout) and never beside its reset. It no longer waits for every landing, reset and
  release of its repository to clear before starting, and no longer yields (stops and requeues) when a landing, or another
  repository's landing that waits only for a place, arrives. Under a steady stream of landings a release verification
  now completes, and with it an automatic promotion in `development` mode. The workers still bound concurrency, so the
  load never exceeds what the runner admits; only a runner restart returns a running pre-verification to the queue.
  Older logs' `yielded` events still read.

## v3.43.2

- **A failed landing's candidate survives another workspace's import (Build #3009, SJ-1):** the client keeps a local
  `slipjay/changes/<changeId>` bookmark (no remote ref, so the commit is not immutable) on the candidate until the operation has
  a result. Before, a workspace that had imported the runner's copy abandoned the candidate when the runner deleted it after a
  failure, rebased what was stacked on it onto its parent and left the source workspace stale.
  A rerun that reattaches to an operation closed long ago, which pushes the candidate again with no runner cleanup to follow, deletes
  that remote copy once the result is known, so a full fetch cannot make the failed candidate immutable.

## v3.43.1

- **The runner token lookup survives a transient Bitwarden failure (Build #3355, SJ-15):** `slipjay land` and the other runner
  commands try `bws secret list` three times before giving up, and the final error says whether `bws` could not be started, exited non-zero,
  timed out or returned unparsable output (never its output). A raw newline or tab in an unrelated secret's value no longer makes
  the whole list unparsable, so the token is still read; a key that is truly absent keeps the existing message.

## v3.43.0

- **`pool-refill.log` shows where each spare's dependencies came from (Build #3401, SJ-26):** a provisioning line now adds
  `project` and `integrationRoot` (so a log shared by several repositories can be split), `dependencySource` (`handover`: a
  retiring checkout's `node_modules` were moved in; `clone`: copied from another checkout; `install`: installed;
  `none`: the repository needs no dependencies), `dependencyMs` (the dependency step, including the install that
  verifies a clone or handover, timed once the machine's refill lock is held so a wait behind another repository is
  not counted) and, for a clone, `cloneMs`. A retiring checkout whose `node_modules` move to a new
  spare also logs `{"handover":true,"project","integrationRoot","from","workspacePath","name","trees","moveMs"}`. Existing
  fields are unchanged.

## v3.42.1

- **Landing keeps the whole commit description (Build #4431, SJ-61):** a Build-attached landing publishes a commit's body and
  trailers (Co-Authored-By included) unchanged and adds `Build: #N` only when the full description lacks it; a commit that
  already carries it is not re-described, so a handoff pinned to it still matches. A body written under the generated `wip:`
  subject is kept too: only that placeholder subject is replaced with the item title.

## v3.42.0

- **`process: "development"` promotes by itself (YS-254):** a repository can set `process` to `development` (`slipjay
  policy set --process development`; `standard` stays the default). When a commit's staging deploy is green and its
  pre-verification passed against the release branch, and the policy committed on the release branch (never the
  candidate's) says `development`, the runner queues the same release `slipjay promote --confirm` would, in the same
  release queue. The release, its production deploy, `slipjay promote --confirm` output and `slipjay deploys` record
  `automatic: { setting: "process", value: "development" }`. Non-additive migrations, a failed or missing
  verification and an audit refusal still stop it: the candidate stays unpromoted, with the reason on its
  pre-verification's log, and the next green candidate is tried. A health-check failure rolls back as before.
  `standard` and `light` promote nothing without a human `--confirm`. `development` implies everything `light` does
  for agents.

## v3.41.0

- **Adopted helper workspaces retire once the lead's landing publishes (Build #4399, SJ-53):** `slipjay adopt <helper-workspace-path>`
  replaces the lead's manual `jj duplicate` and `jj squash`: it adopts the helper's commits into the lead's working copy, refuses
  with the conflicted paths when they conflict, and records the adoption. `slipjay land` carries each adopted revision in the
  handoff's `helpers`, and once the landing publishes the adoption coverage is archived with the landing. `remove`, `cleanup`,
  `prune --plan`, `prune --empty` and the sweeps then treat the helper as delivered, while an adoption whose landing is not yet
  published keeps it with the reason `adopted, landing not published`. `slipjay remove --discard <path>` is the explicit
  confirmation for work nobody adopted. A reland over a candidate an earlier attempt left on the remote no longer fails with a
  conflicted bookmark or a divergent change, and a failure before a retry's submission keeps the earlier submission's runner pin.

## v3.40.1

- **Rerunning a landing and its cleanup work once the candidate bookmark has made the candidate immutable (Build #4510, SJ-65):**
  after `slipjay land` pushes `slipjay/changes/<changeId>`, a fetch of every bookmark imports it untracked and jj treats the
  candidate as immutable. A rerun of `slipjay land` that reattaches to the running operation now compares the candidate's
  full description, trailer included, instead of its first line, so an already-described candidate is no longer rewritten
  (it failed with "Commit … is immutable"). The cleanup after a later landing forgets only SlipJay's own
  `slipjay/changes/*` bookmarks for the earlier submitted candidates before abandoning them; a tag, another bookmark or
  configuration that also holds a candidate still keeps it, with the existing "Could not abandon" message.

## v3.40.0

- **The runner's queue names the Spec each landing delivers:** `slipjay land` now records the Build item or Issue its
  workspace was started for in the submission's identity, and the watch snapshot carries it on each operation as
  `spec`, so a queue view such as T3 Code's can name a landing by its Spec from the moment it is queued, from any
  machine. A `Spec:` trailer still wins once the runner reads the candidate. Older runners accept the new field.

## v3.39.7

- **Runners install with the repository's pinned pnpm (Build #4447, SJ-63):** a runner ran its global pnpm, which on
  a newer `packageManager` pin switched to that version itself and recorded `@pnpm/exe` in `pnpm-lock.yaml`, so the
  frozen install changed tracked source and the landing failed at `installing`. `scripts/setup-runner.sh` now puts
  corepack's pnpm shim first on the unit's PATH (and sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`), so the exact pinned
  version runs with no switch. It needs `corepack` on the host; re-run the script on each runner host to apply it.

## v3.39.6

- **pnpm 12 repositories install on runners without reflinks (Build #4441, SJ-62):** workspace installs ran
  `pnpm install --package-import-method=clone`, which pnpm 12 refuses on a filesystem without copy-on-write clones,
  so every landing of a pnpm 12 repository on an ext4 runner failed at `installing` (os error 95). Installs now use
  `clone-or-copy`: copy-on-write where the filesystem has it, plain copies elsewhere.

## v3.39.5

- **A landing caught retrying someone else's held integration no longer locks its Spec out of Build (Build #4336, SJ-47):**
  a landing that failed while the runner first retried an earlier landing's held integration was reported to Build as
  `publication_unknown`, though it never integrated its own candidate, so Build refused every new admission of its Spec
  (`delivery_pending`) with no way out. Only a failure while integrating, or after integrating its own candidate, is
  `publication_unknown` now; failing to finish another landing's hold is `infrastructure_retry`. When the runner releases a
  held integration (`integration_released`), it now reports a settled `failed` for each attempt that hold left unknown, so
  their Specs are admitted again with no step in HQ. This needs a Build that accepts a settled failure after an unknown
  publication (YardSmith Build #4336): upgrade a runner host only once that Build is in Production, or the new receipts park.

## v3.39.4

- **Additive migrations shipped with Drizzle metadata go before the health checks too (Build #4408, SJ-55):** v3.39.3
  migrated first only when every migration file was SQL, but a promotion's migration files are everything changed under
  `artifactPaths`, so Drizzle's `meta/*_snapshot.json` and `meta/_journal.json` beside an additive migration (YardSmith
  0352) put it back on the late order. The order now follows the plan's one additivity classification
  (`nonAdditiveMigrations`), as rollback does; a deploy that does not know its files still migrates last. That
  classification now skips JSON metadata and counts any other migration file that is not SQL as not additive, since it
  cannot be read: such a file migrates last, and a failed promotion carrying it now waits for the owner instead of rolling back.

## v3.39.3

- **Additive production migrations apply before the health checks (Build #4408, SJ-55):** a promotion whose migration
  files are all SQL and additive now verifies and applies them before any project deploys, so its health checks run the new code on
  its own schema. Before, they always ran last before traffic moved, so a release whose health-checked path read a
  table its own migration creates failed every health check and rolled back, and retrying failed the same way
  (YardSmith release d19003ef, migration 0352). A failure there deploys nothing. Non-additive migrations, files that are
  not SQL, and a rerun deploy that does not know the promotion's files keep the old order and the owner's decision.

## v3.39.2

- **HQ follows the runner within seconds:** the pipeline relay now pushes five seconds after a new ledger event (one
  pass per burst, and another after a pass an event arrived during), as well as at start and every 30 minutes. Before,
  it pushed only on the 30-minute timer, so a staging deploy or landing could take half an hour to reach HQ's release
  line and Build acceptance readiness waited on it.

- **A fork's submission probe uses the integration branch its candidate declares:** the probe resolved the branch from
  its own checkout, whose working copy sits on the head it last probed, and a fork's remote default (upstream's `main`)
  carries no policy. T3 Code's probe therefore rebased onto upstream `main`, and every merge candidate's assembled
  message (about 17,000 upstream descriptions) exceeded Linux's per-argument limit, so `jj new` failed with `E2BIG`
  and the submission queued without a conflict check.

## v3.39.1

- **A depth-two head held by an older release, reset or audit names it (Build #3010):** before, only the
  successor did, so `runner watch` and `slipjay land` showed the head as about to start while the queue held it.

- **Reconciling a held integration starts with `slipjay runner pause` (#3360):** a recovery that fails every time is
  retried until it publishes or is released, so the README's manual fix now pauses the runner first (a paused runner
  starts no retry or release). After the bookmark is moved back, it resumes the runner and lands the commit, which
  follows a recovery turn that releases the hold and ends `cancelled`, then lands the commit once more.

## v3.39.0

- **A landing records what its commit declares:** the `landed` event now carries `repo` and
  `declaredEnvironments`, the deployment environments the landed commit's `slipjay.json` declares (`[]` for
  none). Build reads them to tell a repository with no staging (SlipJay, T3 Code) from one whose staging deploy
  has not reached it yet, so those repositories' Specs can complete acceptance readiness. When the policy
  cannot be read the fields are absent, which Build treats as unknown.

## v3.38.1

- **A depth-two successor held back by its repository's release names the release (Build #3010):** before,
  it named the workers or its own queue's head, though the queue would not start it until the release
  finished. The short class refreshes from an index on the ledger's event time instead of scanning the whole
  ledger, and README's Workers section now states the short-landing place and T3 Code's current depth.

## v3.38.0

- **A short landing gets past busy workers (Build #3010):** with a systemd budget, a landing of a repository
  whose verify-stage p90 over the last 7 days is at most `shortLandingP90Seconds` (runner config, default
  180) may start while long operations hold every worker: at most `workers` long operations and `workers + 1`
  in all. On 18 Oct an agent-config landing that verifies in seconds waited 75 minutes for workers held by T3
  Code and YardSmith; over 16–19 Oct agent-config, splay and T3 Code waited about 6 hours in total that way.
  Releases, resets, audits, pre-verifications, recoveries and depth-two successors still count as long, and
  a waiting operation names the places that hold it (`every place (…)` for a full short place).

## v3.37.2

- **A held integration a person discarded is released, and a failed recovery is retried (#3360):** the recovery turn
  that finds its commit neither held nor on the remote (the README's manual fix) now records `integration_released`, so
  relanding the commit is an ordinary submission instead of being redirected to a recovery that cancels each time. A
  recovery turn that fails is queued again after 30 seconds, doubling to 15 minutes, until the hold publishes or is
  released. `stop-runner.sh` reads the unified cgroup line only and fails loudly in the journal when it cannot find the
  runner (a stop hook cannot hold systemd back, so the idle check before an upgrade stays the guard), and the stop log
  line names every stage the drain waits for. Re-run `scripts/setup-runner.sh` to take the script.

## v3.37.1

- **A landing for an unshaped Build Spec names the way through (Build #3359):** `slipjay land` for a
  workspace whose Spec is still in Inbox or Shaping now says to set it to ready, bind it and start a
  session, instead of asking only for a session that Build would refuse to create (`bind_status_invalid`).

## v3.37.0

- **An unused empty workspace is swept after 10 minutes, not an hour:** the idle wait and the separate
  grace for a closed Issue's checkout are one 10-minute period. T3 Code now gives a thread whose
  workspace was swept a fresh one on its next turn, so the long wait only kept empty checkouts (a bare
  t3code one is 381 MB) on disk.

## v3.36.1

- **`scripts/setup-runner.sh` keeps the runner's other settings and stops it cleanly (#3360):** re-running it, the way
  to take the stop behaviour of v3.36.0, no longer rewrites `config.json` without its `build` section, and the unit's
  `ExecStop` (`stop-runner.sh`, beside the config) signals only the runner process so a restart waits for an integration in
  flight without cutting off the `jj` and `git` commands it started. Re-run it on a runner host that has v3.36.0 or later. Also in this release: the submission probe runs before admission
  and names a refused replacement's queued predecessor (the Build #3356 follow-up).

## v3.36.0

- **A landing that would conflict is refused at submission (Build #3356):** before a candidate
  queues, the runner dry-runs its rebase onto the integration head and every landing queued ahead of
  it in its repository, the same duplicate-and-rebase it does at `rebasing`, with no verification.
  A conflict fails `slipjay land` there, naming the conflicting paths and the queued landing it
  clashes with. On 2026-10-19 YardSmith #2991 waited 7 minutes behind #2973 before failing at
  `rebasing` over an import list and a README paragraph that this check finds in seconds. The check
  runs before admission and gives up after 30 seconds, so it never delays other submissions, and a
  refused replacement names the change's earlier candidate that is still queued.
- **A session's unused workspace takes its Issue instead of a second checkout:** `slipjay start
  --integration --issue <n>` run from the caller's own workspace, when it has no Issue and no work, is
  refused and names `slipjay attach-issue <n>`. T3 Code allocates a workspace for each thread when it
  starts; agents that then started another for their Build item left the first one abandoned (two in
  t3code on 2026-10-19).

- **A runner restart no longer strands a verified landing (#3360):** the runner publishes an integration it still
  holds at start, as a `recovery` operation in its lane, instead of waiting for a later landing that Build refuses
  (`delivery_pending`) while that delivery is held. Relanding the held commit follows that recovery. Stopping the
  runner (an upgrade's restart) waits for an operation that is integrating, finalizing, publishing or recovering,
  bounded by the unit's `TimeoutStopSec` (15 minutes), and the unit's `ExecStop` signals only the runner so the `jj` and `git`
  commands it started are not cut off; both come from `scripts/setup-runner.sh`, which an existing runner host runs again
  (it now keeps the other settings in `config.json`, such as `build`, instead of rewriting them away).

## v3.35.0

- **A retiring workspace's dependencies become the next spare (#124):** when the pool is short, a
  retiring workspace's `node_modules` are moved (a rename) into a new spare on the integration head,
  and its refill installs over them in place. Before this, each claim topped the pool up by cloning a
  whole `node_modules` (t3code: 6.6 GB, about 2.6 minutes, and fseventsd at 60–135% CPU), and each
  retirement deleted another. A no-op install over an up-to-date t3code tree takes 5–18 s.

- **Unused empty workspaces are swept after an hour, not a day:** a workspace allocated for a thread
  that never edits anything (as T3 does for most threads) used to keep its whole checkout and
  `node_modules` for 24 hours. On the Mac on 2026-10-19 that was 58 of 143 workspaces. One holding a
  live process, or any work, is still kept.

- **Removing a workspace no longer waits for its files to be deleted (#123):** cleanup, `slipjay remove`
  and every sweep move the checkout into `~/.slipjay/trash`, which is a rename, and a detached process at
  `nice -n 19` deletes it. Before this, deleting one t3code checkout took 239 s inside the removal and its
  locks. A deletion a crash interrupted is restarted by the next sweep.

## v3.34.0

- **A landing reports its verdict before its housekeeping (#110):** once the runner publishes or
  refuses a landing, `slipjay land` prints the verdict and returns. Releasing the landed workspace and
  sweeping the others run in a detached process, which writes its output to `pool-refill.log`.
  Before this, t3code landings waited 174–355 s for housekeeping after publishing.
- **Housekeeping inspects at most four workspaces at once (#110):** the sweep used to start one jj
  process per workspace at the same time. With 101 t3code workspaces on the Mac, that was about 100
  concurrent working-copy snapshots, which pushed the load average past 300 and stalled T3 Code.

## v3.33.0

- **Housekeeping updates a stale working copy before judging it (#110):** a workspace whose working
  copy went stale after another workspace rewrote its commit is now updated (`jj workspace
  update-stale`) and judged, instead of being skipped as unreadable. Any edits jj recovers are restored
  into the working copy, and the workspace is kept.
- **Spare refills refresh one spare, in place, only when install inputs change (#110):** a refill
  refreshes at most one spare, and only when no ready spare already has the integration head's install
  inputs. It installs in place instead of replacing `node_modules`, and a claim takes the newest spare.
- **`slipjay start` records where its time goes (#110):** `--json` and the `workspace_start` and
  `pool_claim` metrics carry `steps`, the exclusive milliseconds of `fetch`, `claim`, `jjNew`,
  `fingerprint`, `install` and `describe`.

- **A nightly audit runs the complete suite and records suspects (#115, #116):** a repository declares
  `audit` in `slipjay.json` (its own commands, and a wall-clock `timeOfDay` and `timeZone`, default 02:00
  Europe/London). The runner audits the exact integration head each night, even before any landing is
  in its ledger, and counts an audit green only when every command ran and passed. A failing audit lists
  the landings published since the last green audit as suspects; `slipjay audit cause` records a culprit
  landing, `--flake`, `--infrastructure` or `--unresolved`. A promotion is refused while the latest audit
  failed with no cause recorded, at planning and again just before publication. SlipJay audits itself with
  `bun install`, `check`, `typecheck` and `test:audit`, the complete suite with test reports.
- **Landings record per-file test timings and runner health (#111, #112, #103):** each gate command gets
  `SLIPJAY_TEST_REPORT_DIR`; a Vitest JSON or Bun JUnit report written there (listed in
  `slipjay-test-reports.json`) becomes the run's `testReport`, with each file's duration and outcome; a
  command that wrote none is recorded as `missing`.
  Each stage event records the runner's load, CPU count, memory and running operations, and the queue
  snapshot gives each operation's `startedAt`.
- **`slipjay metrics` judges each repository against its test budgets (#113):** a new `budgets` policy
  setting (`verifyP50Seconds`, `verifyP90Seconds`, `testFileSeconds`) is recorded with each verification.
  `slipjay metrics [--repo <name>] --json` reports per repository and operation kind, with verify-time
  budget status, the slowest, growing and over-budget test files (executed runs only, per operation kind),
  retry flake candidates and the audit summary.
- **SlipJay's landing gate runs only the tests a candidate can affect (#114):** `bun run test:landing`
  follows the candidate's import graph and falls back to the complete suite for any change it cannot map;
  a version-only `package.json` change runs no tests. Tests import the module they exercise rather than the
  package facade, and `localExecutor` moved to `src/lib/runner/local-executor.ts`, so fewer tests depend on
  every module. A test listed in `tests/quarantine.json` stays out of landings but still runs in the audit
  (#117).
- **The heaviest test files are split by area (#107):** runner queue, runner client, release and spare
  dependency tests now run as several files, and Vitest uses half the cores; the complete suite on the
  runner went from 472 s to 329 s.

## v3.32.0

- **An environment's projects deploy side by side:** each project's deploy command and health check
  now run at the same time instead of one after another, and the record keeps the declared order.
  Where the environment activates, traffic still moves only once every project has passed. A
  YardSmith release that builds its three sites on the runner takes as long as its slowest site
  instead of all three added together.
- **Source is organised by capability (#104):** `src/lib` and `tests` are grouped into `workspace`,
  `landing`, `runner`, `release`, `build`, `policy` and `infra` folders, and the client-facts,
  spare-refill and housekeeping entries moved to `src/launcher`. `bun run check` now also rejects
  library imports of `src/launcher` and closure escapes in type-only syntax. Behaviour, exports and
  the installed binary are unchanged; `tests/integration/installed-package.test.ts` proves the packed
  package works from outside the checkout.

## v3.31.0

- **The runner pushes its metrics export to HQ Build (#99):** a runner configured with `build.origin`
  and `YARDSMITH_SLIPJAY_BUILD_TOKEN` posts pages of `/v1/metrics/events` to HQ's
  `/api/build/runner/pipeline` every 30 minutes, following HQ's cursor. It runs apart from landings
  and receipts, bounds every request and keeps no state of its own.

## v3.30.1

- **One queue snapshot serves every watcher:** the runner builds the `/v1/queue` snapshot once per
  ledger position and shares it for up to a second, instead of rebuilding it for each of the 20 or
  so watchers that ask after every event. Its finished history (`recentReleases`,
  `recentProductionDeploys`, `lastStagingDeploys`) keeps each result but drops each run's command
  evidence, which `runner log` and the outcome endpoint still serve, so a snapshot fell from 470 KB
  to 260 KB.

- **The runner no longer slows down as its ledger grows:** reading one operation's events used
  the `operation_id` index again instead of scanning the whole ledger, so each projection costs
  its own events rather than every event ever recorded. On a 48,000-event ledger a queue snapshot,
  which every watching client requests after each event, fell from 1.2 s to 0.1 s, and the
  runner's event loop, pinned at 100% CPU behind those snapshots, stopped delaying landings.

## v3.30.0

- **Promotions are verified before the owner approves them (#97):** a green staging deploy
  queues a pre-verification of its commit on the runner. It runs `requiredReleaseVerification`
  as a confirm would, after the repository's landings, and yields to a landing that arrives
  while it runs. The `slipjay promote` plan reports it as `verification` (`queued`, `running`,
  `failed` with `failedCommand`, `passed` or `none`). `--confirm` of a candidate whose
  pre-verification passed against the current release base publishes without verifying
  again. A failing release check now shows up before the approval round instead of after it.
  A pre-verification that a confirm of the same commit waits on does not yield. A newer
  client planning against an older runner reports `verification: none`.
- **The plan says whether an earlier approval covers the candidate (#97):** `approval`
  (`approvedCandidate`, `covered`, `reasons`) is true only when the changes since an approved,
  unshipped candidate add no migration artifact and name no work item (`Build:`/`Issue:`
  trailers) the approved range lacks. `reasons` names each failed rule and its commits.

## v3.29.0

- **Starts no longer wait behind a background refill (#95):** a refill installs under the
  machine-wide refill lock instead of the repository's install lock, so a claim whose spare needs
  an install (after a lockfile change, or a miss on an empty pool) runs it at once instead of
  queuing behind the refill's. That lock is now held only for each install, so one repository's
  long refill no longer starves another's pool, and one repository's refills still run in turn.
  On a loaded Mac a t3code spare took up to 17 minutes to provision, during which t3code claims
  waited up to 29 minutes and the YardSmith pool ran empty behind it.

## v3.28.0

- **Promotion no longer warns about half-built Specs:** `slipjay promote` plans and `--confirm`
  results drop `halfBuiltSpecs`, and planning no longer queries GitHub or Build for the open
  Specs a release range served. A repository that gates unaccepted work itself (as YardSmith's
  Spec gates do) has nothing left for the warning to catch. Candidate approval, migration
  classification and confirmation, verification, deployment and rollback are unchanged (#44).

- **A landing record naming another delivery is explained, not promised away:** a landed
  workspace whose landing record names an artifact already archived as another workspace's
  landing is kept by cleanup and the sweep with a reason naming that workspace, and `prune --plan`
  now reports the same instead of planning its removal. Such a record proves nothing about the
  checkout, so `slipjay remove` judges it as one that never landed. Removing a workspace that
  has not landed now also keeps one holding a file no history holds, as retirement elsewhere
  does, instead of deleting it (#77).

## v3.27.0

- **`policy set` reports its operation while it waits:** with `--json-lines`, `slipjay policy set`
  writes `{"phase":"following","operationId":…}` as soon as the change is submitted, or a rerun
  reattaches to it, and then the outcome as the last line, so a settings UI can follow the
  operation through the queue instead of waiting blind for the outcome (pechhe/t3code#102).

## v3.26.0

- **One policy for retirement on every host:** `generatedPaths` and `evidencePaths` are now read
  from the policy committed on the integration branch, like the spare allowance, instead of the
  primary checkout's working files, which move only when that host lands. Releasing an allocation
  attempt now also keeps a checkout that gains files during the release, as the sweep does (#77).

- **Landing checks can see Build:** in a Build-tracked repository, `requiredLandingVerification` and
  migration `generate`/`verify` commands get `SLIPJAY_BUILD_CONTEXT` (the admitted Spec id and number,
  Ticket numbers and session) for a Build-bound landing, and, for every landing on a runner with a Build
  connection, `SLIPJAY_BUILD_READ_URL` and `SLIPJAY_BUILD_READ_TOKEN`: read-only access to Build through the
  runner's `/v1/build/read`, with a token scoped to the operation, revoked when it ends and redacted from
  logs and evidence (#92).

- **Evidence outlives its workspace:** a repository can declare `evidencePaths` in
  `slipjay.json`. Just before a workspace is retired, its untracked files there are copied to
  `~/.slipjay/state/evidence/<workspace>-<time>/` with a `provenance.json` (workspace,
  repository, Issue, task, working-copy commit, landing artifact, and each file's size and
  SHA-256), so review and acceptance material no longer keeps a landed checkout. Evidence over
  64 MiB keeps the workspace. A file that appears while a workspace is being retired by cleanup or
  the sweep now keeps it (`working-copy-changed`), and `prune --plan` no longer reports a tracked
  file rewritten with its snapshot's exact bytes (as setting up a checkout does) as an edit (#82).

- **Broken and orphaned workspaces get a disposition:** the sweep and `slipjay prune --plan` now
  forget a registered workspace whose checkout is gone from disk once its revision holds no
  unlanded work (`missing`), keep one whose working copy JJ cannot read and say how to recover it
  (`broken`), and report directories in workspace storage that no repository lists (`orphan`).
  An orphan is removed only when it holds nothing but reproducible output, is over an hour old and
  no live process uses it; anything else is kept with what to do. State recorded for a repository
  that no longer exists, and integrated-artifact evidence left by test fixtures in the temporary
  directory, now converge. `SweepResult` gains `orphans` (#81).


## v3.25.0

- **Workspace start timings in `slipjay metrics`:** a "Workspace starts" line reports, per repository
  and machine, the starts, how many claimed a spare, the median and p90 claim time and the median
  spares available, from the `pool_claim` facts starts already send the runner.
- **Durable allocation attempts:** `slipjay start --attempt <id>` records the start before it
  allocates anything, so a caller that never got the result (a failed install, a lost or malformed
  receipt, a timeout, a restart) finds its checkout with `slipjay attempt show <id>` and gives it
  back with `slipjay attempt release <id>`. Release removes only a checkout that attempt created or
  claimed and nothing has used since: never a bound or resumed one (a resumed Issue's), one a later
  start took, or one with a live process, work, unique files or undelivered runner facts. The JSON
  receipt echoes `attemptId`. Library: `createWorkspace`'s `attemptId`, `readAttempt` and
  `releaseAttempt` (#80).
- **The spare allowance names its source:** `slipjay status` and `slipjay config` report, with the
  declared, machine and effective counts, the integration branch and commit whose committed
  `slipjay.json` declared them, so Mac and VPS can be compared and a stale or unlanded local edit is
  seen not to apply. A machine limit keyed by a symlinked or differently spelled checkout path now
  applies, and a spare recorded under a checkout path that no longer exists still counts against the
  allowance (and is retired beyond it) while it is one of the repository's workspaces (#83).
- **Landings reach a primary checkout with local edits:** after a landing, the primary checkout
  now moves onto the new integration even when it holds uncommitted edits, which are rebased along
  unchanged (`primaryCheckout: { action: "moved", reason: "carried-edits" }`). Edits that would
  conflict there are restored exactly as they were and reported as `left` with reason
  `edits-conflict` and a warning. Previously any uncommitted edit kept the checkout on the old
  integration until moved by hand.
- **`slipjay prune --plan`:** a read-only retention plan. It lists every workspace with its
  path, state, Issue, task, assignment time, landing and publication, live processes, unique
  files and size, and whether the
  automatic sweep (or `prune --empty`, with `--empty`) would remove it now, or the concrete reason
  it keeps it; `--json` prints it as data. Plan and sweep share one decision per workspace, so
  they cannot disagree, but the plan snapshots no working copy, fetches nothing and finishes no
  landing: an edit since the last snapshot, pending landing housekeeping and an unreadable fact
  keep the workspace instead. An Issue tracker read that throws now reads as an unknown Issue
  state (the workspace is kept) instead of failing the sweep, and the sweep keeps a workspace
  whose metadata cannot be parsed instead of treating it as unbound. Library: `planDisposableWorkspaces`
  (#79).
- **A just-allocated checkout survives its own sweep:** an empty workspace of a closed Issue is
  now kept for an hour after it was last assigned (a resume without a task refreshes that time),
  so `slipjay repair` and a resumed closed-Issue start no longer risk losing the checkout to the
  sweep their allocation starts; `prune --empty` still removes it at once. A sweep that fails is
  retried at the same 15-minute bound, the recency check matches from a subdirectory or another
  workspace, and Issue workspace recovery also starts the sweep. The sweep's outcome is logged to
  `pool-refill.log`, shared with the spare refill. Library: `runHousekeeping` runs one throttled,
  serialised sweep and `startHousekeeping` starts it detached (#85, #86).
- **Settings through commands:** `slipjay policy show` reads the integration branch's committed
  policy with its revision and digest, and `slipjay policy set --base <revision>` lands a patch of
  `spares`, `process` or `requiredLandingVerification` from a workspace of its own, refused as
  stale when the policy moved since that read. `slipjay config` reads and sets this machine's
  runner location and spare limits, each with its source (#84).
- **Settings landings skip the gate:** a landing whose only difference is those fields of
  `slipjay.json` lands without running the landing checks, once the new policy loads and every
  check's executable resolves on the runner; the skip and its reason are recorded as
  `verification_skipped`. A new check is proven only when a later landing runs it (#84).
- **`process`:** `"standard"` (default) or `"light"`, validated and reported for agents (#84).
- **Retired `parallelExecution` and `unattendedMergeToIntegration`:** they drove nothing; a policy
  that declares them loads, `land` and `policy show` warn of them, and `policy set` drops them (#84).
- **A landing follows the runner that accepted it:** after this machine's runner location changes,
  `land` keeps following an operation it submitted earlier on that runner. A submission the runner
  refused is not pinned, so a retry after changing the location goes to the new runner (#84, #88).
- **`policy set` never submits twice:** a rerun reports its attempt's last outcome instead of
  submitting it again, and reports `already-applied` once the policy is on the integration branch.
  Every failure before submission, a usage error included, prints `phase: "refused"` and exits 2
  (#88, #89).
- **Build receipts don't claim a skipped verification:** a settings landing's attempt receipts
  carry no `verifiedRevision`, and one `incomplete` run names the skipped checks' reason (#90).
- **An unresolved publication keeps its runner:** a landing that failed at or after integration
  stays pinned to the runner that holds it, so a retry after changing the location never
  submits it again elsewhere (#88).

## v3.24.4

- **`slipjay repair <failed-operation>`:** sets up a failed landing's repair in one step. It
  claims the repair, restores the exact candidate into a fresh workspace on its own change,
  and writes a repair brief from the runner's evidence, naming every gap. The next `land` from
  that workspace is the repair, linked to the failure. It refuses what the runner already shows
  before allocating anything; a workspace whose claim the runner refuses is removed again; and a
  rerun on the same machine resumes it. The repair keeps the Issue or Build item the candidate
  named; in a Build-tracked repository it lands under the repairer's own session, never as a
  chore. The runner's repair state read now also reports `eligibility` (#17).
- **Empty workspaces retire on their own:** every workspace allocation, a failed one included,
  starts a detached housekeeping sweep of its repository, at most one every 15 minutes, so empty
  assigned checkouts retire without a landing or a manual `prune` (#77, #78).

## v3.24.3

- **Spares with stale install records are refreshed:** a refill only refreshed a spare behind
  the integration head, so after the fingerprint's format changed (or a package-manager upgrade)
  every spare already on the head kept its old record and every claim reseeded `node_modules`.
  A refill now also refreshes a spare whose recorded install inputs are no longer its own.
- **Fewer fingerprints per install:** a claim's fingerprint is reused by the install that
  follows, and seed candidates are proved lazily, so a matching spare is cloned without
  fingerprinting other checkouts first. A reseeding claim computed the fingerprint six times.

## v3.24.2

- **Faster starts:** claiming a spare spawned about 120 `jj` and `git` processes, so a start
  took 40 seconds on a loaded machine. Listing workspaces no longer resolves the integration
  policy it never used, the policy read resolves its bookmark once, and a claim reuses one
  listing for finding and renaming its spare, which roughly halves the processes a start runs.
- **A release bump no longer reinstalls a claimed spare:** the install-input fingerprint hashed
  each `package.json` whole, so a version bump, a new export or a new test script discarded the
  spare's `node_modules` and reinstalled. Installed manifests now count by what an install
  reads of them. The fingerprint format is `v2`, so every spare is reseeded once by its next
  refill.
- **A start's fetch runs outside the allocation lock:** concurrent starts of one repository
  queued behind each other's fetch of the integration branch. The fetch now runs before the
  lock, and starts arriving while one fetches wait for it and reuse it.

## v3.24.1

- **One Bitwarden lookup per command:** a command that reaches the runner several times now reads
  `SLIPJAY_RUNNER_TOKEN` from Bitwarden once, instead of running `bws secret list` for each
  request, which failed intermittently on the Mac. A failed lookup is retried on the next call.
- **`erasableSyntaxOnly`:** the compiler now rejects TypeScript syntax that Node's type stripping
  cannot load, such as constructor parameter properties.

## v3.24.0

- **A Build-tracked landing always reaches Build:** without `--handoff`, `slipjay land` now writes
  the Build handoff itself. A workspace with no Build item lands as a chore. One with an item
  (`--issue <n>`) lands as delivery of its Spec, under the Spec's current bind and the lead's
  session, from `--session <id>` or `HQ_BUILD_SESSION_ID`; `--ticket <m>` adds Tickets of the
  same Spec. A missing session, a Spec with no current bind, or an item that is neither a Spec nor
  a Ticket is refused before anything is submitted, naming `hq_build_start_session` or
  `hq_build_bind`. Following a submitted landing needs neither the session nor Build, and a
  retried submission replays the handoff first written. The runner now also forwards Build's
  `binds` read.

## v3.23.2

- **An unknown Build number is skipped, not mistaken for an outage:** Build answers a read of
  an item that does not exist with HTTP 503 and the code `build_item_unavailable`. SlipJay now
  reads that as Build's refusal, so promotion skips the number instead of reporting that it
  could not check. Any other 503 still means Build did not answer.

## v3.23.1

- **Imported closed Build items count as closed:** a Build-tracked repository treats an item
  with Build's `imported_closed` status, given to Specs and Tickets imported closed from
  GitHub, as delivered, like `landed` or `dropped`.

## v3.23.0

- **HQ Build as a repository's tracker:** `"tracker": "build"` in `slipjay.json` makes a
  repository's work-item numbers HQ Build numbers; GitHub Issues stay the default. A landing
  names its item in a `Build: #N` trailer and, with no description, takes its title from Build;
  the workspace sweep and `prune --empty` treat a closed Build item (or any `legacy` item) as
  delivered; and `promote` reports half-built Build Specs. Clients read Build only through the
  runner's new `POST /v1/build/read`, which forwards Build's read-only `read`, `list` and
  `waits` and refuses anything else, so the Build credential stays on the runner.
- **Removed `selectImplementationIssue` and `assertCompletedIssueDelivered`:** the library's
  GitHub-only Issue-board selection had no caller in SlipJay or its known consumers, and
  would have read GitHub for a Build-tracked repository.

## v3.22.3

- **A start no longer waits on the runner:** `slipjay start` posted its metrics to the runner
  before printing the workspace, over a connection with no timeout on the main request, so a
  slow runner added seconds to every start and a hung one stalled it. A detached process now
  posts them, and a failure is one line in `pool-refill.log`.

## v3.22.2

- **A vendored manifest no longer stops a spare's dependencies being reused:** the
  install-input fingerprint judges lifecycle scripts only for the manifests an install runs
  them for, the root and its declared workspace members (`workspaces`, or `packages:` in
  `pnpm-workspace.yaml`). Before, a tracked `package.json` outside them, such as a vendored
  repository under `.repos/` with a `prepare` script using `--filter`, made the fingerprint
  unavailable, so every claim of that repository's spares reinstalled. Every manifest is still
  hashed, and a repository with no readable workspace list is judged as before.

## v3.22.1

- **An empty pool fills itself:** a `start` that finds no ready spare and adds a fresh
  workspace now starts a background refill, as a claim already did. Before, a repository
  whose pool was empty never refilled, so every start stayed cold.

## v3.22.0

- **Remove the native Mac menu bar:** T3 Code now shows the runner's lanes, deploys and
  releases from `slipjay watch --json`, so the SwiftUI app, its install script and its
  Swift fixtures are gone. Uninstall an existing copy with `launchctl bootout
  gui/$(id -u) ~/Library/LaunchAgents/com.pechhe.slipjay-menubar.plist`, then delete that
  plist and `~/Applications/SlipJay.app`.
- **Start a helper's workspace on a lead's revision:** `slipjay start --base <revision>`
  (implies `--integration`) claims a spare, or adds a fresh workspace, on that revision of
  the current checkout instead of the integration head, so a parallel helper sees the
  lead's unlanded work without waiting for a cold start. The revision must be one commit
  other than the caller's working copy (`jj new`, then pass `@-`).

## v3.21.0

- **Limit spares per machine and refresh stale spares once (#75):** `spares` in
  `~/.slipjay/config.json`, keyed by integration checkout path, lowers a repository's
  declared spare count on that machine (`0` disables the pool there; spares beyond it are
  retired), and `slipjay status` reports the count in force. Refills hold a machine-wide
  lock, so they install one at a time, and they move stale spares onto the integration
  head: after a lockfile change one checkout installs and the spares clone its `node_modules`.

- **Stop a local executor's empty owner slice when it has no runs (#66):** under a systemd
  user manager the executor stops its owner slice whenever its last run ends, retrying a
  failed stop while it stays idle; a run starting meanwhile waits for the stop, so the stop
  never reaches it.

## v3.20.0

- **Settle Build admission independently, and supersede only after Build admits (#73, #60):**
  the receipt drain keeps offering an admission Build never answered, including for an
  operation cancelled or abandoned meanwhile, and reports a late-admitted cancelled one as
  `failed` (`cancelled`), so Build never keeps custody of abandoned work. A Build-bound
  resubmission replaces the queued candidate of its change only once Build admits it; until
  then that candidate waits, and a refused resubmission leaves it in place.

- **Read held integrations without rebuilding Build delivery state (#74, #60):** publication
  checks and `/health` read held integrations directly; only the queue snapshot computes
  Build delivery state.

## v3.19.0

- **Map every runner fact to Build receipts truthfully (#70, #60):** admitted landings now
  also report `held`, `failed` for cancel, kill, supersede and policy refusal with their
  recovery, a `published` confirmed after an unknown publication, and each command as a
  named run. A handoff can declare work unassociated (`build: { "unassociated": true }`),
  which is reported once published as a chore landing. Verification records the candidate
  it verified.

- **Report a removed workspace's landing by path (#72):** `slipjay landed <path>` prints
  the landing recorded for the workspace at exactly that path, from its sidecar or,
  once the workspace is gone, the integrated-artifact archive, or `null`. T3 Code uses
  it to keep a thread's landed commit after SlipJay removes its workspace.

- **Deliver admitted operations' receipts to Build from an independent drain (#69, #60):**
  each admitted landing's `failed` or `published` receipt is sent to Build's
  `recordAttempt` from the ledger, in order, until Build acknowledges it, with bounded
  backoff while Build is down. Refused receipts are parked without blocking others. The
  queue snapshot reports receipt lag and Build's availability, and each landing's outcome
  reports receipt state apart from its verdict.

- **Admit Build-bound submissions through Build before queueing them (#68, #60):** a
  submission carrying a Build binding is recorded as awaiting admission and offered to
  Build's `admitAttempt` at its real ledger sequence (bounded to 10 s). The queue never
  starts it until Build admits it; a refusal ends it as `declined` with Build's code; an
  unanswered call is a retryable refusal, and landing again replays the same admission.
  A runner without `build.origin` and `YARDSMITH_SLIPJAY_BUILD_TOKEN` refuses
  Build-bound submissions.

- **Carry the author's Build binding through submission (#67, #60):** version-1
  handoff evidence accepts an optional `build` object (Build Spec id, Ticket ids,
  HQ Docs body revision, bind generation, lead session). The runner validates it,
  retains it exactly in the manifest and returns it from `slipjay runner handoff`;
  without it nothing about Build is inferred.

## v3.18.0

- **Contain nested work and recover it after a crash (#63, #55):** each runner
  command runs in a systemd slice of its own beneath one named for the runner home,
  named to the command in `SLIPJAY_SYSTEMD_SLICE` so nested scopes (YardSmith's
  heavy-check wrapper) can join it. Kill and timeout stop the whole slice, and a
  restarted runner stops whatever its killed predecessor left before reusing any
  checkout, and a run that cannot be shown stopped blocks the next command. Without a
  systemd user manager the runner runs one operation and one command at a time,
  refuses `workers` above 1, and records each command's process group under the runner
  home so the next start can stop it. A SlipJay command nested in another nests its
  slices and leaves the outer limits alone; tests use a disposable budget slice.

- **Keep retained merges intact (#65, #55):** source preparation assembles the
  feature's first-parent changes without copying or flattening merged-in history.
  Both verification depths publish the preserved merge against their exact base;
  private artifacts accept side parents only from the submitted source ancestry.

- **Preserve repair ownership across repository casing (#64, #55):** equivalent
  repository names resolve to one authority before retained-source admission,
  including the claim recheck and request replay.

- **Keep releases and resets moving safely (#62, #55):** shared-lane releases
  publish within their existing turn, and reset/release exclusion covers worker
  reservations before their lane callbacks start, including resume and recovery.

- **Preserve pre-cutover workspace custody (#61, #8):** historical checkouts use
  their primary checkout's canonical branch governance when they predate
  `slipjay.json`. Checkouts retained under `~/.pi/workspaces` remain eligible for
  cleanup, removal and safe missing-checkout recovery alongside the later roots.

## v3.17.0

- **Landing attribution and recovery (#58, #59):** a renamed integration bookmark
  is fetched before it is needed, and multi-commit landings keep the feature's
  title. Merge candidates no longer republish their merged-in history.
- **Runner watch and menu status (#52, #53, #54):** operation age is available
  alongside live command age, lifecycle fixtures come from the TypeScript runner
  contract, and the menu reports Production failures, queued outcomes and stale
  disconnected state. Pending notifications expire after 24 hours and accepted
  notification identities retain the most recent 2048 entries.
- **Deployment recovery stays bounded (#55):** failures before project commands
  retry no sooner than an hour, including environments with a zero deployment
  interval. A queued deployment cancelled by its owner is not restarted on schedule;
  newer landed commits still follow the normal deployment interval.

- **Finish the SlipJay command rename (#8):** the package exposes only `slipjay`;
  the retired command stub is removed. Only `slipjay.json` declares repository
  checks and guarded branches. The explicit state cutover and recorded paths of
  pre-cutover workspaces remain available so in-flight work is preserved.
- **`status` reports the workspace's Issue:** `workspace.issueNumber` is present
  when the workspace has one from `start --issue` or `attach-issue`, so clients such
  as T3 Code can label a workspace without reading SlipJay's state files.
- **Menu bar notifications survive downtime (#50):** the app saves its applied
  watch cursor after queuing notifications and resumes with at most 100 recent
  events. First install starts at the current snapshot. A cursor ahead of a
  replaced runner log resyncs automatically, and replay refreshes the queue once
  per batch rather than once per event.

## v3.16.0

- **Optional depth-two verification (#56):** a runner repository entry may set
  `verificationDepth: 2` when its gates are safe in independent checkouts. The queue
  then verifies the next submission on the exact prefix of the one ahead, in a second
  warm verifier checkout, and publishes them in order. A dependent never reuses
  evidence from a predecessor that failed, was killed or changed: it takes one fresh
  attempt on whatever the predecessor's outcome left. The default stays depth one; a
  shared `lane` or an uncapped executor refuses depth two.
- **Landings survive a lost response (#57):** an assigned-workspace `slipjay land`
  persists a request identity before submitting, and rerunning it reconciles an
  unknown outcome to the same operation instead of submitting again.
- **The runner retains what each landing was given and what it ran (#57):** submitted
  source is pinned before the runner acknowledges it, with an optional
  `land --handoff` manifest of author evidence. Each run records its sanitized
  command context and bounded, redacted stdout/stderr artifacts, and failure details
  are kept before output is truncated. Operation outcomes report this evidence
  consistently, and `slipjay runner source` exports the exact retained source as a Git
  bundle.
- **Repairs go through durable claims (#57):** `slipjay runner repair-claim`,
  `repair-release` and `repair-revoke` fence one repair worker per failed change; a
  proposal is a new attempt linked to the original failure.
- **Retained evidence expires on a schedule (#57):** 14 days after the change
  publishes, or 30 days after an unadopted outcome, never while an attempt is open,
  its publication unconfirmed, or a repair claim active. Readers then return 410
  naming the expiry.
- **Capped executors fail closed:** when systemd refuses a run's resource caps, the
  run fails before its command starts rather than running uncapped, and dependency
  installs and post-integration commands share the gate executor and budget.

## v3.15.0

- **Promotion verification no longer holds a repository's landings (#55):** a release
  verifies its pinned candidate in a release queue and checkout of its own
  (`releases/<owner>/<name>` in the runner home), beside the repository's landings, and
  takes the repository's queue only to publish, where it rechecks the planned release
  base. It holds a worker until it has published. A release and a reset of one
  repository never overlap, and a repository in a shared `lane` keeps its releases in it. Rollback reads its policy from the
  released candidate, so the warm checkout need not hold the release merge.
- **Each runner checkout's gate commands get their own `TMPDIR`, emptied at each turn:**
  a lock a gate keeps in its temporary directory (YardSmith's heavy-check lock) no
  longer makes the release and landings of one repository wait on each other; the
  runner's `limits` bound them together.

## v3.14.1

- **The runner never abandons published integration history:** a runner checkout now
  pins jj's `trunk()` to the integration branch after each fetch, and candidate cleanup
  excludes it. Before, a repository integrating a branch other than main, master or
  trunk could lose that branch's published history when a candidate sat on an older base.

## v3.14.0

- **Each repository's queue runs on its own worker (#55):** landings, releases and resets
  still take turns within a repository, but different repositories run at once, up to
  `workers` (runner config, default 2; `1` restores one queue). Repositories that share
  external state share a `lane`. Every run, deploys included, joins `slipjay.slice`,
  whose `limits` cap them together (default MemoryHigh 40G, MemoryMax 48G, CPUQuota
  1400%, TasksMax 4096). A queued operation names the running one it waits behind, or
  the workers holding it.
- **Kill names its operation (#51):** `slipjay runner kill <operation>`; bare kill stops
  the only running operation and refuses, listing ids, when several run; an operation
  that is not running is refused. The menu confirms a kill naming the operation and
  sends its id, and a cancel that lost the race says the operation already started.
- **Typed pipeline events and `slipjay metrics` (yardsmith#2379):** the ledger records
  identity, change shape, stage detail and classified causes; `slipjay metrics` reports
  outcomes, causes, stage, queue and command percentiles, attempts and flake candidates.
- **`land` reports its local work as `housekeeping`:** the timing line no longer counts
  recording the landing and sweeping other workspaces as publishing.

- **A deploy cut short by a runner restart is documented, and its rerun is not rolled back (#48):**
  projects a promotion activated before the restart keep serving it, and a later deploy of
  the same commit that has no record (the restart left none) counts as possibly having
  changed the schema, so a rerun carrying non-additive migrations is left for the owner.

- **Non-additive detection is meaningful, and rollback needs a changed schema (#46):**
  `nonAdditiveSql` no longer flags tables the migration creates (temporary ones too),
  columns it adds and constraints or unique indexes over only those, a CHECK dropped
  and added back under the same name as an `IN (...)` list over one column,
  `ON COMMIT DROP`, `DROP NOT NULL` or a generated column. It reads each clause of an
  `ALTER TABLE`, tells tables apart by schema, flags every `UPDATE` of anything but its
  own added columns, and now also flags row-level security, policies, triggers, replaced
  functions, `MERGE`, upserts and `VALIDATE CONSTRAINT`. A failed promotion carrying
  non-additive files now rolls back, and restores earlier projects, unless its migrations
  may have changed the schema (applied, failed part-way, already in place, or run by an
  earlier deploy of the same commit, or an environment declaring none), not only when
  the first verify refused.

## v3.13.0

- **Bind migration context to rebased source, base and Issue (#45):** the non-secret
  `SLIPJAY_MIGRATION_CONTEXT` records the rebased source and base revisions and Issue,
  with strict GitHub host attribution.
- **Preserve tool paths in menu app launches (#42):** the menu app preserves installed
  Bun and BWS tool paths, including the login item's `PATH`.

## v3.12.0

- **Report rollback only after recovery is proven (#41):** a failed activation
  records its traffic state as `unknown` until a successful restore, including for
  the project whose activation failed. Unresolved recovery or a failed release
  pointer return leaves rollback incomplete instead of reporting success.

- **Activation commands learn whether rollback is allowed (#35):** a production
  `activate` step gets `SLIPJAY_DEPLOY_ROLLBACK_ALLOWED` (`1`, or `0` when the
  promotion applied non-additive migrations). A project that reverts itself when its
  own activation fails, such as services on a host, must not do so on `0`; the
  restore call SlipJay makes for earlier projects always carries `1`.

- **Native Mac menu bar (#40):** a signed SwiftUI app shows both runner lanes,
  held integrations, timing warnings and release outcomes. It sends deduplicated
  release and needs-attention notifications and uses the existing CLI for controls
  and logs. The queue snapshot retains recent Production deploy outcomes so a new
  watcher can show failures and rollbacks. Build and install with `scripts/menu-bar.sh`.

- **Watch runner queues and reconnect safely (#39):** `slipjay watch --json` streams
  authenticated queue snapshots, stored events and heartbeats, reconnecting with a
  replay cursor. `GET /v1/queue` exposes ordered lanes and runner timing facts;
  `GET /v1/metrics/events` supports event streams and bounded JSON pages. The
  `slipjay cancel <id>` command requests cancellation of queued operations.

## v3.11.0

- **Development resets weekly and on demand, never at promotion (#35):** `slipjay.json`
  declares `reset` (the former `postRelease` shape plus `intervalMs`, one hour to 30
  days, and it needs an `integrationBranch`, not a `releaseBranch`). The runner resets
  the target `intervalMs` after the latest reset that ran its step, or at once when the
  repository never had one (a reset that failed before its step retries an hour later), as an operation in the serial queue with landings and
  releases, from an exact source view of the integration tip. `slipjay reset` resets
  now and follows it; `GET /v1/resets` lists them. A reset ends `reset` or `failed`;
  its output goes to the owner-only `~/.slipjay/runner/logs/<operation>.reset-output`,
  and `runner kill` stops it. The step gets `SLIPJAY_RESET_TARGET`, `_SOURCE` and
  `_REASON_FILE` in place of the `SLIPJAY_RELEASE_*` variables. Promotion no longer runs
  a post-release step, its result carries no `postRelease`, and `promote --confirm`
  never exits 2; the per-target outcomes in `~/.slipjay/state/post-release` are no
  longer read. **Upgrading:** a policy still declaring `postRelease` is refused, so
  replace it with `reset` before installing this version (a runner on an earlier
  version ignores `reset`).

- **One promotion command (#36):** `slipjay release` is retired and refuses without
  planning or publishing; use `slipjay promote` and its existing confirmation flags.
- **Recover the runner checkout after a failed landing (#37):** a failed rebase
  returns the warm checkout to the integration branch before the next operation.
  Policy discovery falls back to the committed remote-default policy when the
  working-copy hint cannot be parsed, so conflict markers do not strand later landings.

## v3.10.0

- **The runner applies a promotion's production migrations (#34):** `production` may
  declare `migrations: { verify, apply }`. Once every project deployed and passed its
  check, and before any activates, the runner runs `verify` (0: current, 2: pending,
  else refuse), `apply` only when pending, then `verify` again. The deploy record's
  `migrations` lists the promotion's migration files and ends `current`, `applied`,
  `verify_failed` (nothing applied, rolled back automatically) or `apply_failed` (left
  for the owner). A promotion carrying migration artifacts must declare `migrations`,
  and `--migrations-ready` is refused for it. Output is redacted before it is recorded.
  **Upgrading:** a policy declaring `production.migrations` needs this version on the
  runner; earlier runners refuse promotions that carry migrations.

## v3.9.0

- **Production ships by one-tap promotion (#32):** a candidate whose `slipjay.json`
  declares `deployments.environments.production` is a promotion. `slipjay promote`
  (`release` stays an alias) plans the newest commit staging deployed, not the
  integration tip, and when an earlier approval did not ship, shows only the
  `delta` since it. The runner refuses to release a commit staging did not deploy;
  once the release branch holds the candidate, it deploys production from exactly
  that commit in the deploy lane, and `--confirm` follows it to `deployed` or
  `deploy failed`. Rerunning `--confirm` redeploys a failed promotion.
- **Health checks and rollback (#33):** production projects must declare `activate`
  (`healthCheck` is optional, in any environment). A deploy builds every project
  without traffic, checks each, and activates only if all pass; a failed activation
  activates the projects already moved on the deployment they last served, with
  `SLIPJAY_DEPLOY_RESTORE=1`. A failed promotion returns the release branch to
  before its merge, unless a project could not be moved back. The plan's
  `nonAdditiveMigrations` names migrations that drop, rename, retype, delete or
  tighten an existing table; a failed promotion carrying one is left for the owner.
  **Upgrading:** a policy declaring `production` needs this version on the runner.

## v3.8.0

- **The runner deploys staging (#31):** `slipjay.json` can declare
  `deployments.environments.staging` with one command per project. After each
  landing the runner deploys the latest landed commit once `minIntervalMs` (default
  one hour) has passed since the last deploy, otherwise on one timer, in its own lane
  from an exact source view of that commit. Each deploy is recorded `deployed` or
  `failed` with each project's outcome and URL and the commits it added.
  `slipjay deploy <environment>` deploys now and follows it; `slipjay deploys` lists
  them. See the README's Deploys section.
- **SlipJay's own landing gate runs its tests:** `bun run test` joins check and
  typecheck, so a broken test fixture is caught before it lands.

## v3.7.0

- **The runner's jj settings and commit identity live in its config (#30):** the
  runner's `config.json` takes a `jj` map applied as repository config in every warm
  checkout, and the runner refuses to start unless it names `user.name` and
  `user.email`. **Upgrading a runner:** add them (`scripts/setup-runner.sh` writes
  them) before restarting it. `snapshot.max-new-file-size` defaults to 64MiB.
- **No file locks on the runner's landing and release path (#28):** the serial queue
  alone orders landings and releases; the external-target lease shared by
  post-integration and post-release steps is gone, so a stale lease can no longer
  stall the runner. The client still serializes its primary-checkout move.
- **A release publishes only the verified tree (#25):** `release --confirm` refuses
  when the tree it verified differs from the candidate's.
- **A landed stack leaves nothing behind (#26):** the client abandons every
  submitted commit the runner rewrote, not just the tip.
- **Pending post-release outcomes survive a runner move (#27):** outcomes are named
  by the external target alone; the README's move steps copy them.
- **An empty working copy never reports someone else's landing (#24 and the land
  rerun fix):** a target already on the integration branch, locally or on the
  just-fetched remote bookmark, is never submitted, and only this workspace's own
  landed operation is reported; otherwise `land` says there is nothing to land.

## v3.6.3

- **A landed or failed candidate no longer pins the submitted commit (#22):** the
  candidate bookmark (`slipjay/changes/<change>`) is forgotten through the colocated
  integration checkout after it is pushed and again when the operation ends, and the
  runner deletes it from the remote before reporting any verdict (including after a
  restart, and for a landing cancelled while queued). A full `jj git fetch` by another
  session no longer makes the submitted commit immutable, so a landed rewrite no longer
  leaves it divergent and a failed landing stays editable.

## v3.6.2

- **Upgrading no longer clears Bun's cache (#19):** the README's upgrade is
  `bun remove -g @pechhe/slipjay && bun add -g github:pechhe/slipjay#<tag>`, never
  `bun pm cache rm`, which broke every project linking into Bun's global store
  (`globalStore = true`). New `slipjay --version` prints the installed release.
- **Damaged global store diagnosed (#19):** when a checkout's declared packages, or their
  dependencies, link into a Bun store entry that is gone, `start` and landing's deps stage
  stop with the dangling links, any half-linked `links/*.tmp-*` entries and the repair,
  instead of a later module-resolution error.

## v3.6.1

- **A landing is recorded even when abandoning the submitted commit fails:** when the
  runner lands a rewritten commit, `slipjay land` writes the workspace's landing record
  before abandoning the commit it submitted, and a failed abandon (such as a stale working
  copy) now prints the recovery commands instead of leaving the delivered workspace
  labelled not-landed.

## v3.6.0

- **Gate key's former name refused:** a policy declaring `requiredLocalVerification`
  is refused with a message to rename it `requiredLandingVerification`, instead of being
  read as the gate (#14).
- README: moving the runner to another host.

## v3.5.0

- **The runner is the only landing path (#14):** `slipjay land` always sends the change
  to the runner, and refuses without a runner location. `--local-only`, the local
  verification slot, post-land verification (`postLandVerification`, `post-land-run`)
  and local finalization are gone (a policy still declaring `postLandVerification` is
  refused), with the library's local landing exports
  (`landWorkspace` and its helpers); `landThroughRunner` is the library's landing
  call. `--direct` still lands the primary checkout, through the runner.
- **Gate key renamed:** `requiredLocalVerification` is now `requiredLandingVerification`.
  The old name is still read in this release only; declaring both is refused.
- After a runner landing, `land` again sweeps other delivered or idle workspaces,
  printing what it removed and which landed ones it kept, as local landings did.
  Verification-slot and post-land state left by local landings is pruned
  automatically.
- Recreating an Issue workspace at the path of one whose checkout was deleted no longer
  fails on jj 0.46+: forgetting it also removes its Git worktree registration.

## v3.4.0

- **Owner controls on the runner:** `slipjay runner kill` stops the running landing or
  release until it passes verification; it ends `cancelled` with "killed by the owner,
  not run to completion", nothing moves, and the queue goes on. `slipjay runner pause`
  and `resume` hold and release the queue (queued operations show `paused`); the pause
  is recorded in the operation log (#13). Under a systemd user manager each runner run
  gets its own scope, so a kill reaches tools a gate starts in their own process group,
  and nothing a run leaves behind survives it. `/v1/health` reports `paused`.

## v3.3.0

- **Releases on the runner:** `slipjay release --confirm <commit>` submits the
  approved candidate to the runner, which verifies it with
  `requiredReleaseVerification` in its warm checkout, publishes the release branch
  and runs the `postRelease` step, in the same serial queue as landings (#12). The
  authoring machine no longer verifies releases, and a confirm needs a runner
  location. A landing queued behind a release, or a release behind a landing,
  prints what it waits behind. Rerunning a confirm follows the open release of its
  candidate. The release slot and its local coalescing are gone; a confirm of a
  candidate a newer release already shipped still returns `released_by`, now also
  in place of `up_to_date`. A plan no longer reports `pendingPostRelease`.

## v3.2.0

- **Migrations on the runner:** the runner no longer declines changes touching
  migration trigger paths. It generates the migration on the rebased candidate, runs
  the gate, integrates, finalizes the external target (`postIntegration`) and
  publishes, all in the change's serial turn, so concurrent migration changes land with
  consecutive numbers (#5). An integration whose finalization or publication fails is
  held and retried before the next landing instead of being dropped and regenerated
  (#3). A failed `postIntegration` probe or command now reports its redacted output
  instead of withholding it. Operations report a `finalizing` stage.

## v3.1.2

- **Runner restarts:** `slipjay land` keeps following through a runner restart, printing
  `connection lost; reconnecting`, and after about a minute without the runner it stops
  with "rerun slipjay land to reattach" instead of a raw socket error.

## v3.1.1

- **Runner fixes:** after pushing a candidate, `slipjay land` also forgets its remote
  bookmark, so a failed land leaves the candidate editable instead of stacking the fix
  on top of it (and relanding both). The runner matches repository names
  case-insensitively, as GitHub does.

## v3.1.0

- **Runner:** `slipjay runner serve` runs a landing queue on a server, and `slipjay land`
  sends ordinary changes to it when `SLIPJAY_RUNNER` or `runner` in
  `~/.slipjay/config.json` names one (`http://host:port`, or `ssh://host` through an
  SSH forward). Changes travel as the bookmark `slipjay/changes/<changeId>`; the
  runner lands them one at a time in a warm clone, records each run, and recovers
  after a restart. Rerunning `land` reattaches to the same operation, and
  `slipjay runner log <op>` prints its log. Changes with migrations, and any change
  the runner declines, land locally as before. `scripts/setup-runner.sh` installs the
  runner as a systemd user service.

## v3.0.0

- **TypeScript on Bun:** the CLI and library are TypeScript, run by Bun 1.4 or later
  with no build step, and Bun is the only runtime: the `slipjay` bin starts under
  `bun`, and the library entry `@pechhe/slipjay` is `src/lib/slipjay.ts`, so a Node
  host can no longer import it. The hand-written `.d.mts` declarations are gone;
  types live in the modules. Behaviour is unchanged. `check:architecture` now reads
  runtime imports through Bun's scanner, so type-only imports no longer count as
  cycles. Development tooling (Vite+, Vitest, Oxlint) is unchanged.

## v2.0.0

- **Slipway is now SlipJay:** the package is `@pechhe/slipjay`, the CLI is `slipjay`,
  the repository config is `slipjay.json`, environment variables are `SLIPJAY_*`, and
  state lives under `~/.slipjay`. `slipjay cutover` moves state from `~/.slipway` to
  `~/.slipjay` once and records it in `~/.slipjay/cutover.json`; existing workspaces
  stay at their `~/.slipway/workspaces` paths. The package also ships a `slipway` bin
  that only refuses, naming the `slipjay` command to run. The old cutover from `~/.pi`
  and its stubs are removed. A
  repository with only `slipway.json` is refused with a message to rename it; once
  `slipjay.json` exists, the old file is ignored.

## v1.17.1

- **Landing installs what the rebase brought in:** after rebasing onto the
  integration branch and before migration generation or `requiredLocalVerification`,
  `land` runs the workspace's frozen install (`bun install --frozen-lockfile`, or the
  declared manager's equivalent). A workspace installed at allocation no longer fails
  the gate because the integration branch has since added a dependency or workspace
  package. An install that edits tracked source is undone and fails the landing. This
  replaces the install that only migration landings ran.
- **The guard sees another workspace's unsaved edits:** `jj workspace forget <name>`
  run from a different checkout now reads that workspace's `@` from its own
  checkout, so edits made there since its last snapshot count. Before, they were
  invisible and the forget was allowed.

## v1.17.0

- **A post-release step can say why it failed:** Slipway gives the step
  `SLIPWAY_RELEASE_REASON_FILE`; one line the step writes there is added, bounded
  and stripped of control characters, to the failed result's `reason`. The step's
  output still stays in its owner-only log. A timeout is reported as one.

## v1.16.0

- **`postRelease` step:** a repository can declare a step `slipway release` runs
  against an external target once a release has published, shaped like
  `postIntegration` (target probe, exact source view, timeout) and holding the same
  target lease, so no landing finalizes against that target meanwhile. A failure
  keeps the release, is reported with its retry command (`slipway release --confirm
  <candidate>`, exit 2), shows in later plans as `pendingPostRelease`, and is rerun
  by the next confirm. The step runs in the local integration branch's exact
  source, since the target follows it. The target lease now waits up to about 20
  minutes instead of 20 seconds, and no step's `environmentKeys` may name
  `SLIPWAY_RELEASE_*`.

## v1.15.1

- **Landing releases its own workspace when its output is piped:** the
  caller's shell job (for example `slipway land | tail`, or a subshell the shell
  forks for it) shares slipway's process group without being its ancestor, so
  v1.15.0 named those processes as holders and kept the workspace. Processes in
  slipway's own process group now count as the caller.

## v1.15.0

- **Cleanup no longer orphans an edit:** cleanup snapshots a workspace's working
  copy once, reads everything else with `--ignore-working-copy` (including the
  `jj file list` that used to snapshot a second time after the work check), and
  snapshots again just before forgetting. If the working-copy commit changed in
  between, the workspace is kept (`working-copy-changed`). `removeWorkspace` and
  the sweep use the same bracket (`retireWorkspace(..., { expectedCommitId })`).
- **`start` describes first:** an empty, undescribed change is described
  `wip: <task> (#<n>)` for new, claimed and resumed workspaces, and records that
  exact text in the workspace metadata. Landing treats only that generated text as
  no description (it publishes the Issue title or task instead, as it always did for
  an undescribed change); a description a person wrote, `wip:` or not, lands as
  written. A landing whose stack still has the generated text on a commit below the
  target is refused, naming the commit.
- **The guard stops orphaning work:** in a Slipway workspace, `jj new`, `jj edit`,
  `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of any named
  workspace) are denied while the workspace being left or forgotten holds
  unintegrated changes with no description (or only the generated one). One jj
  query; fails open.
- **`land` removes its own workspace:** after a successful landing the workspace is
  cleaned up as `slipway cleanup` would. The landing process and its ancestor
  processes do not keep it; any other process with its working directory inside
  does, and is named by pid and command (so is a process keeping a swept one).
  `landWorkspace` returns `released`; `releaseLandedWorkspace: false` opts out,
  independently of `sweepOtherWorkspaces` (a host that opted out of the sweep and
  wants the old behaviour passes both). It runs `workspaceTeardown` like every
  other removal.
- **The detached post-land run starts in the integration checkout:** it used to
  inherit the landing's working directory, which kept a landed workspace "in use".
- **`sharedPaths`:** new `slipway.json` field of directories each workspace links to
  the same path in the primary checkout, so git-ignored non-reproducible output
  (such as `artifacts/`) stops keeping landed workspaces.
- **Closed Issues release their empty workspaces:** the sweep removes an empty
  workspace attached to an Issue `gh` reports `CLOSED` at once, without the idle
  wait (a live process or owner still keeps it); if `gh` fails, it is kept.
- **State pruning:** the sweep and `prune --empty` delete metadata, landing sidecars
  and owner records of workspaces that no longer exist in their repository
  (archiving integrated delivery evidence first), and verification-slot records
  of dead processes and idle empty `.waiting` directories. Anything in flight or
  not provable is kept.
- **A bigger, non-blocking spare pool:** `spares` (0-8, default 1) sets how many
  spares are kept. Provisioning holds the pool lock only to count and register a
  name, not during the install, so claims take any ready spare while another
  installs; abandoned spares are adopted by the next refill. `start` refills after
  every claim, and the detached refill tops the pool up. Provisioning and
  non-pooled installs first clone `node_modules` (APFS clonefile) from a spare or
  the primary checkout with identical install inputs; the frozen install still runs
  as the verification.

## v1.14.0

- **`workspaceTeardown`:** an optional `slipway.json` command (`executable` plus
  `args`) that runs in a workspace, best effort and under a timeout, before
  `cleanup`, `remove`, `prune --empty` or a sweep deletes it. A failure is
  logged and never blocks the removal. See the README.

## v1.12.0

- **Landed Issue workspaces are released:** the sweep after each landing now
  removes a delivered checkout attached to an Issue, with the same checks as
  `cleanup` (integrated, published, no new work, no live process). An Issue
  workspace that has not landed is still never swept. Previously every Issue
  workspace stayed until someone ran `cleanup` in it.
- **A link into the primary checkout no longer keeps a workspace:** a symlink
  whose target is inside the integration checkout (such as a linked `.env`)
  is not unique material, because deleting the link leaves its target intact.
- **Landing says what its sweep did:** `land` prints each workspace it removed
  and each landed workspace it kept, with the reason, and returns the result as
  `sweep`. Previously skip reasons were discarded.

## v1.11.1

- **The guard judges a command by the repository it targets:** `git -C <dir>`
  (each `-C` in turn) and `jj -R <dir>` (anywhere on the line) are checked
  against the `slipway.json` governing `<dir>`, not the session's working
  directory. Pushing an ungoverned repository from a session in a governed one
  is no longer refused, and a push aimed at a governed repository from
  elsewhere is now caught. The guard keeps judging by the working directory
  when it cannot be sure: a `cd` is not followed, a path that is not
  plain text (expansion, glob or redirection) is not trusted, and `--git-dir`,
  `--work-tree`, a `GIT_*DIR`/`GIT_WORK_TREE` variable or a sourced file
  override `-C`.

## v1.11.0

- **A burst of starts fetches once:** `slipway start` skips its integration
  fetch when the same branch was fetched from the same remote by a start in the
  last 30 seconds, so a fleet starting several workspaces together pays for one
  fetch. A workspace started in that window may sit up to 30 seconds behind the
  remote; landing still fetches and rebases.

## v1.10.0

- **Concurrent starts install in parallel:** `slipway start` (and
  `createWorkspace`) now holds the repository's allocation lock only while it
  names, claims or adds the workspace and records its task and Issue. Dependency
  installation (or a host `prepare` hook) and the `onAcquired` hook run after
  that lock is released, under a per-checkout lock, so a fleet starting several
  workspaces at once no longer queues each install behind the previous one,
  while concurrent starts of the same Issue still prepare its checkout in turn.

## v1.9.0

- **Concurrent releases coalesce:** a `release --confirm` made while another
  release runs is no longer refused. It waits for the release slot, naming the
  release it waits for, and stands aside for any waiting confirm whose candidate
  contains its own, so only the newest candidate verifies. A candidate the
  release it waited for shipped returns `"status": "released_by"` (with `merge`
  and `releasedBy`) without verifying; otherwise, holding the slot, it plans
  again against the moved base and verifies and publishes. Slot waiting records
  carry a structured `candidate` and stop counting when their waiter has not
  polled for a minute. This replaces v1.7.0's refusal, which left concurrent sessions
  retrying against each other.

## v1.8.0

- **Declared project code:** `slipway.json` may set `projectCode` (2-8 lowercase
  letters or digits) to name workspaces regardless of the checkout folder, so
  renaming `YardSmith` to `yardsmith` keeps `ys-412` instead of switching to `ya-412`.

## v1.7.0

- **Second release refused at once:** `release --confirm` holds the release slot
  from verification through publication, and a release confirmed while another
  holds it is refused immediately. Before, it queued behind the running release,
  verified for its full length and was then refused because the release branch
  had moved.

## v1.6.0

- **Release no longer blocks landing:** `release --confirm` verifies in its own
  release slot. Before, it held the landing slot for its whole verification, so
  every landing in the repository queued behind it.
- **Timing metrics:** `land` reports a `queued` stage when it waits for another
  landing, and `land` and `release --confirm` append their timings to
  `~/.slipway/state/metrics/{landings,releases}.jsonl`.

## v1.5.0

- **Release:** the plan and `--confirm` output carry `halfBuiltSpecs`, the open
  Specs with Tickets in the release range and how many of their Tickets are
  closed. It warns only; when GitHub cannot be asked it says so and the release
  proceeds.
- **Claude Code plugin removed:** `claude-plugin/` is gone. Drop its folder from
  `CLAUDE_CODE_PLUGIN_DIRS` if you still load it.

## v1.4.0

- **Start:** a new or claimed spare workspace is based on the integration branch
  as published on the declared remote: `start` fetches it first, so work begun on
  one machine includes what another has landed. The fetch is best effort; offline
  or failing (30 s limit), it warns and starts from the local branch, and landing
  still fetches and rebases.

## v1.3.0

- **Workspace names:** new workspaces are named by a two-letter project code
  (`peach-pi` → `pp`, `YardSmith` → `ys`): `pp-412` for an Issue, `pp-fix-toast`
  from a task name (`-2`, `-3`… when taken), and a short random id when there is
  neither. `projectPrefix` returns the code, and `taskWorkspaceName(code,
  issueNumber, task)` is exported for hosts that rename workspaces. Existing
  workspaces keep their names; Issue resume and recovery still accept the old
  `peach-pi-i412` form.
- **Claude Code plugin:** `claude-plugin/` shows the thread's workspace and
  landing state in the status line, toasts on a successful land, and adds a
  per-thread Isolated/Direct picker and `/slipway`. See the README.

## v1.2.0

- **Release:** `slipway release` promotes the integration branch to a declared
  `releaseBranch`. It plans by default; `--confirm <commit>` verifies that exact
  published commit against `requiredReleaseVerification` in a checkout of its own,
  publishes a merge whose tree is the verified tree, and refuses if the release
  branch moved or has changes the integration branch lacks. A range carrying
  migration artifacts also needs `--migrations-ready`. Releases are recorded in
  `~/.slipway/state/releases`.
- **Guard:** the landing guard also denies moving or pushing a declared release
  branch, and points to `slipway release`. Its denials now name the branch.

## v1.1.0

The transition names are gone: only `slipway.json` and `SLIPWAY_*` exist
(pechhe/peach-pi#1001).

- **Config refused:** `.peach/execution.json` is no longer read. A repository whose
  working files, or a commit whose tree, has only that file is refused with an
  error (code `SLIPWAY_RETIRED_POLICY_PATH`) naming `slipway.json`. This covers
  working-file reads, landing, exact-commit reads during landing and
  finalization, and cleanup. The deprecation warning is removed. The landing
  guard still guards such a repository (its declared branch, `main` and
  `master`) and names `slipway.json` in its denial.
- **Environment:** verification commands no longer receive `PEACH_POST_LAND_BASE`,
  `PEACH_POST_LAND_COMMIT`, `PEACH_VERIFICATION_SLOT` or
  `PEACH_FINALIZATION_COMMIT|KEY|TARGET`, and `PEACH_VERIFICATION_SLOT=held` no
  longer passes a nested landing through the slot. `PEACH_WORKSPACE_COMMAND_TIMEOUT_MS`
  is no longer read. Use the `SLIPWAY_*` names.
- **Library:** `LEGACY_EXECUTION_POLICY_PATH`, `EXECUTION_POLICY_PATHS`,
  `warnLegacyExecutionPolicy` and `LEGACY_VERIFICATION_SLOT_ENV` are removed from
  the internal modules.
- **slipway's own repository** declares its policy in `slipway.json`.

## v1.0.0

State moves to `~/.slipway`, and `peach-workspace` is retired (pechhe/peach-pi#1000).

- **Locations:** landing state, locks and verification slots live in
  `~/.slipway/state` (was `~/.pi/agent/workspace-state`), the checkout mode in
  `~/.slipway/mode.json` (was `~/.pi/agent/workspace-mode.json`), and new
  workspaces in `~/.slipway/workspaces` (was `~/.pi/workspaces`).
- **`slipway cutover [--check]`:** moves this machine's old state once. It refuses,
  naming each holder, while a landing transaction, verification slot or waiting
  landing, Direct writer, post-land run or post-integration run is live. Otherwise
  it renames the state and mode file (copy, verify, delete across devices), replaces
  the installed `~/.pi/agent/bin/peach-workspace` and
  `~/.pi/agent/lib/peach-workspace.mjs` with refusing stubs, and records
  `~/.slipway/cutover.json`. Running it again is a no-op. `--check` only reports.
- **Hard stop before cutover:** on a machine with old-location state and no
  cutover record, every command except `status` and `cutover` refuses, and library
  state access rejects with code `SLIPWAY_CUTOVER_REQUIRED`. `status` reports
  `cutover.required`.
- **Existing workspaces:** those under `~/.pi/workspaces` stay usable at their
  recorded paths, including Issue resume, landing, `cleanup` and `remove`.
- **Messages:** usage, the landing guard and cleanup hints name `slipway` instead
  of `peach-workspace`.
- **Breaking for Pi:** after the cutover, Pi's installed `pi` launcher and
  `jj-workspace` extension, which import `~/.pi/agent/lib/peach-workspace.mjs`,
  fail at startup with the stub's message. Re-running peach-pi's
  `install:vanilla-pi` restores them with shims to the global slipway.
- **Not changed:** the `slipway.json`/`.peach/execution.json` and
  `SLIPWAY_*`/`PEACH_*` dual-read stays until a later release.

## v0.2.1

Ports pechhe/peach-pi#1003 (`92090ecc4`), which landed in peach-pi after the
v0.1.0 extraction (pechhe/slipway#1).

- **Cleanup:** a workspace whose post-integration step failed is released when the
  declared remote already contains its artifact, because a later landing
  published it after running its own step. `cleanup` reports the superseded
  record (status, attempt, reason), and `cleanupLandedWorkspace` returns it as
  `supersededPostIntegration`. A failure that is unpublished, or has no declared
  remote, still keeps the workspace.
- **Land:** retrying `land` in that state says to run `cleanup` instead of
  rerunning land.

## v0.2.0

Neutral names, read and set alongside the Peach names (pechhe/peach-pi#997).

- **Config:** `slipway.json` at the repository root is the landing policy, with
  the same schema as `.peach/execution.json`. When both exist, `slipway.json`
  wins. A repository with only `.peach/execution.json` still works, and slipway
  prints a one-line deprecation warning to stderr naming `slipway.json`. This
  applies to working-file reads, the landing guard, and exact-commit reads
  during landing and finalization.
- **Environment:** verification commands receive `SLIPWAY_POST_LAND_BASE`,
  `SLIPWAY_POST_LAND_COMMIT`, `SLIPWAY_VERIFICATION_SLOT`,
  `SLIPWAY_FINALIZATION_COMMIT`, `SLIPWAY_FINALIZATION_KEY` and
  `SLIPWAY_FINALIZATION_TARGET` alongside the existing `PEACH_*` names. A policy's
  `environmentKeys` may not start with `SLIPWAY_FINALIZATION_` or
  `PEACH_FINALIZATION_`. slipway reads `SLIPWAY_COMMAND_TIMEOUT_MS`, falling back
  to `PEACH_WORKSPACE_COMMAND_TIMEOUT_MS`.
- **Deprecation:** the old names (`.peach/execution.json`, the `PEACH_*`
  verification environment and `PEACH_WORKSPACE_COMMAND_TIMEOUT_MS`) are removed
  in a later release. Move repository config to `slipway.json` and switch
  verification scripts to the `SLIPWAY_*` names before then.
- **Not changed:** state still lives under `~/.pi`. slipway's own repository keeps
  `.peach/execution.json` until the installed landing tools read `slipway.json`.

## v0.1.0

The `peach-workspace` landing closure extracted from pechhe/peach-pi `37a32367`
with its history, behaviour-identical, plus hook-facing CLI commands.
