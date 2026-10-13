# Changelog

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
