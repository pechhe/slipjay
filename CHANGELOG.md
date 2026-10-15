# Changelog

## Unreleased

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
