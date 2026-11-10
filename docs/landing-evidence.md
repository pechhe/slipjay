# Landing evidence and recovery

## Metrics and test reports

The runner's append-only SQLite operation log is the pipeline ledger. `land` keeps
its timing line on stderr, one duration per runner stage, then `housekeeping`: this
machine's own work after the verdict (recording the landing, sweeping other workspaces); `landings.jsonl` and `releases.jsonl` are no longer written.
`slipjay metrics [--since <ISO date>] [--repo <owner/name>] [--json]` reads that ledger and prints outcomes, cause
classes, and for each repository and operation kind (landing, release, verification,
deploy, reset) its median and p90 stage and command durations and active and paused
queue waits; kinds and repositories are never pooled. For each repository it then
gives its landing verify time against its budgets and split by how the gate selected tests,
its test files, and the files the nightly file-cost run should measure; then
held integrations, attempts per change, flake candidates, and workspace starts (per
repository and machine: starts, how many came from the spare pool, median and p90 claim time, and
median spares available, and the median of each start step that recorded `steps`, as in `start --json`). The claim time is the allocation itself, not `slipjay`'s own startup. The default range
starts at midnight UTC today. `--json` prints the same as JSON; `--repo` keeps one repository.

**Budgets.** A repository declares `budgets` in `slipjay.json`, a settings field
(`slipjay policy set`): `verifyP50Seconds` and `verifyP90Seconds` for its landings'
verifying stage, and `testFileSeconds` for any one test file's cost, measured one file at a
 time by the nightly `file-cost` run (see Test reports). A landing's or an audit's parallel
run is listed, never judged against it: 196 files sharing one host inflate every file's
time, and the same file measured 27.6 s alone and 74 s inside a complete run. The runner
records the budgets with each landing's verification, so metrics judge a repository by its
latest. A verify sample is a landing whose checks ran (not a settings landing, not cancelled),
timed by its verifying stage, over the 7 days ending now; each retry is its own sample.
A budget with fewer than 10 verify samples reports `insufficient-samples`, never pass or fail;
a test file's cost is judged on its own `file-cost` samples over the same 7 days, at 5 or more
of them, so a file over the ceiling with too few samples is listed but never over.

**Test reports.** Each gate command runs with `SLIPJAY_TEST_REPORT_DIR`, an empty
directory of its own. A command that writes reports there, with a manifest
`slipjay-test-reports.json` (`{"version":1,"selection":{"kind":"complete"|"related"|"none"},"reports":[{"format":"vitest-json"|"bun-junit","path":"<file in the directory>","suite":"<name>","cwd":"<repository-relative directory>"}]}`),
gets one `{file, suite, ms, status}` row per test file in its run's evidence. `selection` is
optional and additive, so a writer can name how the gate chose its tests without the runner
that reads it having landed first; the gate writes it, and metrics report landing verify
time split into related-selection (representative) and complete-selection runs. `timing`,
as additive (`{"wallMs":n,"concurrency":n,"criticalSuite":"<suite>","serialTailMs":n,"unusedPermitMs":n,"idleMs":n,"lockWaitMs":n,"suites":[{"name":"<suite>","queueMs":n,"startMs":n,"finishMs":n,"permits":n}]}`,
only `wallMs` and `suites` required), is where a gate that schedules its own suites says where
its time went: the runner keeps it on the run's `test_report` event whether the gate ran on
the host or on boat, drops one that does not fit that shape without touching the run's rows,
and metrics name each repository's critical suites with their median serial tail and the
gates' lock wait. A test
file's samples are its executed (not skipped) rows within one operation kind and suite, so a
landing's related run, the audit's complete one and the `file-cost` measurement are listed
apart and never pooled. A test
file is growing when the later half of its samples has a median over 1.2 times the
earlier half's, from at least 3 each. The command's exit status stays its verdict; a
command that wrote no manifest is recorded as `missing` and a malformed report as
`malformed`, and neither contributes rows. Each stage also
records the runner's load average, memory and running operations as it began, and
the queue snapshot gives each operation's `startedAt`, when it left the queue.

**Gate logs.** A gate command may also write diagnostic logs under `logs/` in that
directory, such as the full output of a sub-check it only summarises. When the run fails,
the runner keeps them in the run's output artifact (`logs`: path, text, `complete`), redacted
like the command's own output: up to 16 files, each read from its last 4 MiB and kept up to
1 MiB as head and tail. The run's artifact reference lists their paths, and a failed landing's
report names them beside `slipjay runner artifact`. A passing run's logs are discarded. On a
remote verifier the directory comes back from the machine with the reports, so a log survives
the machine's checkout being cleaned.

**The file-cost run.** `bun run test:file-cost` runs in the nightly audit: it takes the
files metrics list as `costCandidates` (parallel medians past half the per-file ceiling)
and runs each one in its own process (`--maxWorkers=1 --no-file-parallelism`), Vitest
files through `vp test run` and the runtime lane's Bun files through `bun test`, then
writes them under the `file-cost` suite. It fails the audit when the list cannot be read
or a measured file fails, and writes nothing when no file is near the ceiling.

**Flake candidates** are a test failing for two different changes, or a test that
failed and then passed on a retry of the same source commit verified on the same candidate (the
`verification_base` event's `candidate`); a pass on a different candidate shows the base changed, so it is not a flake, and a
failure or pass with no recorded candidate is not enough to confirm one.

Older operations retain their original evidence;
missing instrumentation is not synthesized as a measured fact.

## Local preflight and submission identity

**Local landing preflight.** When the submitted commit declares `landingPreflight`,
`land` runs its command in the submitting workspace root before contacting the runner,
including in a repair workspace. The default timeout is 120 seconds. A failure,
timeout or failure to start prints the command's output tail and refuses the landing;
nothing is submitted. A passing check that changes tracked source also refuses, leaving
those edits for you to review before rerunning `land`. Use checks, rather than formatters
that rewrite files. `slipjay land --skip-preflight` bypasses the command and says it was
skipped. With no declaration, no command runs. Each preflight that ran is posted to the
runner it lands to as a `preflight` client fact (passed or refused, its duration, and a
refusal's last line), by a detached process: `land` waits only for it to start, never
for the runner, and a fact that cannot be posted is one line in `pool-refill.log`;
`slipjay metrics --failures` counts them. Results are never cached, and the
preflight never runs on the runner: its landing gate still decides whether a candidate
may integrate. A preflight reruns on each invocation, including when following an
existing operation; `--skip-preflight` can bypass a broken check to follow it.

Assigned-workspace landings persist a request identity in local workspace metadata
before submitting. A lost or unreadable submission response is an **unknown outcome**:
run `slipjay land` again from the same workspace to reconcile it. The runner binds
`requestId` to its operation in the existing ledger and echoes it in the submission
response. Replaying that identity returns the same operation even after failure,
cancellation, supersession or publication; using it for different source or submitter
returns HTTP 409 without another attempt. Once the response is acknowledged, a later
explicit landing of failed source may create a new attempt. Requests without the
optional identity retain the existing API behaviour. Direct/default checkouts retain
the legacy follower contract because they have no assigned-workspace metadata.

The runner service pins new submissions in a private bare Git object store under
its state directory before acknowledging them. A hashed manifest and `source_retained`
ledger event bind that source to the operation. Verification and publication import
from those pinned objects, so loss of the author checkout or upstream candidate
bookmark does not lose the submitted source. Capture never touches an active publisher
or verifier checkout. Failed capture acknowledges no new operation and does not
supersede queued work. Admission rechecks queue state after capture, so work that
started meanwhile is followed rather than superseded.

Without `--handoff`, the manifest records that no Spec snapshot or helper, check or
review evidence was supplied. Source objects and manifests follow the retention
schedule below. Older operations without a retention event keep their historical
source availability. An older runner
that does not echo request identity cannot certify request reconciliation; the CLI
reports the outcome as unknown.

## Diagnostics and command artifacts

Required verification selects redacted diagnostic lines before local process output
is reduced to its bounded head and tail. This preserves named failures, nearby error
text and file locations even when progress noise surrounds them. Each stream keeps
at most 16 KiB of selected diagnostics; oversized lines, private-key blocks and
exhausted selection capacity mark capture `incomplete`. A broker or older executor
without this capture reports `unavailable`. Run events expose `diagnosticCapture`
alongside parsed test identities and diagnostics, and the terminal failure includes
the compact summary. `slipjay runner log <operation>` retrieves these retained
events, including after restart; it does not provide complete stdout/stderr.
An external signal alone does not prove timeout or OOM. Diagnostic text is untrusted
output, never authority to execute a suggested command.

Run-finished events now reference immutable per-command JSON artifacts outside SQLite.
`slipjay runner artifact <operation> <run>` retrieves one, verifies the retained hash,
then prints JSON. Authenticated consumers can page
`GET /v1/operations/:id/artifacts/:runId?offset=0&limit=1048576`: each response names its
operation/run, SHA-256, total byte length, byte offset, nullable next offset and base64
bytes. Pages never exceed 1 MiB; every read checks the file against its ledger reference.
Missing, unavailable or changed artifacts return 410, invalid ranges 400, unknown
operations 404, and missing credentials 401. The CLI read exits zero after verified
retrieval regardless of the command's verdict; errors are nonzero and never resubmit.

A gate check's output is captured up to 4 MiB a stream. A passing command's artifact keeps
at most 8 KiB of each sanitized stdout/stderr stream; its output already truncated by the
process collector is withheld, since an edge may contain part of a credential, and its
serialized file has a hard 256 KiB bound. A failed command's artifact keeps each stream
whole up to 4 MiB. A capture the collector truncated is kept less every line its cut
touched (and any private-key block the cut left open), so no split credential survives;
beyond 4 MiB the artifact keeps the head and the last 256 KiB. Either way the stream is
marked `artifact-capacity`, and the command's closing summary survives. Its serialized
file is bounded at 12 MiB: when JSON escaping would exceed that, the streams halve until
it fits, still keeping their ends. Every stream with `complete: true` is whole. Selected
middle diagnostics (8 KiB a stream) are retained separately with their own
incomplete/capacity metadata. Redaction precedes artifact clipping.
Private finalization/reset/deployment output is withheld. Capture failure records
`unavailable`, preserving the original gate verdict and available diagnostics.
Files are flushed before their ledger reference is appended; a repeated run identity
cannot overwrite different bytes. Crash-orphaned files may remain without a ledger
reference and cannot be retrieved through the API. Artifacts follow the retention
schedule below.

## Author handoff and adoption evidence

`slipjay land --handoff <json-file>` optionally supplies version-1 author evidence
alongside the exact source. The file is at most 64KiB. All fields below are required;
arrays may be empty and `spec` may be null. A Spec snapshot's SHA-256 must match its
exact UTF-8 body. Revisions are full 40-character commit IDs. Each evidence array
has at most 32 entries. Intent, scope entries and evidence details are at most 2,000
characters; the Spec snapshot is at most 32,768 characters.

```json
{
  "version": 1,
  "source": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "intent": "What this candidate delivers",
  "scope": ["src/lib/example.ts"],
  "spec": null,
  "helpers": [],
  "checks": [],
  "reviews": [],
  "toolchain": [{ "name": "bun", "version": "1.4.3" }],
  "gaps": ["Independent review pending"]
}
```

A non-null `spec` has `ref` (`owner/repo#57`), `bodySha256` and `snapshot`.
Helpers have `revision`, `base` and `scope`; checks have `revision`, `command`,
`result` (`passed`, `failed`, `not-run`) and `detail`; reviews have `revision`,
`reference`, `result` (`complete`, `incomplete`) and `detail`. These are author
reports, never runner verification, independent-review approval or repair authority.
Empty evidence arrays do not establish that a check or review was unnecessary.

`adopt` records are merged into `helpers` when the first submission is frozen,
one entry per original revision with its helper base and changed paths as `scope`;
explicit handoff helpers merge by revision too. Retries replay that evidence.
After publication, adoption coverage (workspace name, base, revisions) is retained
in the repository-scoped artifact archive, independently of the lead's checkout
and metadata. Only that archived coverage authorises helper retirement; historical
or hand-supplied `helpers` never do, and helpers receive no landing record of their
own. Remove, cleanup, prune and sweeps share this judgement: every non-empty commit
outside integration must be covered. Any later helper commit keeps it protected.
The archive retains the lead's original published source. Its ancestry counts as
delivered even when publication flattens it under new commit IDs, so a review or
verify workspace based on the candidate can retire too. Helper branches still
require exact recorded adoption coverage. Source-only coverage preserves Issue
guards: an open Issue still protects its review workspace from removal and sweeps.
Post-publication cleanup preserves
ancestry held by other workspaces so those pinned helper revisions remain unchanged.
At freeze, an adoption must remain in the candidate's JJ evolution and at least
one of its changed paths must remain changed relative to the lead's start base.
Dropped adoptions are removed with a warning. Pending adoptions are consumed by
freeze; the operation-bound frozen copy survives retries and is archived by the
client, cleanup or state pruning. A new submission carries forward an earlier
frozen adoption only when runner facts prove that landing was declined, cancelled,
superseded or failed before integration, or when it has neither an operation nor a pending
submission request. Before replacing a queued candidate, the new freeze also copies
its adoptions before posting to the runner, keeping the original until supersession
is confirmed. A crash or lost response cannot lose either landing's provenance.
Future freezes defer copies while their original submission is unresolved, and
omit copies of already archived adoption coverage.
Other queued, running and unknown-outcome submissions, including
failures during integration or publication, keep their adoptions until resolved.
Transferred adoptions leave the old record; published submissions keep their
evidence without resending it. A failed push or definite submission refusal clears
the pending request so a changed candidate can reclaim that freeze. Lost responses
and retained operations still awaiting Forge admission keep their request identities.
Each adoption run keeps its own evolution anchor, so undoing a later adoption does
not drop earlier helper revisions. Conflicting adoption duplicates are abandoned
before any squash, preserving other workspaces' operations.
Frozen handoffs and adoption records keep the
same newest 32 acknowledged submissions and all unresolved submissions. Large
helper scopes collapse to enclosing directories (or `.`) to fit the evidence bound.
Before publication is known as of the last fetch, `prune --plan` reports
`adopted, landing not published`; another guard (runner facts, processes or unique
files) may take precedence. Unadopted contributions remain `unlanded work`.

An optional `build` object carries the author's Forge binding for the Spec work:
`specId` and the lead execution `sessionId` (UUIDs), `ticketIds` (up to 200 distinct
UUIDs, possibly empty for work with no Tickets), `bodyRevision` (the numeric HQ Docs
revision, or `null` when unknown), and `bindGeneration` (an integer of at least 1).
All five keys are required when `build` is present and are retained exactly as
supplied; an invalid binding is refused before retention. Omitting `build` records no
Forge claim; `build: { "unassociated": true }` instead states that the work belongs
to no Spec, so once published it is reported to Forge as a chore landing titled by
the handoff's `intent`, and it is never admitted. Nothing is inferred from the Spec ref, the identity's `sessionId` or
branch names, and `bodyRevision` and the Spec's `bodySha256` are never coerced into
each other.

## Forge admission and receipts

**Forge admission.** A runner accepts a submission with a `build` binding only when its
config sets `build.origin` (HQ's https origin, or a loopback http one) and its environment holds
`YARDSMITH_SLIPJAY_BUILD_TOKEN`; otherwise it refuses the submission (400) rather than
queue it unadmitted. After retaining the source it records the operation as awaiting
Forge admission, then calls Forge's `admitAttempt` (`POST {origin}/api/build/runner`)
with that `submitted` record's ledger sequence, waiting at most 10 seconds. Until Forge
admits it the operation has no place in its queue and never starts (`waitingFor`
reads `Build admission`, followed by the latest unavailable reason when recorded); once admitted it queues as usual, and a pause still holds
it. A Forge refusal (`bind_generation_stale`, `admission_session_invalid`,
`delivery_pending`, `attempt_fact_conflict`, or an input Forge will not accept) ends
the operation as `declined` with Forge's code, and nothing runs. Only `delivery_pending`
is marked retryable: another delivery of the Spec is still in Forge's custody, so land
again once it has finished. When Forge does not
answer, the runner keeps the operation awaiting admission and refuses the submission
as retryable (503). It records `admission_unavailable` on that operation, with the reason and the
ledger timestamp, only when the reason differs from its last such event, so repeated identical retries
add no events. The queue projection and `runner outcome` expose the latest reason and time as
`admissionUnavailable`; `waitingFor` names the reason while queued. The operation remains queued
with admission pending. The receipt drain then keeps offering that same admission until Forge
answers, which Forge replays, so a lost response never opens a second operation and
needs no further landing; running `slipjay land` again only asks sooner. An owner may
cancel an operation awaiting admission: the drain still settles its admission, and if
Forge had admitted it, reports it `failed` (`cancelled`), so Forge never keeps custody of
abandoned work. A newer candidate of the same change names the queued one it supersedes
to Forge; if that one's admission never got an answer, the runner resends it first, and
while Forge stays silent it refuses the newer candidate as retryable and leaves the queued
one as it was. A Forge-bound newer candidate replaces the queued one only once Forge admits
it: until Forge answers, the queued one waits (`waitingFor` reads `Forge admission of a
newer candidate`), and if Forge refuses the newer one, the queued one keeps its place.

<a id="forge-reads"></a>**Forge reads.** A runner with a Forge connection also answers clients' reads of Forge at
`POST /v1/build/read` (`{ "action", "input" }`, with the runner token), forwarding only Forge's read-only
`read`, `list`, `waits` and `binds` actions to its runner route; any other action is refused (400) before Forge is
asked. The answer is `{ "value" }`, Forge's refusal is 409 with its `code`, and no answer is 503. So a
client of a Forge-tracked repository needs only the runner token: the Forge credential never leaves
the runner. A runner without a Forge connection refuses the read (400).

<a id="forge-check-access"></a>**Forge access for checks.** In a Forge-tracked repository (`tracker: "forge"`), a
landing's `requiredLandingVerification` commands and its `migrationFinalization` `generate` and `verify` commands
can see Forge:

- A Forge-bound landing (`slipjay land --session … [--ticket …]`) gives them `SLIPJAY_BUILD_CONTEXT`,
  `{ "version": 1, "specId": "<uuid>", "specNumber": <n>, "ticketNumbers": [<n>…], "sessionId": "<uuid>" }`, from
  the binding Forge admitted, never from commit text. The runner reads the Spec's and Tickets' numbers by id when
  Forge admits the landing (an admission whose items it cannot read stays unresolved and is offered again), so the
  checks get them without Forge having to answer while they run.
  A chore (no Forge item) gets no `SLIPJAY_BUILD_CONTEXT`.
- Every landing, bound or not, gives them `SLIPJAY_BUILD_READ_URL` and `SLIPJAY_BUILD_READ_TOKEN`. A check POSTs
  `{ "action", "input" }` to the URL with `Authorization: Bearer <token>` and gets the answers of
  [Forge reads](#forge-reads): `200 { "value" }`, `409 { "code" }` for Forge's refusal (`build_item_unavailable`
  for an unknown item), anything else meaning Forge gave no answer. Only `read`, `list`, `waits` and `binds` are
  allowed. The token is random, reaches no other runner route, is good only while this operation runs and
  never outlives a runner restart; it is neither the runner token nor the Forge token, and it is redacted
  from the runner's logs and stored evidence.

On a runner with no Forge connection, and in a GitHub-tracked repository, neither read variable is set: a check
that needs Forge should refuse by name rather than pass. Dependency installs, finalization, deploys and resets get none of these.

<a id="forge-receipts"></a>**Forge receipts.** For each admitted landing the runner owes Forge a receipt for each
fact it reports, named by the operation and that fact's ledger sequence: its admission
delivers `submitted`, and an admission Forge never answered is owed like any receipt; its first held integration is reported `held`; its outcome is
`published`, or `failed` with how it recovers (`publication_unknown` when it failed while
integrating or after integrating its own candidate, `cancelled` for an owner cancel or kill,
`superseded`, `policy_refusal`, `infrastructure_retry` for an infrastructure failure or one
retrying an earlier landing's hold, otherwise `code_repair`); and an integration whose
publication was unknown is reported `published` once any later reconciliation confirms it,
or `failed` with how it recovers once the runner releases it (`integration_released`). That
release also ends any attempt that failed retrying the released hold, should Forge still
hold it open; Forge answering that it already ended counts as delivered. Each command it ran is reported through `recordAttemptRun` as a named run
(`passed`, `failed`, `incomplete` or `cancelled`, with its failing test names), attached to
the outcome fact and sent only after it; a pass with no recorded verified candidate is
reported `incomplete` with that gap. A settings landing that skipped its checks reports no
`verifiedRevision` on any attempt receipt, and one `incomplete` run (`verification-skipped`)
whose known gap names the changed fields and the reason. Repair linkage comes only from a repair the author
proposed, never from queue-prefix ancestry. A declared chore reports only its
publication, through `recordChoreLanding`, and its `land` output says the landing is a chore: it names
the Forge number Forge created for the chore and the landed revision, and names
`weave_forge_associate_landing` as the way to attach it to a Spec, in this repository or another Forge
repository. A Spec spanning repositories lands its parts in the other repositories as chores, each
attached the same way. Nothing is attached automatically, a `Forge: #<n>` or `Spec #<n>` line in a commit
message is never trusted, and SlipJay has no attach command of its own: Forge refuses the runner's identity.
Every receipt repeats the admitted source tuple:
the author's commit as `candidateRevision`, the Spec, Tickets, body revision and hash,
and the bind generation. An independent drain reconciles unanswered admissions and sends owed receipts in ledger order,
trying later admissions even when an earlier one remains unanswered; receipt delivery stops at its first unavailable answer.
An unresolved admission never blocks later admissions or receipts for already-admitted work;
either lane still owing an answer retains the shared outage state and exponential backoff. The drain
records each delivery in the ledger, and resends until Forge answers, which Forge
replays, so a Forge outage, a runner restart or a lost response delays a receipt but
never loses it, and catch-up needs no further landing. When Forge stops answering the
drain backs off (1 second, doubling to 5 minutes) and records a runner-wide
`build_delivery` event, so watch clients see the outage; the queue snapshot's `build`
reports whether Forge is answering, how many receipts are owed and since when, and how
many are parked. A receipt Forge refuses, including one it finds too large, is parked with its code and never holds back
another operation's. When Forge refused one through its own fault and has since been fixed, `slipjay runner resend <operation>`
requeues that operation's parked receipts (recorded as `build_receipt` `requeued`, naming who asked): the drain sends
each as a first delivery, which Forge replays, and one refused again is parked with its new code. A refused admission is
not a receipt and is never resent. A failure's command lists and excerpt are cut, and the receipt marked truncated,
to keep each request under 200 KB. A landing's outcome reports its `build` admission and receipt
state apart from its verdict: a published landing whose receipt is still owed is
landed, with `receipts: "pending"`. Refused, unadmitted and unbound operations owe
nothing. No Forge call is made during integration or publication.

## Reading retained handoffs and source

The client redacts with its environment before transport, then the runner redacts
again before retention. Redacted Spec snapshots receive a new snapshot digest and
a gap preserving the original body digest. Unknown credentials cannot be detected
reliably: supply evidence without secrets. The manifest records redaction status,
input digest and explicit missing repair authority. Its immutable file and parent
directories are flushed before acknowledgement. Reusing a request identity with
different evidence is refused; evidence on an existing acknowledged operation is
immutable. Reattaching to an existing operation observes its original evidence.

`slipjay runner handoff <operation>` retrieves the retained sanitized manifest as
JSON through authenticated `GET /v1/operations/:id/handoff` (`{ manifest }`). It
checks the ledger digest before serving; missing/tampered evidence returns 410,
non-landing operations return 409 and unsupported runners may return 404/501.
Read failure exits nonzero. This read never creates a repair claim or resubmits.
A manifest records what the author supplied; it does not certify that a fresh worker
has every reproduction prerequisite, and its gaps say what is missing.

`slipjay runner source <operation> <bundle-file>` downloads a self-contained Git
bundle of the exact retained source, including ancestry, into a **new** local file.
It checks the operation's retained-source acknowledgement, declared size and SHA-256
while streaming to a private temporary file, then installs the completed file without
overwriting an existing destination. Source bundles are authenticated repository
content, not sanitized diagnostic logs. No author chat or warm checkout is needed.

The API is `GET /v1/operations/:id/source`; success streams `application/x-git-bundle`
with `Content-Length`, `X-SlipJay-Source`, `X-SlipJay-Operation` and `X-SlipJay-Sha256`.
Generation uses the existing bounded executor (120-second command deadline), validates
the bundle's ref/source and rejects completed bundles above 128MiB. This is an export
size limit, not a hard temporary disk quota while Git builds the bundle. The client
has a five-minute request deadline. Unsupported export is 501, unavailable/capacity or
missing retained evidence is 410, non-landing is 409 and unknown operations are 404.
An interrupted export can be requested again without retrying the landing. Normal
completion/failure/disconnect removes the derived server bundle; a process crash may
leave a temporary file. The retained private source ref and manifest follow the
retention schedule below.

The public `importSourceBundle(bundle, assignedCheckout, operationId, sourceCommitId)`
validates the bundle's exact operation ref and imports immutable objects into an
already assigned authoring checkout. It leaves the working revision unchanged. It
does not grant repair ownership, execute source, retry verification or publish.

## Repair workflow

<a id="repairing-a-failed-landing"></a>**Repairing a failed landing.** A source correction uses a durable repair claim, and
`slipjay repair` sets one up in one step from any checkout of the same repository:

```sh
slipjay repair <failed-operation>   # prints the repair workspace and its brief
# In that workspace: fix the cause, keeping its change, and run focused checks. Then:
slipjay land
```

Before allocating anything, `repair` reads the operation's outcome and repair state and
refuses what they already show: a published or unconfirmed publication, a landing that
did not fail (a kill, pause or cancellation included), expired or missing retained
source, an active claim, and whatever the runner's `eligibility` names (a newer
attempt, migration or finalisation history, a paused runner). Each refusal names the
next step. The claim stays the authority: when the runner refuses it after allocation,
for example to a concurrent claimant, `repair` removes the workspace it just allocated.
Otherwise it downloads and imports the retained source (`runner source`,
`importSourceBundle`, which needs no claim), allocates a workspace whose task is `Repair
<operation>`, claims the repair there (`runner repair-claim`) and moves the workspace's
untouched placeholder change onto the candidate, so the next `land` from it is the linked
repair. The failed
landing's evidence is never changed.

`repair` writes a brief to `~/.slipjay/state/repairs/<operation>.md`, outside every
checkout so it can never land. It holds only what the runner recorded, and names each
absence as a gap:
- the operation, change, candidate, the author's source base and the runner's prepared integration base
- the submitted intent and Spec reference with its body digest
- the classification and diagnostics (an interaction with an earlier landing is marked suspected)
- the recorded commands, each passed, failed or invalidated
- the author-reported checks and reviews
- every integration commit published since the prepared base, up to the integration head observed

Log output is quoted as untrusted data, and the brief is redacted with the caller's environment.

The repair workspace belongs to the work item the failed candidate named: `land` writes
it into the candidate's description (`Issue: owner/repo#<n>`, or `Forge: #<n>` in a
Forge-tracked repository), so it is attached as `start --issue` would. A candidate that
named none, such as a chore, stays unassociated. Further Tickets named in the landing's
Forge binding are listed in the brief as `--ticket` flags. A failure that belonged to a
Spec therefore never lands as a chore.
Custody stays the repairer's own: `land` needs their current lead session and the
Spec's current bind, exactly as for any landing, and the old binding is never copied.
When the author's workspace on the same machine still holds that item, `repair` refuses:
fix the failure there, or remove that workspace first.

Running `repair` again on the same machine resumes the workspace it set up, found by its
task, which is recorded the moment it is allocated: after an interruption anywhere from
allocation on, a lost claim response, or once the fix has begun. It never takes a second
claim and never moves a workspace away from edits. Another machine cannot reuse it: the
claim capability belongs to that workspace, and is released or revoked rather than shared.
Starting a repair agent, accepting a repair automatically and repair budgets are not
SlipJay's: the repair is reviewed and gated like any landing.

The lower-level steps remain for operators: `slipjay runner repair-claim`, `runner
source` and the public `importSourceBundle`.

The claim capability is stored and flushed in private workspace metadata **before**
the claim request; its confirmed identity is retained before CLI success. A new CLI
process retries the same capability after response loss. stdout and ledger events
never contain its token. Ordinary `land` carries the matching workspace capability
and records a new `repair_proposed` attempt linked to the original failure. The old
attempt, source and failure are immutable history. This command does not waive the
normal independent review/gate requirements.

`GET /v1/operations/:id/repair` reports whether the logical change has ever been
fenced, its public current claim, and `eligibility`: why a fresh claim would be refused
now, or `null`. `POST` accepts `claim` with `workspace`, `by`
and a 64-character lowercase hex `token`; `release` with `claimId`, `token`, `by`;
or explicit owner `revoke` with `by`. All use the existing runner credential. This
is the runner's existing trusted-owner API, not a separate person/agent role system.
Claim/release/revoke failures return 409, invalid input 400, missing operation 404,
missing or invalid retained handoff 410, unsupported validation 501. Owner revocation
is an explicit control action; loss of heartbeat never invokes it.

Only the latest confirmed pre-publication gate/conflict failure with retained source
and a valid manifest accepts a fresh claim. Pause, kill/cancellation, held/unknown
publication, published source and migration/finalisation-sensitive histories do not.
Only one claimant may write a logical change, across retry attempts and runner
restart. The capability is checked before candidate transport and again by server
admission after source capture. Reattachment to an already accepted operation remains
observation. Claims have no automatic timeout: offline admission is not exclusive
ownership, and an absent author is not permission to take over.

`slipjay runner repair-release <operation>` releases the holder's claim.
`slipjay runner repair-revoke <operation>` is an explicit owner override after a
lost/stale claimant. Neither may change repair ownership while the runner has an
admitted queued/running attempt: wait or explicitly cancel that attempt first.
A released/revoked claimant cannot submit source, and releasing does not silently
restore the original author's write authority. A new claimant must acquire a new
capability on the latest repairable failed attempt. Publication closes the claim.
No automatic repair session or model is started.

## Retention

**Retention.** A landing attempt's retained source ref, handoff manifest and command
artifacts are kept while it is queued or running, while its publication is
unconfirmed, and while its logical change has an active repair claim. Otherwise they
are deleted 14 days after the attempt's outcome once any attempt of its change has
published, or 30 days after it when none has. The runner checks at start and every six
hours, and records an `evidence_expired` event: `outcome` then names the policy and
time, and `source`, `handoff` and `artifact` return 410 saying the evidence expired.
Unreferenced source objects leave the private store through Git's own gc expiry, so a
submission retained at the same moment keeps its objects. Claim a failure within 30
days to keep its evidence.

The ledger is bounded the same way. It keeps an operation's every event for 31 days
after its newest one; past that it forgets what only explained the work — command runs,
stages, test reports, progress lines and client traffic — and keeps what a read across
operations needs: the submission, its terminal result, the commit it integrated or
published, its gate verdict, holds and settlements, an audit's head and cause, repair
claims, Build admission and receipts, the evidence-expiry record, and its submission's
dedupe key. An open operation, one inside the window, one whose retained source is not
yet recorded as expired, one whose file deletion was cut short, and one whose receipts
Build has not taken stay whole. A retained source is named only until its expiry is
recorded, so the scan for evidence to expire stays a month deep rather than growing
with every submission ever. A year after its newest event, an operation and those
lasting facts go too: past every window in which anything reads them, and the point at
which the ledger, the scans over it and its recovery cost would otherwise grow with
the runner's age. A submission's request id is deduped while the ledger keeps its
operation: for a year, or longer when the operation is retained below, after which a
resubmission opens a new operation. An operation another surviving operation's facts
name is kept, as is each repository's newest landing and everything those kept
operations still name, whatever its age.
`slipjay metrics`, `runner log` and `runner outcome` show the last 31 days in full,
the year's facts behind them, and nothing older.

## Outcomes and failure classification

`slipjay runner outcome <operation>` reads one landing's version-1 JSON evidence
without following or submitting it. The authenticated API route is
`GET /v1/operations/:id/outcome` (`{ outcome }`); the same object appears on landing
operation projections and in `slipjay land`'s stdout as `outcome`. Existing `ok`,
`verdict` and `log` fields remain. Older runners may omit it. The read command exits
zero when evidence was retrieved, including for a failed or live operation; read
`status` and `terminal` for that operation's outcome. Unavailable/unsupported evidence
is a nonzero command error. The API returns 404 for unknown operations, 409 for
non-landing kinds, and 401 without the runner credential. Normal landing exit codes
remain zero for the requested published candidate and one otherwise; progress stays
on stderr.

The object records its operation-local `asOfSeq`, source/request/actor identity when
available, the latest prepared attempt and exact base/candidate, versioned failure
classification, bounded causal excerpt, and all recorded command completions with
invalidation flags. An invalidated pass remains historical evidence, not a passing
current attempt. Missing run completions are `incomplete`; signals do not establish
OOM. `evidence.coverage` is always `partial` until complete artifact and handoff
contracts exist: gaps explicitly include absent exact argument/cwd records,
unstarted/skipped units, artifacts and repair authority. Missing structured command
context is reported per historical or capacity-limited run.

New run-start events include structured `commandEvidence`: executable, argument
array (including empty arguments), checkout-relative cwd, environment variable names
and a configuration fingerprint. No environment values or stdin are retained.
Known credential values, secret flags and URLs are redacted before recording, and
the display command uses the same sanitized context. A redacted argument is not
replayable input; a cwd outside the checkout is `null`. The fingerprint covers the
sanitized command and execution limits, excluding environment values, and is not
proof of identical credentials or runtime configuration. Context is bounded to 256
arguments, 32 KiB of executable/arguments and 256 environment names/8 KiB of names;
excess capacity reports `unavailable` without silently clipping individual arguments.

`publication.state` is `published` only for that operation's landed verdict. An
integration/publication intent, held integration, or failure at the integration tail
reports `unconfirmed`. It may have been recovered by a different operation: this
historical projection cannot certify current remote refs or external migration state.
`recovery.kind` calls for reconciliation before retry in that case; every outcome
has `automaticRetry: false`. A read never claims a repair lease or releases the
author workspace. Owner cancellation and supersession remain terminal history.

Cause rules in `src/lib/runner/failure-classification.ts` carry their version on every
`classified` event (rule 2 adds `firstErrors` and `failureCauses`, rule 3 a `category`): `gate` for a failed verification, `conflict` for a rebase
conflict, `infrastructure` for fetch/install/executor problems or a timeout before
test execution, `policy` for declined paths, `killed` for the owner's kill,
`paused_out` for cancellation during a pause, `held` for incomplete finalization
or publication after integration, and `superseded` or `cancelled`. A gate failure
on a new base links an earlier verified attempt of the unchanged submission.
Recurrence is projected from evidence, never written back into historical facts.
A flake candidate needs the same named test and command to fail in different
changes in the selected window. It is confirmed when a later successful run of
the same command in the same repository uses an unchanged source tree from a
failed run. Candidate and confirmation are reported separately.

**Failure category (rule 3).** A `failed` event's `classified` fact also carries `category: { kind, evidence }`:
the one answer to "why did this fail" a reader of delivery health needs, separate from `cause`, which says where the
runner saw it fail. Declined, cancelled and superseded operations did not fail and carry none. The first rule that
matches decides, and the evidence is the line that matched; anything the evidence does not decide is `unresolved`, never a guess.

| `kind` | When |
| --- | --- |
| `flake` | The failed event says a batch check was flaky (it failed, and its rerun passed or failed only other tests). |
| `moved_base` | A rebase conflict; a predecessor or prefix invalidated; a refused move of the integration bookmark; or a gate failure of a commit that passed earlier at another base (`interaction`). |
| `infrastructure` | The event names a runner, remote or credential breakage (a restart, a fetch or push failure, an unavailable executor, a missing toolchain, a full disk, a deploy timeout); or a gate failure whose tests timed out while the host's load average was at least twice its CPU count when the check began. |
| `regression` | A gate check failed and names an error, a `Failure cause:` or a diagnostic of its own. A failing test alone, with no error attributable to it, is `unresolved`. |
| `unresolved` | Everything else: a check that names nothing, tests that timed out on an idle host, a failed stage whose event names no breakage. |

A failure recorded before rule 3 has no `category`; `failureCategoryOf` gives it the one the rule would, from its
recorded failed event, classification and stage health, so reports read old and new failures alike; they say so (`categoryRecorded: false` in `slipjay audit status`, a derived count in `slipjay metrics`), because that reading is the classifier's, not a recorded fact. It is weakest on flakes, which need a later passing run that does not exist when a failure is recorded: `flake` appears only when the failed event says so, and a failure that later passed on the same input stays what its evidence said at the time. A failing audit's
category and failing tests are shown per night by `slipjay audit status`, and `slipjay metrics` counts failed landings
and audits per repository by category with the machine time their commands ran (`Failed landings and audits`).

A failure's summary names the error of the failing test itself: the error block printed after its `FAIL <test>` line
(Vitest, node:test) or before its `(fail) <test>` line (Bun), not the first error anywhere in the output. When the
output attributes no block to the test, the first error in the output is shown as before.

**Naming a failure.** A gate command names what failed, for the classification and for `slipjay land`'s
structured failure (`outcome.classification`, per check in `checks`), by ending its
output with a summary in this form:

```text
Landing failure summary:
FAIL <file> > <test name>
  first error: <the first line of its error>
Failure cause: <a cause that is not a test, such as "core typecheck: error TS2322 …">
```

The `Landing failure summary:` (or `Failure summary:`) line opens it. One `FAIL` line per
failing test, each optionally followed directly by one `  first error:` line, which pairs
them in `firstErrors`; one `Failure cause:` line per failure that names no test, collected
in `failureCauses`. Both are absent when the output named none. When the output carries
a summary, its `FAIL` lines are the failing tests: none is inferred from the output
around it, so a test file a runner printed relative to its package, or a recap filed
under the wrong file, cannot add a second or wrong identity. Vitest, Bun test and node:test failures are recognised as failing
tests without a summary; the summary adds the pairing and the causes. YardSmith's
`test:landing:affected` writes one (SJ-140).

The authenticated `GET /v1/metrics/events?since=<seq>&limit=<1..1000>` exports
events in global sequence order, returning `events`, `nextSeq` and `hasMore`.
`POST /v1/operations/:id/events` accepts only bounded client facts with a caller's
event `id`; repeating that id returns the original event. Clients cannot post
runner stages, results or classifications. Workspace starts and pool claims use
attributed client operations, created by `POST /v1/client-operations`; `land`
records following and reattachment on its landing operation. Hosts may call the
public `recordClientFacts` library export for preview and transport observations,
or `slipjay record-preview <port>` after starting a workspace preview. These
observations never enter the landing queue.

## Pipeline metrics relay

**Pipeline metrics relay.** HQ runs where it cannot reach the runner, so a runner with
`build.origin` and `YARDSMITH_SLIPJAY_BUILD_TOKEN` pushes its own export: at start, five seconds
after a new ledger event (a burst goes in one pass, and an event during a pass is followed by
another), and every 30 minutes regardless, it `POST`s pages of `/v1/metrics/events` (`{since, events, nextSeq, hasMore, observedAt, repositories}`) to
`{origin}/api/build/runner/pipeline` with the same bearer as Forge admission. HQ owns the cursor: a
pass opens with an empty page to learn it and follows any 409 to the cursor HQ names, so resending
a stored page is harmless and the relay keeps no state. Each pass includes the watch snapshot's repository release summaries and observation time verbatim, including idle keepalives, so Forge can show release waits without new events. The summary counts toward the same body cap as the events. A page is read again with a lower `limit`
until its body fits 3 MiB. It shares nothing with the landing queue or the receipt drain; every
read and POST is aborted after 30 seconds, and a failure is logged to the runner's stderr and
retried at the next tick.

SSH forwarding failures in an assigned workspace are retained as pending delivery
fields in its existing metadata until the same runner address can be reached.
Delivery reuses a stable event ID and its client-operation ID after an interrupted
acknowledgement. Pending facts keep the workspace from being removed. The runner
log remains the ledger; metadata is cleared after acknowledgement. A command run
without isolated workspace metadata reports when durable retention is unavailable.
Migration generation and migration verification carry distinct typed `purpose`
values on their command runs; source-tree evidence is taken after generation,
immediately before the gate.
