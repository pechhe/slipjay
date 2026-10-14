# slipjay

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipjay` CLI and a library, written in TypeScript and run by Bun (1.4 or later),
its only runtime.

slipjay was extracted from `pechhe/peach-pi` at `37a32367` as `peach-workspace`,
became Slipway in v1.0.0, and is renamed to SlipJay in v2.0.0. It uses the
`slipjay` CLI, `slipjay.json` config, `SLIPJAY_*` environment names, and state
under `~/.slipjay`. See [CHANGELOG.md](CHANGELOG.md) and [State and cutover](#state-and-cutover).

## State and cutover

| What | Location |
| --- | --- |
| Landing state, locks and post-integration records | `~/.slipjay/state` |
| Checkout mode (`slipjay mode`) | `~/.slipjay/mode.json` |
| New isolated workspaces | `~/.slipjay/workspaces` |
| Cutover record | `~/.slipjay/cutover.json` |

In v2.0.0, `slipjay cutover` moves state from `~/.slipway` to `~/.slipjay` once. The
package also ships a `slipway` bin that only refuses: it prints "slipway is now
slipjay. Run instead: slipjay <args>" and exits 1. On a machine that still has `~/.slipway/state`,
every command except `status` and `cutover` refuses until the cutover has run.

`slipjay cutover`:

1. Refuses, naming each holder, while any landing transaction, verification slot
   (or a landing waiting for one), Direct primary-checkout writer, post-land run or
   post-integration run that a pre-v1.0.0 Slipway left is held or live. Nothing changes.
2. Moves `~/.slipway/state` and `~/.slipway/mode.json` to `~/.slipjay`, by rename,
   or across devices by copy, verify, then delete. Existing workspaces stay at
   `~/.slipway/workspaces/...` and keep working through landing and cleanup; new
   workspaces go to `~/.slipjay/workspaces`.
3. Writes `~/.slipjay/cutover.json`. Running `slipjay cutover` again is a no-op.

`slipjay cutover --check` reports what would block or move without changing anything.

Never sync `~/.slipjay/state` or `~/.slipjay/workspaces` between machines: they
are per-machine lock stores.

## Repository config

A repository's landing policy is `slipjay.json` at its root. A repository with
only `slipway.json` is refused with a message to rename it; the landing guard still
guards it (fail closed). Once `slipjay.json` exists, a leftover `slipway.json` is
ignored. The earlier retired path `.peach/execution.json` is no longer read.

Workspaces are named by a project code: `projectCode` in `slipjay.json` (2-8
lowercase letters or digits) when declared, else two letters derived from the
checkout folder (`peach-pi` → `pp`, `slipjay` → `sl`). Declare it when the folder
name may change, so existing `ys-412`-style names stay stable.

### Workspace teardown

A repository can declare a command that runs in a workspace just before slipjay
deletes it, for example to stop a dev server started from that checkout:

```json
{ "workspaceTeardown": { "executable": "ys-preview", "args": ["stop"] } }
```

`executable` is a bare name resolved on `PATH`; `args` is optional. It runs with
the workspace as its working directory and `SLIPJAY_WORKSPACE_NAME` and
`SLIPJAY_WORKSPACE_PATH` set, under a 30 second timeout, read from the primary
checkout's `slipjay.json`. It runs on every path that deletes a checkout:
`cleanup`, `remove`, `prune --empty`, and the sweeps after landing and at start,
all through `retireWorkspace`. It is best effort: a missing executable, a
non-zero exit, a timeout or an unreadable policy is logged to stderr
(`[teardown] <workspace>: ...`) and never blocks the removal. A registered
workspace whose checkout is already gone has no working directory, so it is
forgotten without a teardown. Claiming a spare renames an unused checkout in
place and does not run one.

### Workspace options

Optional `slipjay.json` fields for the workspace pool and shared output:

| Field | Meaning |
| --- | --- |
| `spares` | Integer 0-8, default 1. How many prepared spare workspaces the pool keeps; 0 disables the pool. A refill tops the pool up one spare at a time, counting spares still being prepared, and holds the pool lock only to count and register a name, never during the dependency install, so a claim always takes any ready spare even while another is installing. Every claim by `start` also starts a background refill, so a burst of starts finds the pool replenished. An idle spare costs nothing at landing. |
| `sharedPaths` | Array of repository-relative directories (at most 20; literal paths, no globs, none inside another, none in `.jj`/`.git`). Each workspace gets a symlink at that path to the same path in the primary (integration) checkout, which is created when missing. The link is made when a workspace is started, resumed or claimed and when a spare is provisioned. An existing real directory is replaced only when empty; with content it is left alone with a warning. Cleanup ignores a link into the primary checkout, so git-ignored output such as `artifacts/` no longer keeps a landed workspace. List the path in `.gitignore`, or jj snapshots the link as source (slipjay warns). |

When a new workspace has no spare to claim, or a spare is provisioned, and it has
no `node_modules`, slipjay first clones the `node_modules` trees of a prepared
spare (or of the primary checkout) whose install-input fingerprint is identical,
with copy-on-write clones (`cp -c` on macOS, `--reflink=auto` on Linux; bun links
with relative symlinks, which are copied verbatim, so the copy resolves inside its
new checkout). The normal frozen install still runs afterwards as the
verification, and if it fails on a cloned tree, the clone is discarded and the
install repeated from scratch.

`land` runs that frozen install again after rebasing the candidate, before any
migration generation or verification, so the gate sees the dependencies of the
integration tip it verifies against rather than the one the workspace was
allocated from. An install that edits tracked source is undone and fails the
landing.

## Environment contract

| Name | Set for |
| --- | --- |
| `SLIPJAY_WORKSPACE_NAME`, `SLIPJAY_WORKSPACE_PATH` | The `workspaceTeardown` command. |
| `SLIPJAY_FINALIZATION_COMMIT`, `_KEY`, `_TARGET` | Post-integration finalization commands and target probes. A policy's `environmentKeys` may not start with `SLIPJAY_FINALIZATION_`. |

slipjay reads `SLIPJAY_COMMAND_TIMEOUT_MS`, the per-command timeout for jj, git
and gh. The pre-v1.1.0 Peach environment names are neither set nor read.

## Install

Releases are git tags. Nothing is published to npm.

```sh
bun add -g github:pechhe/slipjay#v3.9.0
slipjay status
```

To upgrade, remove the installed tag first, since `bun add -g` (even with `--force`)
keeps it otherwise, and check the version:

```sh
bun remove -g @pechhe/slipjay && bun add -g github:pechhe/slipjay#<tag>
slipjay --version
```

Never clear Bun's package cache (`bun pm cache rm`) to upgrade: projects that set
`globalStore = true` link every checkout's packages into it, so clearing it breaks
their dependencies. When a workspace's dependencies are damaged that way, `slipjay start`
and landing say how to repair them.

From Slipway, remove it first (`bun remove -g @pechhe/slipway`) and run
`slipjay cutover` once after installing.

The repository is public, so the `github:` tag form needs no authentication.

## CLI

`slipjay <command>` offers the same commands and behaviour as the earlier `slipway`
tool, plus `cutover` and what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace, integration checkout and landing state (JSON). |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one (up to `spares`). |
| `prune --empty` | Remove empty workspaces, empty workspaces of a closed Issue, and state left by workspaces that no longer exist. |
| `attach-issue <n>` | Bind the current workspace to Issue `n`. |
| `start "task"` | Assign an isolated workspace for a task and print its path. An empty, undescribed change is described `wip: <task> (#<n>)` so abandoned work is never anonymous; landing replaces exactly that generated text (recorded in the workspace metadata) with the Issue title or task, never publishing it; a description you write, `wip:` or not, lands as written, and a stack with the placeholder left on a lower commit is refused. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). |
| `start [--integration] [--issue <n>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`); `--refill` then starts a background spare refill (a claimed spare is always refilled); `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`) and sends all install output to stderr. |
| `preview` | Diffstat of what a landing would integrate. |
| `land [--direct]` | Send the current workspace (or, with `--direct`, the primary checkout) to the runner, which verifies, integrates and publishes it (see [Runner](#runner)); without a runner location it refuses. Afterwards it removes the landed workspace itself, as `cleanup` would: this process and the session that ran it do not keep it, but any other process with its working directory inside does, and is named with its pid and command (the shell's directory is gone once it is removed, so `cd` to the primary checkout). It also sweeps other delivered workspaces, saying why it kept any. |
| `release [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch to the declared release branch, or have the runner verify and publish the confirmed candidate (see [Release](#release)). |
| `deploy <environment>` | Have the runner deploy the integration branch's latest commit on the remote to a declared environment now, and follow it (see [Deploys](#deploys)). |
| `deploys [--environment <name>] [--json]` | Each deploy, newest first: environment, commit, outcome per project, and the commits it added since the previous deploy. |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed. The working copy is snapshotted once and judged; just before the workspace is forgotten it is snapshotted again, and if it changed in between, the workspace is kept (`working-copy-changed`) rather than orphaning the new commit. |
| `remove <path>` | Remove the workspace at `path` if it has landed or is untouched; otherwise keep it and exit 1. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `release`. In a SlipJay workspace it also denies `jj new`, `jj edit`, `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of the current or any named workspace) while the workspace left or forgotten has a non-empty, unintegrated `@` with no description (or only the generated one), telling the agent to `jj describe`, `jj abandon` or land it; that check runs one jj query in each workspace it would leave, inside that workspace's checkout so its unsnapshotted edits count (by its last snapshot when that checkout is missing or unreadable), and allows the command if jj cannot be queried. Each command is judged by the repository it targets (`git -C`, `jj -R`, else the working directory). |
| `cutover [--check]` | Move state from `~/.slipway` to `~/.slipjay` once and retire the `slipway` CLI (see [State and cutover](#state-and-cutover)). |
| `runner <serve\|log <operation>\|kill\|pause\|resume>` | Run the landing runner on this host, print one operation's run log, or use the owner's controls (see [Runner](#runner)). |

## Runner

`slipjay land` sends the change to one long-lived runner; it is the only way a
change lands. The runner queues landings and takes
them one at a time in arrival order. For each one it rebases onto the integration tip,
runs the repository's declared gate in its own warm checkout, then integrates and
publishes. The authoring machine runs none of the gate. Confirmed releases take
turns in the same queue (see [Release](#release)).

- **Gate.** `requiredLandingVerification` in `slipjay.json`, an array of commands
  (`{ "executable", "args"?, "cwd"? }`), run in the runner's checkout.
  A policy declaring its former name, `requiredLocalVerification`, is refused.
  A policy declaring `postLandVerification` (no longer run)
  is refused; move its checks into the gate or remove it.
- **Location.** One value: `SLIPJAY_RUNNER`, or `"runner"` in `~/.slipjay/config.json`.
  On the runner's host it is `http://127.0.0.1:7787`. Elsewhere it is
  `ssh://<host>`, and `land` opens an SSH port forward for the duration of the call
  (the host must be reachable with key auth). Without a location, `land` refuses.
- **Credential.** A bearer token: `SLIPJAY_RUNNER_TOKEN` in the environment, or else
  the Bitwarden Secrets Manager key of that name, read through `bws`. A request
  without it is refused. The runner binds loopback only.
- **What `land` prints.** One line per stage, naming the runner and the queue
  position. Then a summary: the verdict, the failing command's output verbatim on
  failure, and `slipjay runner log <operation>`, which prints the full run log from any machine with the location. Interrupting `land` stops following but
  not the landing. Running `land` again in the same workspace reattaches to the same
  operation (or, if it landed meanwhile, finishes the workspace housekeeping, even when the working copy is left empty on integrated history); it never submits twice, and never submits a commit already on the integration branch. While an older commit of the change is running, `land` follows it instead of moving its bookmark, then asks you to land again. Set `SLIPJAY_RUNNER_VERBOSE=1` to see every
  progress line.
- **Transport.** The client publishes the change as the bookmark
  `slipjay/changes/<changeId>` and submits it by jj change ID. The runner fetches it
  on its turn and deletes it when the operation closes.
- **Migrations and finalization.** Within a change's turn, the runner generates its
  `migrationFinalization` artifacts on the rebased candidate (generation and its
  verification are recorded runs, like the gate), runs the gate, integrates, runs the
  repository's `postIntegration` step (YardSmith: migrate Development), then publishes.
  Because the queue is serial, concurrent migration changes get consecutive numbers.
  The runner host therefore needs whatever that step needs (YardSmith: a logged-in
  `vercel` CLI on the unit's `PATH`).
- **Held integrations.** If finalization or publication fails, the external target
  may already reflect the integration, so the runner keeps it on its local
  integration branch instead of dropping it, and the failure says so. Every later
  turn first retries finalizing and publishing it (with the same artifact key, so
  the migration is never regenerated), and nothing else lands until that succeeds.
  Relanding the same commit reports it landed once it is published. A deterministic
  failure needs a person: reconcile the target, then on the runner host move the
  checkout's integration bookmark back to the remote
  (`jj -R ~/.slipjay/runner/repos/<owner>/<name> bookmark set <branch> -r <branch>@origin --allow-backwards`).
- **Owner controls.** From any machine with the location, `slipjay runner kill` stops
  the running landing or release while it is still fetching, rebasing, installing or
  verifying: verification's commands are killed at once (an earlier stage finishes its
  current step, such as an install, then stops before verification), it ends
  `cancelled` with "killed by the owner, not run to completion" (never a pass),
  nothing moves, and the queue goes on. From
  `integrating` on (a release: `publishing`) the kill is refused with exit 1, because
  stopping there could leave the integration target ahead of the remote; it finishes
  on its own. Killing an idle runner does nothing. `slipjay runner pause` makes the
  runner take no next operation: the running one finishes, and queued ones show
  `paused` as their stage until `slipjay runner resume`, then proceed in order. The
  pause is recorded in the operation log, so it survives a restart. Each run's
  commands go in their own systemd user scope when the runner has a user manager
  (`XDG_RUNTIME_DIR` set, as under the setup's unit), so a kill also reaches
  processes a gate tool started in a separate process group; the scope is cleared
  after every run, so a gate cannot leave processes behind. Elsewhere, such as macOS,
  only the run's process group is killed.
- **A release that breaks the runner.** The runner runs the SlipJay version
  installed on its host, so a broken release cannot land its own fix. Reinstall the
  previous tag there (`bun add -g github:pechhe/slipjay#v<previous>`), restart the
  runner unit, then land the fix.
- **State.** The runner's own state lives in `~/.slipjay/runner`:
  - `config.json`: the name, the listen port, the repositories, keyed `owner/name` with their git URL,
    and `jj`: settings set as repository config in every warm checkout. It must name `user.name` and
    `user.email`, the identity the runner commits as (use an email GitHub links to the owner);
    the runner also sets `snapshot.max-new-file-size` to 64MiB unless `jj` overrides it, so none of these depend on the host's jj config.
  - `operations.sqlite`: one append-only event log; operations, queue positions and runs are projections of it.
  - `logs/<operation>.log`: the run logs.
  - `repos/<owner>/<name>`: the warm checkouts.
  - Finalization receipts and target outcomes stay in
    `~/.slipjay/state/post-integration`. Held-integration retries rely on them; move them with the runner.
  - The `postRelease` step's latest outcome per target stays in
    `~/.slipjay/state/post-release`, named by the target alone, so a failed step is
    still retried by the next confirm after a move to another path.

  On restart, queued operations resume. A landing that was running is recorded as
  landed if its commit already reached the remote, and as failed ("land again")
  otherwise. A release that was running is recorded as failed with the
  `slipjay promote --confirm` command that reruns it. A deploy that was running is
  recorded as failed, and the schedule deploys that commit again; a production
  deploy's failure names the `slipjay promote --confirm` that deploys it again.
- **Moving the runner to another host.** Run Setup on the new host with the same
  repositories, give it what their steps need (YardSmith: a logged-in `vercel`), and
  stop its unit. On the old host, `slipjay runner pause`, wait until no operation is
  running and none is held (the last one landed or failed before integrating), then
  stop its unit. Copy `operations.sqlite`, `logs/`, `~/.slipjay/state/post-integration` and
  `~/.slipjay/state/post-release` to the new host (warm checkouts are cloned again on first use), start its unit,
  point each machine's location at it (`"runner": "ssh://<new host>"`, or
  `http://127.0.0.1:7787` on the host itself), and `slipjay runner resume`: the pause
  moved with the log.
- **Setup.** On the runner host, with `slipjay`, `jj` and `bws` installed and the
  Bitwarden secret `SLIPJAY_RUNNER_TOKEN` saved:
  `scripts/setup-runner.sh pechhe/YardSmith=git@github.com:pechhe/YardSmith.git`.
  The commit identity comes from `SLIPJAY_RUNNER_USER_NAME` and `SLIPJAY_RUNNER_USER_EMAIL`,
  else git's global user. It writes the config and a systemd user unit that runs `bws run -- slipjay runner
  serve` with `Restart=always`, and enables lingering so the unit survives logout and
  reboot. Logs: `journalctl --user -u slipjay-runner`.
- **API.** Under `/v1`: operations (submit, read, cancel, event stream, log),
  releases (submit), deploys (submit, list) and changes by jj change ID.

### Deploys

A repository can declare environments the runner deploys. `staging` follows the
integration branch; `production` deploys only through a promotion (see
[Release](#release)), never on a schedule or by `slipjay deploy`:

```json
{ "deployments": { "version": 1, "environments": { "staging": {
  "minIntervalMs": 3600000, "timeoutMs": 900000, "environmentKeys": ["VERCEL_TOKEN"],
  "projects": [{ "name": "app", "command": { "executable": "bun", "args": ["scripts/deploy.ts", "app", "staging"] } }]
} } } }
```

- **When.** After each landing, the runner deploys the latest landed commit once
  `minIntervalMs` (default one hour) has passed since the environment's last deploy.
  Otherwise one timer deploys it when the interval ends. It never redeploys a commit
  the environment already has. A commit whose projects failed is retried only on
  demand (`slipjay deploy staging`) or by the next landing. Scheduling is rebuilt from
  the log at startup.
- **Where.** Deploys take turns in their own lane, so a deploy waiting minutes on its
  build never holds a landing. Each project's command runs, one after another, in an
  exact source view of the commit (a detached git checkout that borrows the warm
  checkout's objects). It gets the declared `environmentKeys`,
  `SLIPJAY_DEPLOY_ENVIRONMENT` and `SLIPJAY_DEPLOY_COMMIT`, and must finish within
  `timeoutMs` (at most 30 minutes). The last line it prints that is a URL is recorded
  as that project's deployment. A deploy is never killed by `runner kill`, but it
  honours `runner pause`.
- **Health and activation.** A project may declare `healthCheck`, run after its
  deploy with `SLIPJAY_DEPLOY_URL` set to the deployment; a failing check fails the
  project. An environment whose projects all declare `activate` deploys without
  taking traffic: only once every project deployed and passed its check does each
  `activate` (with `SLIPJAY_DEPLOY_URL`) move that project's traffic to its
  deployment. Otherwise nothing is activated and the environment keeps serving what
  it served before. If one activation fails, the projects already activated are
  activated again on the deployment they last served, with `SLIPJAY_DEPLOY_RESTORE=1`
  (a host may move back to an earlier deployment differently from activating a new one).
- **Records.** A deploy ends `deployed`, or `failed` with `deploy failed: <project> (<reason>)`.
  Once its projects ran, either way it records the commit, the commit the environment
  served before (the last deploy any project succeeded in), the commits between them,
  and each project's outcome. A deploy that failed before its projects ran (the commit
  is not on the integration branch, or the runner restarted) records only its reason.
  `slipjay deploys` reads them back. The contract is `src/lib/runner-contract.ts`.

## Release

A repository that declares a `releaseBranch` in `slipjay.json` promotes its
integration branch to it only through `slipjay promote`:

```json
{ "integrationBranch": "develop", "releaseBranch": "master",
  "requiredReleaseVerification": [{ "executable": "bun", "args": ["run", "check:static"] }] }
```

`requiredReleaseVerification` takes the same command shape as
`requiredLandingVerification`. A release branch without it is refused; declare `[]`
to release without checks. The policy that applies is the one committed in the
candidate. `slipjay release` is an alias of `slipjay promote`.

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

A promotion's production deploy that fails is rolled back automatically: production
keeps (or is moved back to) what it served before, the release branch returns to
the commit before the release merge (unless a later release moved it), and the
deploy's `rollback` and reason say so. So `production` must declare `activate` for
every project. A project that could not be moved back is named, and the release
branch stays on the release, since production still partly serves it. Rollback is
code only. The plan's `nonAdditiveMigrations` names migration artifacts that drop,
rename, retype or delete something, or tighten what an existing table accepts (a
heuristic, `nonAdditiveSql` in `src/lib/release.ts`), and its `next` repeats them: a
failed promotion carrying one, including a rerun confirm of it, is left as it is,
with nothing moved back, for the owner to decide.

1. `slipjay promote` fetches and plans: the candidate (the integration branch on
   the remote), the base (the release branch on the remote), the commits between
   them, the declared checks, and any files under
   `migrationFinalization.artifactPaths` in that range. It publishes nothing.
   `halfBuiltSpecs` lists each open Spec (the open, non-`programme` parent Issue of
   an Issue a commit in the range served, by its `Issue:` trailer or `(#N)`) with
   its closed and total Tickets, so the approver sees a partly delivered feature.
   It only warns. Without a GitHub remote, or when `gh` cannot answer, it reads
   `{ "checked": false, "reason": … }` and the release goes ahead; `--confirm`
   checks again.
2. After explicit human approval of that candidate, `slipjay promote --confirm
   <commit>` checks locally that the candidate is published on the integration
   branch (and, for migration artifacts, that `--migrations-ready` was given), then
   submits it to the runner (see [Runner](#runner)); a confirm needs a runner
   location. The release takes its turn in the runner's one serial queue: a landing
   submitted behind it waits, printing `queued (position 2, behind release
   16bea7013436)`, and so does a release behind a landing. In its turn the runner
   checks the exact candidate out in its warm checkout, prepares its dependencies
   and runs the checks; their failure publishes nothing and prints the failing
   command and its output verbatim. If the install or a check changed tracked
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
4. It pushes the release branch, refusing if the remote moved since the plan. The
   runner's operation log records the release.

5. When the candidate's policy declares `postRelease`, it then runs that step
   against an external target, for example resetting a development database from
   the release's production one:

   ```json
   { "postRelease": { "version": 1, "target": "app-development-db:…", "timeoutMs": 1200000,
       "command": { "executable": "bun", "args": ["scripts/reset-development.ts"], "cwd": "app" },
       "targetProbe": { "executable": "bun", "args": ["scripts/probe-development.ts"], "cwd": "app" },
       "environmentKeys": ["NEON_API_KEY"] } }
   ```

   It is shaped like `postIntegration`, and the candidate's declaration applies.
   It runs on the runner, which also finalizes every runner landing against the
   target, and the serial queue never runs it alongside one. The target follows the
   integration branch, so the step runs in an exact source view of the runner's
   integration branch as published (the newest commit a landing has finalized
   against the target), not of the candidate. The view has no dependencies installed (the command bootstraps what
   it needs). The step gets the sanitized environment plus `environmentKeys`,
   `SLIPJAY_RELEASE_CANDIDATE`, `SLIPJAY_RELEASE_MERGE`, `SLIPJAY_RELEASE_SOURCE`
   (that integration commit) and `SLIPJAY_RELEASE_TARGET`; the runner's environment
   supplies `environmentKeys`. Its output goes to an owner-only log under
   `~/.slipjay/state/post-release` on the runner, never into the result,
   because it may echo the secrets it was given. To say why it failed, the step
   may write one short line to the file `SLIPJAY_RELEASE_REASON_FILE` names; the
   result's `reason` carries that line (first line only, control characters
   removed, at most 300 characters), so it must hold no secret. Its `targetProbe` must print `{"target": …}` equal to
   the declared `target` first. The runner's queue runs it like any other
   operation, so no landing finalizes against that target meanwhile. `timeoutMs` may
   be up to 15 minutes. It runs only after the release has published, never on a
   refused or failed release, and its failure never undoes the release: the result
   is still `"released"` with `postRelease: { "ok": false, "reason": …, "retry":
   "slipjay promote --confirm <candidate>" }`, and the command exits 2. A later
   `--confirm` of an already released candidate reruns a step that did not
   complete instead of skipping it; the plan, which never reads post-release outcomes,
   does not report it.

`land` and `release --confirm` each append one line to
`~/.slipjay/state/metrics/landings.jsonl` or `releases.jsonl` on the machine that
ran the command: for a landing, stage durations in milliseconds (`queued` is time
waiting for another landing's slot) and the outcome; for a release, the outcome
and its total time.

A release whose range carries migration artifacts also needs `--migrations-ready`:
apply those migrations where the release branch deploys first. slipjay never
migrates a release environment itself.

## Library

```js
import { createWorkspace, landThroughRunner, workspaceContext } from "@pechhe/slipjay";
```

`@pechhe/slipjay` and `@pechhe/slipjay/delivery` export the same public entry,
`src/lib/slipjay.ts`, which Bun imports directly (there is no build step). It covers
workspaces, landing and its verification, repository policy and post-integration
finalization, plus the process and text utilities that hosts share. Other
modules under `src/lib` are internal, and `bun run check` enforces that the
`src/` closure imports only itself, Node built-ins, `effect` and `proper-lockfile`,
with no runtime cycles (type-only imports are not edges). A host that brokers child processes injects its broker with
`setProcessBroker`. Before the cutover, any library call that reads or writes
state rejects with an error whose `code` is `SLIPJAY_CUTOVER_REQUIRED`;
`cutoverPending()` reports that state and `cutover()` runs the cutover.

## Development and landing

slipjay lands its own changes through `slipjay land` from an isolated JJ workspace, under its own
`slipjay.json`.

Verification checks run with the working-copy revision on the exact candidate,
including retries that started on an empty continuation child.

- **Per landing**, the gate runs `bun install --frozen-lockfile`, then
  `bun run check` (Oxlint and the closure boundary), `bun run typecheck` and the
  test suite (`bun run test`) concurrently.
- **At release**, `bun run verify:release` runs the complete suite again
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.ts`). `scripts/hermetic-home-guard.ts` fails a test
that would otherwise write the real `~/.slipjay` or `~/.pi`. The cutover tests build
pre-v1.0.0 state in that disposable `HOME` and never touch the real one. Run a single file with
`bunx vp test tests/<file>.test.ts`.
