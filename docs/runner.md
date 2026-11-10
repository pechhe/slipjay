# Runner

`slipjay land` sends the change to one long-lived runner; it is the only way a
change lands. The runner queues landings and takes each repository's one at a time
in arrival order by default. For each one it rebases onto the integration tip,
runs the repository's declared gate in its own warm checkout, then integrates and
publishes. A change that contains a merge, such as an upstream update merged into
the integration line, lands as a merge: only its first-parent line moves onto the
tip, and the merged-in history is kept rather than copied, so the integration line
must be the merge's first parent. Gate commands run in the configured runner, boat or named SSH place.

Before a landing queues, the runner dry-runs its rebase, in a checkout of its own: onto
the integration head, then onto each landing of the repository queued ahead of it, in
order, with no verification. A candidate that would conflict is refused before it waits,
naming the conflicting paths and the queued landing (operation and change id) it clashes
with, or the integration head. A landing ahead that conflicts on its own is left out of
the stack. A probe that fails, runs past 30 seconds, or would start while the repository's
previous probe still runs lets the candidate queue unchecked, and the runner logs why. The probe
runs before admission, so a slow one never delays another repository's submissions. A refused
candidate that would have replaced an earlier one of the same change leaves that one queued, and
the refusal names it so it can be cancelled. Resets take turns in the
same repository's queue. A confirmed release verifies in a release queue and a
checkout of its own, beside the repository's landings, and takes a turn in the
repository's queue only to publish (see [Release](release.md#release)). A release and a reset
of one repository never overlap, and a repository in a shared `lane` verifies its
releases in that lane, since its gates share external state. A pre-verification of a
promotion candidate runs in the release queue like a release (see [Release](release.md#release)):
beside the repository's landings, never beside its reset, and never stopped by either.

Each gate command gets a temporary directory (`TMPDIR`) of its checkout's own, emptied
at each turn, so a lock or file a gate keeps there never makes another operation wait:
the runner's `limits` bound concurrent runs together.

- **Workers.** Different repositories share no checkout, branch, reset target or
  environment, so their queues run at once: at most `workers` of them (runner config,
  default 2; `1` is a single queue for every repository), plus one short landing (below). Without a systemd user
  manager there is no combined budget, so the runner admits one operation at a time,
  runs every command (deploys and concurrent verification stages included) one at a
  time, and refuses to start with `workers` above 1. Repositories whose gates do
  share external state (a database, a deploy environment, fixed ports) must share a
  queue: give them the same `lane` in the runner config's `repos` entries. When the
  rule below leaves no place for it, the next operation of an idle queue waits, oldest
  first, and names what holds the places (`a worker (landing …)` or `every place (…)`); one waiting behind its own queue
  names the running operation, or the release or reset holding it. A release holds a
  worker from verification until it has published. A pre-verification holds one while
  it runs and is admitted in arrival order like a release, so a stream of landings can
  neither delay its start for long nor stop it; the workers bound the total, so it
  never adds a place beyond them.
- **Publishing a passed screen.** With a combined budget, a landing whose screen has passed publishes as soon as its
  repository lane is free, without waiting for a worker place: its gate is done and publication takes seconds. It
  counts as a place while it publishes, so nothing new starts beside it until it has.
- **Short landings.** With a combined budget, a landing of a short repository may start
  while other operations hold every worker: at most `workers` operations other than
  short landings run at once, and at most `workers + 1` in the worker pool.
  Deploys use the separate `deployWorkers` budget (see [Deploys](deployments.md#deploys)). A repository is short
  when its landings' verify-stage p90 over the last 7 days, from at least 10 landings
  (the `slipjay metrics` budget projection), is at or below `shortLandingP90Seconds` in
  the runner config (default 180); with fewer landings it is not. The class only
  decides admission: a short landing that overruns runs to its outcome under the usual
  deadlines. Releases, resets, audits, pre-verifications, recoveries and depth-two
  successors always count as long. Places go to operations that can start, oldest
  first. A short landing waiting because all `workers + 1` places are full names them
  (`every place (landing …)`); a long one names the long operations holding the
  workers (`a worker (…)`) when they fill them, and every place otherwise. The ledger marks a landing admitted as short (`shortLanding` on its first
  stage).
- **Limits.** On a systemd host every run, deploys included, joins `slipjay.slice`, so
  the workers' gates and everything they start share one cap: `limits` in the runner
  config sets `memoryHigh` (throttled above, default `40G`), `memoryMax` (the hard
  ceiling, `48G`), `cpuQuota` (`1400%`) and `tasksMax` (`4096`). The runner sets them
  as runtime properties at its first run after each start; if systemd refuses, the
  run fails before its command starts. Dependency installation and post-integration
  commands use the same executor and budget as gates and deploys. Each run has a
  slice of its own beneath the runner's, named to its command in
  `SLIPJAY_SYSTEMD_SLICE`: a command that starts a systemd user scope of its own
  (such as a memory-capped check) must pass `--slice="$SLIPJAY_SYSTEMD_SLICE"`, or that
  scope leaves the runner's limits and outlives a kill of the run.

### The host's CPU budget

A gate, audit or release check that is about to run its commands on the runner host or a machine place first waits while
that host is over its CPU budget (SJ-212). A boat VM is its own host, so a gate there does not wait, and neither does a
landing gate on a machine place: its slice already wins that machine's CPU, and landings go first. While it waits the
operation is in the `waiting-for-budget` stage, so the wait counts against neither its commands' timeouts, a stage's deadline
nor the verify times its budgets judge. It reports a `[verify]` progress line naming the load and the limit, and the ledger
records `host_budget_waited`. A release check takes the budget once, not for each run bisecting a failure. A check a
release waits on (`slipjay promote --confirm`, or a scheduled slot's batch check) goes first as a gate does, so on a machine
place it does not wait; only a background check of the newest landing does.

The budget reads the kernel's load figures and takes the larger of the one- and five-minute loads. A landing gate on the
runner host may start up to its CPU count and waits at most 2 minutes. Audits and background checks ("background" work) start up to
three quarters of it, wait a further minute after any job started on the host, so jobs started together do not all read
the same quiet host, and wait at most 30 minutes. A job at its limit runs anyway and says so: the budget never fails a
job. A host whose figures cannot be read admits the job. A runner started with `SLIPJAY_HOST_BUDGET=off` takes no budget at all.

There is no queue and no service. The only state is the modification time of `~/.slipjay/host-budget-admitted` on that
host and the lock around it. A gate claims no settling time of its own: its start only delays background work. Other heavy jobs take the same door with `slipjay host-budget wait --job <name> [--gate] [--max-wait-seconds <n>]`,
which exits 0 when the job may start and prints what it waits for to stderr. YardSmith's `ys-preview` uses it, as should
anything an agent starts for a load test or long measurement.

### Optional depth-two verification

A runner repository entry can set `verificationDepth: 2` (default `1`) only when
its gates are safe in independent checkouts, dependency trees and temporary
directories, without shared database writes or other mutable external targets.
This is an explicit configuration assertion about the gate, not an inference from
its repository name. A configured shared `lane` cannot use depth two. The executor
must enforce combined resource limits; an uncapped executor refuses this setting.
Each admitted operation holds one place until its terminal outcome: the head of a
short repository may take the short place, and its successor always counts as long, so
it waits for a worker (`a worker (…)`) even when its own queue could take it. An older
reset, release or audit of its repository holds a depth-two head or successor back, and it names that
operation. Of the repositories SlipJay itself lands, none runs at depth two. YardSmith
did from 26 to 28 Oct 2026 and went back to depth one (YS-542): its gates take free
ports, run database tests in disposable containers, and never read Preview, so its
`postIntegration` step declares `readByGate: false`, and its heavy checks share host-wide
slots on purpose (YardSmith's `docs/agents/tooling.md` lists the shared state). Safe was
not faster. In the first 30 landings after 10:00 GMT on 27 Oct, at three workers, passing
landings that overlapped another verification took a median 465 s against 194 s alone,
and the queue-wait p90 was 652 s. T3 Code is a candidate: it runs at depth one until its gates are shown safe in
independent checkouts on `t3peach`, including a controlled pair through its
upstream-receipt check. SlipJay's real-systemd tests are not yet shown safe in
parallel, and agent-config's and splay's landings are too short to gain from it.

For integration D and submissions A then B, the queue prepares immutable CA on D
and CB on that exact CA, in two independent warm verifier repositories. B can
verify while A verifies, but waits outside the publisher lane until A publishes
CA. Only `home/repos/<repo>` integrates, finalizes and publishes. It imports the
artifact before moving any bookmark, checks its exact base and submitted source,
records publication intent, and publishes with JJ's expected-old-remote-ref
precondition. A stale-parent refusal never refreshes the base to accept the old
verification. The integration remains held if finalization or publication fails.

The ledger records each prepared attempt's submitted source, base, candidate,
predecessor and verifier checkout, plus invalidations and publication intent. Runs
name their attempt. Submitted source is duplicated before preparation so a later
attempt never rewrites a retained candidate. Local private refs retain both source
and artifact across slot reuse, independently of JJ's mutable change identifiers;
they are not pushed upstream. Consumers pin their own copies before producer reuse.
These verifier refs are separate from the [evidence retention schedule](landing-evidence.md#retention), which
covers retained submissions, manifests and command artifacts.

A failed, killed or changed predecessor invalidates the dependent, even after a
green gate: its D+A+B evidence is never reused as D+B. Once the predecessor's
outcome is known, the dependent takes one fresh attempt, with a new identity, as the
head on whatever that outcome left: D if A did not publish, D+A if it did. A dependent
stays killable while it waits for that outcome, and a pause that starts meanwhile
stops the rebuild. A remote move before canonical integration permits a head one
fresh attempt of its own, including when a held predecessor publishes under it; a
second move fails. If a held integration still cannot publish, the attempt fails
behind it. An operation's own failure or owner kill, changed author source, or a
paused runner never starts a rebuild. A successor waits for publication when the
predecessor's prepared, rebased candidate changes `slipjay.json` or a
`migrationFinalization.triggerPaths` path. Declaring migration finalization or reset
alone does not prevent overlap. A declared `postIntegration` step also blocks overlap
when its external target is read by the gate: its optional boolean `readByGate`
flag defaults to `true`. Set `postIntegration.readByGate: false` only when gates do
not read that target; the step still runs after integration, and migration-triggering
predecessors still block overlap. The policy parser rejects non-boolean values.
A landing is recorded as `landed` once its push succeeded, and a successor waiting for that publication proceeds then:
the deletion of the candidate bookmark, the slot checkout's return to the integration and deploy scheduling follow the
record. Every other verdict deletes the candidate bookmark before it is recorded.
Queued resets and releases fence later prefix admission. Restart retains artifacts,
ends interrupted verifier attempts, and reconciles canonical publication intent
and held state through the existing recovery path.

### Landing contract

- **Gate.** `requiredLandingVerification` in `slipjay.json`, an array of commands
  (`{ "executable", "args"?, "cwd"?, "concurrent"?, "stopOnFailure"? }`), run in the runner's checkout.
  Consecutive `concurrent` checks run together. A failed check (nonzero exit, signal or
  timeout) does not stop the gate: every later check still runs, and one failure reports
  every failed check in declaration order (the moment a check fails, `land` prints a
  `[verify i/n] failed in …` line naming it and its failing tests, while the others run on), led by an index of each check's outcome (passed,
  failed, timed out, accepted by baseline, capability unavailable, not run). The index and
  summaries are capped at about 24,000 characters; the structured record is complete.
  `"stopOnFailure": true` marks a check that later checks depend on, such as an install or
  a generation step: if it fails, nothing after its stage (its concurrent siblings included)
  starts and the later checks show as not run. Dependency is declared, never inferred.
  Cancellation and infrastructure errors still end verification at once.
  A policy declaring its former name, `requiredLocalVerification`, is refused.
  A policy declaring `postLandVerification` (no longer run)
  is refused; move its checks into the gate or remove it.
- **Location.** One value: `SLIPJAY_RUNNER`, or `"runner"` in `~/.slipjay/config.json`.
  On the runner's host it is `http://127.0.0.1:7787`. Elsewhere it is
  `ssh://<host>`, and `land` opens an SSH port forward for the duration of the call
  (the host must be reachable with key auth). Without a location, `land` refuses.
- **Credential.** A bearer token: `SLIPJAY_RUNNER_TOKEN` in the environment, or else
  the Bitwarden Secrets Manager key of that name, read through `bws`. A lookup that
  fails (`bws` cannot be started, exits non-zero, times out after 15 s, or prints unparsable output) is tried three times; the final error
  names which, never any `bws` output. Another secret holding a raw newline or tab does not hide the token. A request
  without it is refused. The runner binds loopback only.
- **What `land` prints.** One line per stage, naming the runner and the queue
  position. Then a summary: the verdict, the failing command's output verbatim on
  failure, and `slipjay runner log <operation>`, which prints retained operation events from any machine with the location. Interrupting `land` stops following but
  not the landing. Running `land` again in the same workspace reattaches to the same
  operation (or, if it landed meanwhile, finishes the workspace housekeeping, even when the working copy is left empty on integrated history); it never submits twice, and never submits a commit already on the integration branch. While an older commit of the change is running, `land` follows it instead of moving its bookmark, then asks you to land again. Set `SLIPJAY_RUNNER_VERBOSE=1` to see every
  progress line; a check's early failure line is printed regardless.
- **Transport.** The client publishes the change as the bookmark
  `slipjay/changes/<changeId>` and submits it by jj change ID. The runner fetches it
  on its turn and deletes it when the operation closes, leased to the submitted commit, so a
  newer commit the author pushed to the same bookmark meanwhile stays. Until the operation has a result
  (a failed or unknown submission included), the client keeps a local bookmark of that name,
  without a remote ref, on the candidate: another workspace that imported the runner's copy
  would otherwise abandon the candidate, and rebase what is stacked on it, when the runner
  deletes the copy. A rerun reaches the original submission's outcome, which retires it, and deletes the
  remote copy it pushed again when the operation had already closed. A submission the runner refuses
  without creating an operation, or that fails before it is sent, holds nothing there: the client deletes the remote
  copy it pushed (unless a newer commit of the change has replaced it) and forgets the local bookmark, so the author's
  later rewrite of the change is not divergent from an imported copy.
- **Commit descriptions.** A candidate published as a stack keeps its commits and
  descriptions. When the runner folds a multi-commit candidate into one
  landing artifact, its title comes from the first commit on the submitted
  first-parent line outside the integration history. That commit's full description
  comes first; later commits' titles and bodies follow in order, separated by blank
  lines. Review fixes therefore keep the feature title, and all bodies and trailers
  remain in the published description. A single commit keeps its description.
- **Renames over integration edits.** Before rebasing or verification, the runner
  checks the original submitted source's diff from its common bases with integration
  using Git rename detection at 50% similarity. A runner duplicate is never the
  source of this check. With multiple merge bases, history reachable from any base
  is excluded. If later integration history
  touched a renamed file's old path, landing fails as a `conflict`, naming the old
  and new paths and the integration commit IDs and landing titles. Carry those
  edits into the new paths, rebase the repaired candidate onto integration, review
  the result, and land again. A rename whose old path integration did not touch
  proceeds normally. A deletion without a similar added file keeps JJ's existing
  rebase behaviour (including any modify/delete conflict). The submission dry-run
  uses the same detector to report these path conflicts before admission; the
  runner checks again against its exact preparation tip before verification.
- **Migrations and finalization.** Within a change's turn, the runner generates its
  `migrationFinalization` artifacts on the rebased candidate (generation and its
  verification are recorded runs, like the gate), runs the gate, integrates, runs the
  repository's `postIntegration` step (YardSmith: migrate Preview's PostgreSQL), then publishes.
  Because the queue is serial, concurrent migration changes get consecutive numbers.
  The runner host therefore needs whatever that step needs (YardSmith: Docker access to
  its Coolify databases).
- **Failure provenance.** A failed landing records the checked candidate’s changed
  migration trigger and artifact paths, the failing run’s recorded runtime identity,
  and root lockfile blob ids. Optional top-level `"provenance": { "fixturePaths":
  ["tests/fixtures"] }` declares literal repository paths whose object ids identify
  the fixture in that candidate. Declare 1–50 safe relative paths (at most 500
  characters each); unknown provenance keys, globs and parent traversal are refused.
  Without a declaration the failure explains that fixture provenance is unavailable.
  These values are frozen in the ledger once, bounded and sorted; receipt resends
  never reread policy or repository state. Operations predating this evidence keep
  sending their original failure fields.
- <a id="held-integrations"></a>**Held integrations.** If finalization or publication fails, the external target
  may already reflect the integration, so the runner keeps it on its local
  integration branch instead of dropping it, and the failure says so. Every later
  turn first retries finalizing and publishing it (with the same artifact key, so
  the migration is never regenerated), and nothing else lands until that succeeds.
  Relanding the same commit reports it landed once it is published. A restart does not wait
  for a landing: at start the runner queues one recovery turn per repository that still holds
  an integration (a `recovery` operation in its lane, ahead of everything queued after it), which
  finishes and publishes it, so a hold nothing else will touch is cleared without a person.
  Forge keeps a held delivery in its custody until the publication is confirmed and refuses a
  new admission of the Spec meanwhile (`delivery_pending`), so relanding the commit whose
  integration is held follows that recovery turn instead: it ends `landed`, and Forge's
  `published` receipt for the original landing follows from the confirmation. A deterministic
  failure that never started the target command can be released with one command:
  `slipjay runner release <owner/repo>`. The runner decides from its recorded evidence,
  waits for the repository lane, moves its own integration bookmark back to the fetched
  remote and records `integration_released` with the requester's machine. Other repositories
  keep running, and the next landing can proceed. Policy parse, source preparation and
  target-probe failures qualify only when every recorded attempt proves the target command
  never started. A repository without `postIntegration` has no external target: a failed
  publication may be released too, but the runner first checks that the commit is absent
  from the remote. A commit already on the remote belongs to its recovery turn.
  If a command may have run, or earlier evidence is missing (including older runner holds),
  the command refuses and keeps the hold. A person must reconcile the external target;
  retry finalization with the same artifact key once it is safe, or reconcile the runner's
  retained integration after establishing the target's actual state. Agents cannot move
  the integration bookmark by hand: `slipjay guard` still blocks that bypass.
  A recovery turn that fails (the remote is unreachable, say) is queued
  again after 30 seconds, doubling per failure up to 15 minutes, until it publishes, releases the hold
  or is stopped. Once the hold is released, the runner tells Forge that the landing whose integration it
  was failed unpublished (`failed`, recovering by `code_repair`), which ends Forge's custody: that Spec is
  admitted again with no step in HQ. A landing that fails while retrying an earlier landing's hold never
  integrated its own candidate, so Forge records its failure as ended (`infrastructure_retry`) and admits
  its Spec again at once; land it again once the hold is cleared.
- <a id="owner-controls"></a>**Owner controls.** From any machine with the location, `slipjay runner kill <operation>` stops
  that running landing, release or pre-verification while it is still fetching, rebasing, installing or
  verifying (a killed pre-verification is not queued again until staging next deploys that commit
  green), and a reset while it is fetching or resetting: verification's and the
  reset's commands are killed at once (an earlier stage finishes its
  current step, such as an install, then stops before verification), it ends
  `cancelled` with "killed by the owner, not run to completion" (never a pass),
  nothing moves, and the queue goes on. From
  `integrating` on (a release: `publishing`) the kill is refused with exit 1, because
  stopping there could leave the integration target ahead of the remote; it finishes
  on its own. A kill of an operation that is not running (it finished, or has not
  started) kills nothing and exits 1. It also ends an operation the ledger still shows running in a
  killable stage when nothing holds it: no turn, deploy, ending settlement or restart recovery. That is
  how an operation a failed ledger write left open is cleared, and one it cannot reach reads as
  `not_running`, or as refused like a live one past verification. Bare `slipjay runner kill` stops the only running
  operation; with several running it kills none, exits 1 and lists the
  `slipjay runner kill <operation>` commands; with none it does nothing.
  `slipjay runner pause` makes the
  runner take no next operation: running ones finish, and queued ones show
  `paused` as their stage until `slipjay runner resume`, then proceed in order. The
  pause is recorded in the operation log, so it survives a restart. Each run's
  commands go in their own systemd user slice when the runner has a user manager
  (`XDG_RUNTIME_DIR` set, as under the setup's unit), so a kill or timeout also reaches
  processes a gate tool started in a separate process group or scope within it; the
  slice is cleared after every run, so a gate cannot leave processes behind. The
  slices sit beneath one named for the runner's home, so a runner that was killed
  outright leaves its commands where its next start finds them: recovery stops them
  before it touches a checkout, and does not start if it cannot. A run whose
  processes cannot be shown stopped makes every later command fail until they are.
  Elsewhere, such as macOS, only the run's process group is killed: after every
  command, and at the next start for a command the runner home records as running when
  the runner was killed. Tools that leave the process group are out of reach there.
- **A release that breaks the runner.** The runner runs the SlipJay install in its own
  slot (`~/.slipjay/runner-install`), so a broken release cannot land its own fix. Put
  the install it replaced back there (`slipjay upgrade --runner --rollback`, which
  restarts the unit), then land the fix. A client upgrade never changes that slot, and
  `upgrade --runner` refuses to restart a unit whose `ExecStart` does not run the runner
  install: it says so and names `scripts/setup-runner.sh`.
- **A host that already runs the runner.** Its unit runs `~/.bun/bin/slipjay`, so the
  client's adoption of that command would move the runner's code too, and it is refused
  until the unit runs the runner install. Run `slipjay upgrade --runner` (which builds
  the runner install and reports the unit is not yet pointed at it), then
  `scripts/setup-runner.sh` with the same repositories (it points the unit at the runner
  install and restarts it), then `slipjay upgrade` to adopt the client command.
- <a id="state"></a>**State.** The runner's own state lives in `~/.slipjay/runner`:
  - `config.json`: the name, the listen port, the repositories, keyed `owner/name` with their git URL,
    and `jj`: settings set as repository config in every warm checkout. It must name `user.name` and
    `user.email`, the identity the runner commits as (use an email GitHub links to the owner);
    the runner also sets `snapshot.max-new-file-size` to 64MiB, and `snapshot.auto-update-stale` to true because its
    checkout is shared: another operation on the repository can move past its working copy, and JJ must update it rather
    than refuse the next read. None of these depend on the host's jj config.
    An optional `build.origin` names the HQ that Forge admission and receipts go to; it takes effect
    only with `YARDSMITH_SLIPJAY_BUILD_TOKEN` in the runner's environment.
    With both, the runner also pushes its metrics export to HQ (see [Pipeline metrics relay](landing-evidence.md#pipeline-metrics-relay)).
  - `operations.sqlite`: one append-only event log; operations, queue positions and runs are projections of it.
    The runner is one event loop, so a large ledger must never stall the landing in progress (SJ-200): reads
    across operations (gate verdicts, published landings, receipts, open builds) are indexed by event type and
    kept until an event of a type they read is appended or retention forgets events; the queue snapshot is
    projected again for each new ledger revision, and the release state Build's export reads is only the repositories.
    It keeps everything for its history window and only lasting facts past it (see [Retention](landing-evidence.md#retention)), and its
    write-ahead log is checkpointed every five minutes and after each retention pass, so it never sits at a
    high-water mark. An append waits up to five seconds for a competing writer's lock instead of failing the
    operation it records, and an operation a failed append would leave open settles as failed ("land again")
    rather than staying running with no work behind it; `runner kill` can also end one the ledger still shows
    running (see [Owner controls](#owner-controls)). The API is served before a restart's recovery runs, so health and admission answer while
    it does; no queued work starts until recovery finishes.
  - `logs/<operation>.log`: the run logs. A reset's step output goes to the owner-only
    `logs/<operation>.reset-output` beside it, never into the log.
  - `repos/<owner>/<name>`: the warm checkouts; `releases/<owner>/<name>`: each repository's release checkout.
  - Finalization receipts and target outcomes stay in
    `~/.slipjay/state/post-integration`. Held-integration retries rely on them; move them with the runner.

  Stopping the runner (`systemctl --user restart slipjay-runner`) first stops admitting work
  and waits for every operation that is integrating, finalizing, publishing or recovering a held integration, and for a
  deploy that is running. The unit's `ExecStop` (`stop-runner.sh`, beside the config) signals only the runner process
  (`bws` does not forward signals, and systemd would otherwise signal the `jj` and `git` commands it started along with
  it), so those commands finish; the unit's `TimeoutStopSec` (15 minutes) bounds the wait, and a second SIGTERM to the
  runner stops it at once. `scripts/setup-runner.sh` writes both and keeps the other settings in `config.json`, such as
  `build`; an existing runner host runs it again to take them. Work before integration is not waited for: it is recorded
  as below. So an upgrade's restart does not interrupt a publication, but only a runner that already runs this behaviour
  under that unit waits: the first restart onto it still stops the old process at once, so wait until
  `slipjay watch --json` shows nothing running. `stop-runner.sh` needs a cgroup v2 host and a `pgrep` with `--cgroup`;
  where it cannot find the runner it fails loudly in the journal, and systemd then stops the whole unit at once, which a
  stop hook cannot prevent, so the idle check above is the only guard there.

  On restart, queued operations resume. A landing that was running is recorded as
  landed if its commit already reached the remote, and as failed ("land again")
  otherwise. A release that was running is recorded as failed with the
  `slipjay promote --confirm` command that reruns it. A pre-verification that was
  running is queued again; one whose green staging deploy was recorded without it is
  queued then. A reset that was running is
  recorded as failed ("run slipjay reset again"); the schedule waits a full interval
  after it. An audit that was running is recorded as interrupted (cancelled), and the schedule
  submits it again. A deploy that was running is
  recorded as failed, and the schedule deploys that commit again; a production
  deploy's failure names the `slipjay promote --confirm` that deploys it again. A
  restart can stop a promotion's deploy between activations: projects it already
  activated keep serving it, nothing moves them back, and its migrations may have been
  applied, so the rerun is not rolled back automatically if it carries non-additive
  ones (a deploy with no record cannot show the schema untouched).
- <a id="moving-the-runner"></a>**Moving the runner to another host.** Run [Setup](#setup) on the new host with the same
  repositories, give it what their steps need (YardSmith: Docker and its Coolify host), and
  stop its unit. On the old host, `slipjay runner pause`, wait until no operation is
  running and none is held (the last one landed or failed before integrating), then
  stop its unit. Copy `operations.sqlite`, `logs/` and `~/.slipjay/state/post-integration`
  to the new host (warm checkouts are cloned again on first use), start its unit,
  point each machine's location at it (`"runner": "ssh://<new host>"`, or
  `http://127.0.0.1:7787` on the host itself), and `slipjay runner resume`: the pause
  moved with the log.
- <a id="setup"></a>**Setup.** On the runner host, with `jj`, `bws`, `bun` and `corepack` installed, the
  Bitwarden secret `SLIPJAY_RUNNER_TOKEN` saved and a runner install in place
  (`slipjay upgrade --runner`, from a checkout; see [Install](../README.md#install)):
  `scripts/setup-runner.sh pechhe/YardSmith=git@github.com:pechhe/YardSmith.git`.
  The commit identity comes from `SLIPJAY_RUNNER_USER_NAME` and `SLIPJAY_RUNNER_USER_EMAIL`,
  else git's global user. It writes the config and a systemd user unit that runs
  `bws run -- ~/.slipjay/runner-install/src/launcher/workspace.ts runner serve` with
  `Restart=always`, and enables lingering so the unit survives logout and reboot. Logs: `journalctl --user -u slipjay-runner`. The unit's PATH starts with corepack shims
  for pnpm, so each repository installs with the pnpm its `packageManager` pins, whatever pnpm
  is installed globally; re-run the script to add them to an existing unit.
- <a id="candidate-bun-runtime"></a>**Candidate Bun runtime.** For an exact stable `packageManager: "bun@x.y.z"`, each
  dependency and verification command selects that version independently. Provision the
  trusted Bun executable at `<runner-home>/toolchains/bun/x.y.z/bin/bun` (and its `bunx`
  alias in that directory) before submitting the upgrade. Verify the release checksum,
  keep each version immutable, and put no other tools in that directory. The runner
  never downloads a runtime named by a candidate. Without a provisioned version it uses
  the Bun already on PATH only if its version matches exactly; otherwise the operation
  fails with the required path. Its per-command PATH also reaches nested `bun` calls,
  leaving the global executable and other operations untouched. Command evidence records
  the selected version, resolved binary path and SHA-256 in its configuration identity.
  Command evidence lists the environment names the runner passes to the command,
  including runner-provided variables, without recording their values. A systemd
  containment scope then adds only `XDG_RUNTIME_DIR` and `SLIPJAY_SYSTEMD_SLICE`.
  This does not replace dependency fingerprints or reuse an install: runner candidates
  still receive their own frozen install, and packageManager remains a tracked install input.
- **API.** Under `/v1`: operations (submit, read, cancel, event stream, log),
  releases (submit), deploys (submit, list) and changes by jj change ID.

### Remote verification on boat

A runner repository entry can set `verifier: "boat"` to run its gate on boat.dev VMs
instead of this host (SJ-138). The runner still fetches, rebases, installs, generates
migrations, integrates and publishes in its own checkouts; only the commands in
`requiredLandingVerification` move. The runner config's `boat` names the starting image
(`image`: a sandbox kept stopped, holding the repository, `node_modules`, the pinned Bun and
jj, a stopped `keep-*` container for each Docker image the gate uses, since boat drops
unused images from snapshots, and any service container the gate expects under a fixed name,
labelled `slipjay.keep=true`), and optionally the boat CLI (`cli`, default
`~/.ascii/bin/boat`), the SSH key boat authorises on its VMs (`sshKey`) and the VM `size`
(default `default`, 4 vCPU and 8 GB). The CLI authenticates with `BOAT_API_KEY` from the
runner's environment, which the unit's `bws run` supplies from Bitwarden.

Each repository has a pool of VMs, one per verification place, named
`slipjay-<owner>-<name>-<slot>`, forked from the image when missing and resumed when
stopped. Boat stops a VM when its lifetime runs out, snapshotting its disk for the next resume, so
the lifetime is the pool's idle timer: three hours while an attempt runs, fifteen minutes once it
closes, and a runner restart loses no timer. A resumed VM takes one to two and a half minutes to restore its disk
and answer, so fifteen minutes keeps the pool warm through a burst of landings while a quiet gap stops billing. The runner lists the pool in every state (boat's
`list` shows only running sandboxes unless asked), so a stopped VM is resumed rather than forked
again, and a second VM under a slot's name is deleted. A resumed VM answers ssh about a minute before boat has
restored its disk, and finishing the restore swaps the filesystem under any running command, so the runner sets a VM up
only once boat reports it `hydrated` (about 65 s after a resume, measured 29 Oct 2026). A slot boat has not restored and
answered ssh on within five minutes is broken, not slow: the runner deletes that VM and forks the image afresh under the
slot's name once, so later landings on the lane do not wait on the same dead disk. A replacement that also will not
restore fails as infrastructure rather than forking again, since boat starts are rationed. Each VM forked but not yet named into its pool is recorded in `boat-pending-forks/` under
the runner home, and a restart deletes it, keeping the record until boat confirms. An attempt has its VM to itself. Before the gate the runner stops every scope and
container an earlier attempt left (all but the image's `keep-*` and `slipjay.keep=true` ones), moves the VM's one checkout to the runner checkout's own
path, sends the candidate and its base as a Git bundle of only what the VM lacks, sets the
integration bookmark to the base, `jj edit`s the candidate, cleans untracked files and
installs against the candidate's lockfile. The checkout's files, read as a tree starting from the candidate's (so tracked files
matching an ignore rule stay) with untracked files included, must be the candidate's exact tree, and the VM's Bun the one the
candidate pins, or the attempt fails; the runner never downloads a runtime onto it. Each
gate command then runs over SSH in a systemd scope of its own, with the command's
environment minus the host's paths, and a loopback Build URL reaches the runner's grant
endpoint through a reverse tunnel on the same port, one SSH master per attempt holding it for
all of the attempt's commands. Its test reports are copied back and
command evidence names the VM's Bun, so evidence, artifacts and failure classification read
as they do locally. After the gate the checkout's files are read again: a gate that changed
them fails the landing, since its result is no evidence for the candidate. Every clean,
before and after each attempt, also removes the remote scratch (`TMPDIR`, test reports) its
commands created, dangling Docker images, unused volumes and unreachable Git objects, so a VM's
disk stays bounded. Each attempt force-updates its slot's refs, since a candidate need not
descend from the last one that slot verified. The ledger records
`remote_verification` events: `ready` (machine, slot, candidate, tree, `setupMs`) and
`finished` (the tree the checkout held after the gate, or the number of files that
changed, and `machineMs` from opening to finishing), each with boat's billing for the VM
so far (`usage`). `slipjay metrics` reports each group's attempts, setup timing, attempt
machine time and its estimated cost, and the dollars boat billed the pool between its first
and last reading in the window, idle time included; the first reading of each attempt is
taken before setup, and a missing reading makes the spend unavailable rather than $0. A runner restart stops whatever the
pool VMs were running, retrying for four minutes; every attempt cleans its VM first in any
case.

The image changes only by hand, when a gate needs something it lacks: a new Bun pin (setup fails
naming the version), a Docker image or browser the gate starts, or a dependency tree far from the
image's. Resume the image sandbox, update it in its checkout (`git fetch` and check out the
integration branch, `bun install`, `docker pull` and recreate the matching stopped `keep-*`
container, `bun x playwright install --with-deps chromium` in the app that pins Playwright), then
`boat stop` it and `boat snapshot <id> <name>` under the image's one saved name (reusing a name replaces
it), which keeps it past boat's 14 days for stopped sandboxes. Pool VMs keep the disk they were forked
with: make the same change on each idle pool VM in place, which needs no pause, or delete them (paused
admission, nothing running) for the next attempts to fork the new image.

Nothing falls back to this host, except through its one gate place (below). While opening a VM, transient boat API failures (an unreachable
API, timeouts or service errors) retry with exponential backoff from two seconds up to thirty
seconds, within a three-minute retry budget shared across that opening. A timed-out fork is
not retried in that opening, since boat may already have created the VM. Cancellation interrupts both API
calls and backoff; pausing during admission returns the landing to the queue.

If boat remains unreachable, the runner opens a circuit for that repository: its landings stay
queued, shown as `paused` with `waitingFor` naming boat and the API error, and use no worker.
Other repositories continue. A read-only API probe retries after five seconds, doubling up to
one minute; when boat answers, the circuit closes and the same submissions resume automatically,
with fresh attempts and no author resubmission. The ledger records `boat_circuit` open and close
events, and a restart retains the hold. An owner can kill a held landing as usual. Gates already
running keep their existing failure behaviour; a gate failure is never retried for an API outage.

A non-transient refusal (such as a plan limit) fails as infrastructure with `Remote executor
unavailable (boat): …` and boat's own error. A slot VM that never becomes ready (its disk still
restoring, SSH not answering) fails the attempt the same way, but a landing does not end on it:
that attempt ran none of the candidate's gate commands, so it returns to the queue and runs again,
at most twice per landing, with a `[verify]` progress line naming why. A retry waits on the slot's
existing VM and never deletes or forks one, so it costs no boat start beyond a resume. The attempt
past that bound, and any failure once a gate command has started, fails the landing as before. A
fault in the image or setup on a VM boat supplied fails at once as `Remote executor unavailable
(setup): …`; an SSH connection lost during a command fails it as `executor lost`. Moving a repository back to local
verification is removing `verifier` from its entry. With `verifier`, `verificationDepth: 2`
needs no combined host budget, since the gates share no host; each place still holds a
worker while it prepares and waits.

### The runner host's gate place

A repository verifying on boat can set `hostPlaces: 1` in its runner entry (SJ-189, Decision
#6249): one gate place on this host. The placement is chosen when an attempt's gate commands are
about to run, after preparation, so queue admission, screening lanes, depth and preparation are
unchanged and the place is never held through fetch, rebase or preparation. A gate that finds the
place free runs in the attempt's own runner checkout (`verifiers/<repo>/<slot>` or
`<n>-screen`), with no VM to restore; any gate that starts while it is busy opens its boat VM as
above, so concurrent gates still never share a host. A host attempt does what a VM attempt does:
it stops any process left with its working directory in the checkout, installs the candidate's
frozen dependencies through the runner's own install, requires the checkout to hold exactly the
candidate's tree before the gate and reads it again after (a gate that changed it fails the
landing), and stops whatever its commands left running there. Its commands run through the
runner's executor, inside the host-wide budget every run shares; its install is recorded as a
`dependencies` run, not a gate command. A fault in its setup fails the landing at once as
`Host executor unavailable (setup): …`, as a setup fault on a VM boat supplied does. A screen whose gate is in the
host place keeps its worker while the gate runs, so the queue admits no more host work beside it;
a screen on boat hands it back, as before.

The ledger's `remote_verification` `ready` event records `placement` (`host` or `boat`; earlier
rows are all boat), and a host attempt's events name the runner host as their machine and carry
no billing. `slipjay metrics` splits each group's gate attempts by placement, with median setup
and gate time for each, and reports the boat VM seconds the window's gate attempts were billed.

The boat hold applies to boat-placed gates only. While boat is held, one landing of the repository
may still start when the host place is free and none of its landings is in flight to take it
first, and the hold's `waitingFor` says so; a gate that then finds the place busy returns to the
queue for boat as any held landing does. A retry of a VM that was not ready runs in the host place
when it finds the place free, and otherwise waits on boat as before. `hostPlaces` is 0 or 1 and
needs `verifier`; 0 or omitted is boat only, and the place does not count against
`combinedLimits`.

### Named SSH gate places

With `verifier: "boat"`, a repository can set `gateMachine` instead of `hostPlaces: 1` (SJ-199):

```json
{
  "name": "peach-live",
  "machines": {
    "peach-box": { "ssh": "peach-box", "account": "ubuntu", "root": "/srv/slipjay-gate", "places": 3 }
  },
  "repos": {
    "pechhe/yardsmith": { "url": "git@github.com:pechhe/yardsmith.git", "verifier": "boat", "gateMachine": "peach-box", "screeningLanes": 3 }
  },
  "boat": { "image": "bx_starting_image" }
}
```

This is a fragment of runner config; keep the required `jj` identity and existing settings.
`places` (1 to 8, default 1) is how many gates the machine runs at once (SJ-200). Place 0 keeps the root itself, so an
existing warm checkout survives; place N works in `<root>/place-N` with its own checkout, holder and control lock. The
install cache and the `quota-ready` marker stay machine-wide. A gate takes the first free, healthy place, and with
every place held it queues for the next one freed. A landing slot of a machine-place repository keeps only
`slipjay.json` in its working copy, since the place receives the candidate as a bundle; switching it takes about
0.15 s on peach-live instead of 4 s. A landing that must install and generate migrations on the runner widens it to
every file first, and the next plain landing narrows it again. Each `stage_detail` records how many jj, git and gh
commands the stage ran, their total time and the slowest five. Its commands see `SLIPJAY_GATE_PLACE` (0-based) and
`SLIPJAY_GATE_PLACES`, so a repository that pins its own CPUs can give each place a different share of the machine.
The runner keeps one SSH connection open to each place, check place, build lease and host-load reader of a machine
(`<runner home>/ssh/<machine>-<place>/master`, ten minutes after its last command), so a command costs about 0.04 s
rather than a new connection's 0.45 s. A gate's parallel commands share its place's connection, so the machine's
sshd allows more than its default ten sessions per connection: peach-box sets `MaxSessions 64` in
`/etc/ssh/sshd_config.d/slipjay.conf`. The runner's Git transport does the same for its fetches, `ls-remote` and pushes
(`GIT_SSH_COMMAND`, sockets `<runner home>/ssh/git-%C`), unless its environment sets its own `GIT_SSH_COMMAND`.
Taking a place is one round trip: under the place's lock it recovers what a holder no longer running left, holds the
place and checks its quota, then prepares the checkout in the attempt's slice. Its `remote_verification` ready record
carries `steps`, the milliseconds each step of the open took. After the gate the place cleans up while the landing goes
on to publish; it takes no other gate until the cleanup is confirmed, and an unconfirmed cleanup quarantines it as before.
A machine's `buildPool` names the build machine pool it builds for, before boat
(see [Build machine](deployments.md)). It uses none of the machine's places or `root`.
Unknown machine names, a machine place without `verifier`, and a machine place combined
with `hostPlaces: 1` are refused at startup. With `gateMachine` absent all existing placement
behaviour is preserved. The choice stays at gate time: the free, healthy named place takes
the gate, including while boat is held; a busy or quarantined place uses boat. It never
falls back to the runner host. All repositories naming the same machine share one place,
screening included. A machine screen returns its runner worker while retaining the machine
place until its commands and cleanup finish, because its gate uses the remote machine's resources.

**Release-check place (`checkPlace`, SJ-202).** `"checkPlace": "release-check"` on a machine gives it one further
place, `check` under the root, that gates never use, serving the boat pool it names. A repository whose release policy
names that pool as `batchVerification.machine` runs its batch checks (scheduled, background and confirmed) and its
nightly audit there, one at a time, instead of on the pool's boat VMs or the runner host. One machine serves a pool. Its attempts run in `release-check-<id>.slice` beside the
gate slices, and see `SLIPJAY_RELEASE_CHECK=1` instead of a gate place; the installer gives `release-check.slice`
`CPUWeight=idle` and a `MemoryMax`, so gates and anything else on the machine win every contended core. Database
containers a check starts belong to Docker's own slice and run outside that bound. With the place down, the check
says so (`warning: … release-check place is down`), records the machine as down, and runs on a VM of the pool it
serves (the audit, and any check without a remote verifier, on the runner host); it never falls back quietly. The place
starts quarantined after a restart and is recovered at startup, every 5 s while idle, and once more before a check
counts it down. Each attempt records the CPU time its slice used.

The machine must provide Git, jj, the candidate's Bun, Docker, an SSH server supporting
reverse forwards, and a working systemd user manager for `account`. The SSH target is a host or SSH alias, with the account named separately, and uses the
runner account's normal SSH config and known hosts. Before enabling it, the machine's installer
must create the dedicated root, enforce a finite filesystem/project quota covering that root,
and write `quota-ready` inside it to attest that quota. Every attempt runs in
`slipjay-attempt-<id>.slice`, a child of `slipjay-attempt.slice`, so the installer bounds all gates together
with a drop-in on that parent (`MemoryHigh`, `MemoryMax`, `CPUQuota`) and writes the marker only after it. Record its size, account and resource
limits in the machine inventory. SlipJay refuses setup without
the marker; it does not install quotas or choose the machine's resource budget. The quota covers
all of the root, including the place-owned `checkout` and `bun-cache` directories. Both persist
across attempts: transfer excludes commits the checkout already holds, and frozen installation
reuses the Bun cache and the checkout's `node_modules`, including test caches. An unusable checkout
or a failed fetch can be reinitialised once during setup; failed repair falls back to boat before
any gate command runs. Logs, reports and temporary files remain in each attempt's own directory. Between gates the place cleans every untracked path in the checkout except `node_modules`, `.jj` and the
repository's `placeRetainedPaths`: gitignore-style patterns read from `slipjay.json` at the integration branch the candidate
rebased onto, never from the candidate. They exist for state a later gate verifies before reusing, such as keyed
generated output whose stamp records its inputs and an output digest; anything absolute, climbing out of the checkout or
malformed is ignored.
Docker data created by the gate must use its attempt label and the gate's bounded storage settings.

The gate receives `SLIPJAY_GATE_MACHINE` (the configured name), `SLIPJAY_ATTEMPT_ID` (a unique id),
`SLIPJAY_RESOURCE_PREFIX` (`sj_<id>`) and `SLIPJAY_DOCKER_LABEL` (`slipjay.attempt=<id>`).
Apply that exact Docker label to every container, volume and network; derive database and resource
names from the prefix. `TMPDIR` and the test report directory point inside the attempt's directory;
`BUN_INSTALL_CACHE_DIR` points to the place's persistent `bun-cache`. The gate must choose its own
database target, CPU/memory admission locks and resource budget; it must never inherit a Development target. Build's reverse-forward binds a
port allocated atomically by sshd, and the gate receives the rewritten Build URL.

An atomically created `holder` directory and atomically renamed `holder/id` record occupancy on
the machine before setup starts. Every command, including install, runs in an attempt-owned
systemd slice. Cleanup stops that exact slice, proves its cgroup empty, removes only containers,
volumes and networks with the exact attempt label, proves those gone and removes the attempt
directory. Containers are removed with `docker rm -f -v` so their anonymous volumes are removed too.
Cleanup removes checkout debris with `git clean`, preserving `node_modules` and `.jj`. Recovery
keeps the place-owned checkout and Bun cache.
The Build tunnel's login command belongs to the slice too, so restart recovery ends its listeners.
There is no VM-wide container removal, scope wildcard, Docker prune, checkout move or chown.

Startup quarantines the place. Recovery reads its on-machine holder and performs the same cleanup;
an SSH loss or unconfirmed cleanup keeps it quarantined. An unconfirmed cleanup after a gate only quarantines the place: it neither fails
that gate nor replaces its own verdict, such as a gate that changed the candidate's files. Recovery runs at startup, before reuse,
and every five seconds while quarantined, independently of boat admission. Gates use boat while
recovery cannot prove it clean. An unreachable machine or setup failure before any gate command
records infrastructure evidence and a fallback reason, then uses boat. A candidate failure stays
a failed gate; after commands start an SSH loss fails the attempt without replaying it elsewhere.
Cancellation stops the command's scope and then cleans the attempt.

`remote_verification` placements are `machine:<configured name>`, `boat` or `host`, and command
runs name their executor host. `gate_fallback` records its reason and whether it was busy or
infrastructure. `slipjay metrics` splits setup and gate median/p90 by these placements, counts
fallback reasons, and charges boat billing only to boat attempts.

A gate that finds every place of its machine held queues and never opens boat for that (SJ-200).
Queued gates take the next freed place in arrival order, off the runner's workers while they
screen, and a queued gate stops at once when its attempt is superseded or cancelled or its prefix
is invalidated. `gate_waited` records how long a gate queued. Boat is only for a place that is
down (unreachable, quarantined or failing setup), and that is never quiet: the landing prints a
`warning:` line, the runner logs it, and a `machine_place` event on the runner's own record marks
the outage once, with a matching `up` event when a gate next opens there or recovery proves it
clean. `slipjay metrics` reports submission to publication for landings split by test selection,
migration-trigger changes, and placement (`machine:<name> waited`, `machine:<name> at once`,
`boat`), with failed and relanded landings counted.


### Independent screening lanes

A repository verifying on boat can opt into `screeningLanes: N` in its runner
entry, beside `verifier` and `verificationDepth`. Omitted or `0` keeps the existing
ordered queue unchanged. Screening requires an isolated repository lane: gates
must be safe to run independently on distinct VMs. For YardSmith the initial
setting is `screeningLanes: 3`, `verificationDepth: 1`: three screening machines
plus the authoritative verification place.

Each submission prepares its immutable source on its **predicted prefix**: the candidate of
the latest-started screen of its repository that is still expected to publish, or the
integration tip fetched at screen start when there is none. It pins the policy and candidate,
and runs the same full required gate in an exclusive `slipjay-<owner>-<repo>-<n>-screen` boat
slot. A screen is not predicted past a screen whose change touches migration trigger paths or
the execution policy, since that publication is not the commit it prepared, and a landing that
conflicts with its predicted prefix screens on the tip alone. Preparation still reserves an
existing host worker; remote gates release that reservation so screens do not multiply
concurrent fetches or installs on the VPS. Screens never integrate, apply migrations, finalize
the integration target, run post-integration steps or deploy.

A screen behind a prefix publishes only after that prefix has. If the prefix does not publish
(its gate fails, it is killed, superseded or rebuilt), the screen behind it is stopped, returns
to the queue and screens again behind whatever is predicted then: its result behind a prefix
that will not land diagnoses nothing. A screen's failure behind a prefix that does land is its
verdict. A failed head screen returns the normal failure summary and classification at once.

Admission to the authoritative lane is oldest passed screen first, by completion order, among
screens whose prefix has published. The canonical publisher retains its exact-base and source
checks: a pass whose prepared base is the current tip publishes with no second gate, and the
ledger records `screen_reused` with the attempt and why (`slipjay land` prints it); a stale
pass, such as one whose tip moved by a publication the prediction did not include, prepares and
verifies again on the exact current tip. A screen on the tip alone that is still preparing or
screening when another landing publishes past its base stops at once and screens again on the
new tip: it returns to the queue and screens again like a new screen, rather than running on to a
pass it could not publish. A landing is sent back this way at most once; after that a move costs
the rebuild above. Evidence from different bases is never reused
(Decision #6144). Publication remains serial, and queued resets, releases and audits retain
their fences. Screening is separate from `verificationDepth`, which continues to govern ordered
speculative attempts.

A screen remains killable. Pausing stops new screens and holds completed screens
before authoritative admission; a running gate can finish and release its VM.
Restart recovery cleans screening slots as well as numeric authoritative slots,
and interrupted operations report the existing clear “land again” outcome.
Superseded or cancelled screens lose publication authority and stop their own
commands. Events, outcomes and `slipjay metrics` name the gate's `screening` stage
and record its duration separately from a later authoritative `verifying` stage.
