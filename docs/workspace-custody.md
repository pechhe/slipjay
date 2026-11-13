# Managed workspace custody, protocol 1

SlipJay is the environment-local retirement authority. T3 is the publisher of
settlement for its closed obligation set. SlipJay stores independent caller
claims; it does not inspect T3 state, infer provider descendant ownership, or
implement the consumer's obligation registry/admission epochs.

## Consumer sequence

1. Run `slipjay claims capability` on the actual execution host. Require
   `ok: true`, `capability: "generation-bound-custody"`, `protocol: 1`,
   `supported: true`. Linux and Darwin have controller identity readers. Use
   that reply's `producerEntry` with the producer's Bun runtime for subsequent
   calls; do not silently fall back to an older `slipjay` on PATH.
2. Switch the managed launch paths to this producer, then run
   `slipjay claims activate`. It checks the managed-worker drain barrier and
   returns `{ok:true,version:1,activationId}`. Repeating activation after a
   successful drain preserves the ID. An unavailable inventory or an old worker
   refuses activation; it neither stops workers nor disables housekeeping.
3. Obtain the controller's diagnostic identity with
   `slipjay claims controller <pid>`. The controller is T3's actual run/runtime
   custodian, not the short-lived allocating CLI. A missing/changed identity
   leaves custody recovery-required; it never authorizes release.
4. Register the consumer's active admission epoch before source use. For a new,
   resumed or bound workspace, use `start --claim-stdin --json ...` with the
   acquisition JSON on stdin. The producer acquires while allocation is held,
   before dependency preparation, `onAcquired`, readiness or stdout publication.
   The normal start JSON adds a `claim` receipt. For an already allocated attach
   or child checkout, use `claims acquire <path>` before publishing the binding.
   Prepared pool spares must first be allocated, not adopted as active work.
5. Complete/stop or obtain acknowledged custody transfer of every obligation in
   the consumer's atomically closed epoch. Then use `claims release <path>` or
   `claims transfer <path>`. Cancellation, terminal projections, missing adapters,
   controller EOF and elapsed time are not such evidence. Unknown outcomes must
   be retried with the same request and reconciled through status.

All mutation payloads are JSON objects on **stdin**, at most 64 KiB. Credentials
must not be put in argv, logs or public status. Identifiers/references are bounded
strings of letters, digits, `:._/-`; credentials are 32–512 characters. The
consumer generates a fresh unpredictable credential, retains it securely with
its durable request, and reuses the exact request when reconciling a lost reply.
No credential is returned in any JSON response. `activationId` is a versioned
activation marker, not a credential authorizing another caller's claim mutation.

## Wire objects

`claims acquire <path>` and `start --claim-stdin --json ...` accept:

```json
{
  "activationId": "activation receipt ID",
  "requestId": "unique acquire operation ID",
  "ownerId": "public caller/run/attempt/epoch ID",
  "credential": "consumer-generated secret of at least 32 characters",
  "controller": {"platform":"linux","pid":123,"boot":"boot identity","start":"start identity"},
  "obligationRef": "t3:closed-admission-registry:epoch1"
}
```

`controller` may be null, producing visible recovery-required custody. An
optional `generation` asserts the expected existing allocation. The library
entry for host adoption is `acquireExistingWorkspaceClaim`; `createWorkspace`
accepts the same object as `options.claim`. Both check activation. A successful
acquisition receipt is `{version:1,path,generation,claimId,ownerId}`. CLI replies
add `ok:true`; the start reply nests the receipt under `claim`.

`claims release <path>` accepts:

```json
{
  "activationId": "activation receipt ID",
  "requestId": "unique release operation ID",
  "generation": "receipt generation",
  "claimId": "receipt claim ID",
  "credential": "that claim's secret",
  "settlementRef": "t3:evidence-backed-closed-epoch-settlement"
}
```

Success is `{ok:true,version:1,released:true,claimId,generation}`. SlipJay requires
and retains the reference and the credential check; it deliberately cannot
validate the consumer's private business evidence. The settlement publisher must
be trusted to make that attestation only after the required acknowledgements.

`claims transfer <path>` accepts the same fields, where `settlementRef` identifies
an acknowledged handoff, plus `next` containing `ownerId`, a **new** `credential`,
`controller` and `obligationRef`. It atomically ends the old claim and returns a
new acquisition receipt. There is no unprotected gap. Other claims are untouched;
the old credential cannot operate the successor. Recovery rebind uses this same
transfer with explicit handoff evidence, rather than inventing liveness from a
new server PID.

Request IDs are durably bound to operation/input digests. Replays return their
original result without mutating other claims. Different input under one ID
returns `CLAIM_REPLAY_CONFLICT`. An ended acquire cannot be replayed as permission
to begin work again (`CLAIM_ENDED`). Start a fresh epoch with a new owner/request.
Release/transfer compare generation even if a checkout name/path was reused.

`claims recover <path>` accepts `{activationId,requestId,generation,claimId,
credential,reason}`. A bounded non-secret reason such as `adapter-unavailable`
retains explicit recovery-required state even when the controller is alive. This
operation cannot release custody. A credential-authenticated transfer to a new
custodian or evidence-backed settlement is required to end that state.

`claims status <path>` returns `{ok:true,version:1,path,generation,claims,
retirement,reason}`. Each claim shows only `claimId`, public `ownerId`, generation,
`active|recovery-required|released|transferred`, diagnostic reason, controller
identity, obligation and settlement references. It never exposes credential
hashes or release credentials. Sweep/retention plans name retaining callers and
reasons. A malformed authority file reports `CLAIM_STATE_UNREADABLE`; destructive
paths retain it. A missing JJ registration or workspace sidecar is not absence of
custody.

Errors have `{ok:false,code,reason}` and nonzero exit, with no input echo. Relevant
codes include `CLAIM_REQUEST_INVALID`, `CLAIM_UNAUTHORIZED`, `CLAIM_ENDED`,
`CLAIM_OWNER_CONFLICT`, `CLAIM_REPLAY_CONFLICT`, `CLAIM_GENERATION_MISMATCH`,
`CLAIM_GENERATION_CONFLICT`, `CLAIM_CHECKOUT_UNAVAILABLE`, `CLAIM_RETIRING`,
`CLAIM_RETAINED`, `CLAIM_STATE_UNREADABLE`, `CLAIM_CAPABILITY_REQUIRED`,
`CLAIM_ACTIVATION_UNKNOWN`, and `CLAIM_ACTIVATION_DRAIN_REQUIRED`.

## Identity, persistence and interlock

Authority lives in `~/.slipjay/state/custody/<sha256(canonical-path)>.json`, outside
checkout/metadata/JJ sidecars. Realpath aliases converge. Directory identity and
producer allocation transitions establish an immutable random generation;
managed starts of an existing bound/resumed checkout preserve its generation,
while fresh/reused-spare allocations reset it. Old generations and request
receipts remain for replay/custody diagnostics. Atomic rename plus file/directory
fsync precedes a successful claim acknowledgement. These small records are not
subject to workspace sidecar pruning; released receipts are not active holds.

Lock order is existing outer allocation/pool/name-writer locks, then
`writer:canonical:<canonical-path>` as the innermost authority transition. Never
acquire an outer lock while holding the canonical writer. Admission records a
claim under that lock. Destruction checks current claims and persists a
retirement admission fence there **before** preview teardown. Slow teardown,
archiving, dependency movement and deletion do not hold the canonical writer.
Fresh fence validation precedes final forget/destruction. The fence refuses
new acquisition, so a stale scan cannot remove a successfully admitted claim.
The global allocation lock is not held across release archiving/teardown.
Ordinary remove/release/landing cleanup, direct orphan discard, partial-spare
discard and dependency/generated-output eviction share the authority. Content,
process-holder, legacy PID, pending-delivery and recovery guards still apply.

A process crash or uncertain destructive failure leaves its fence inspectably
recovery-required. Public generation and fence identifiers are diagnostics, never
permission to clear that fence. There is no command or public library operation
that accepts a caller's retirement-settlement reference: SlipJay cannot verify
that an interrupted destructive worker and its work have stopped or transferred.
Such unknown teardown remains fenced. Ordinary successful completion clears only
the retiring operation's own fence; known working-copy-changed refusals also clear
it because retirement proved that it kept the checkout. Credential-authenticated
caller-claim settlement and transfer remain available through the protocol above.

Controller matching on Linux uses boot ID plus `/proc` start time and excludes
zombies. Darwin uses `kern.boottime` and `ps lstart` for diagnostics; its timestamp
has coarse resolution. Controller matching is **not** release authorization, so
a collision cannot delete custody. Every unknown or mismatch retains custody
until credential-authenticated, evidence-backed settlement/transfer. There is no
TTL and no claim release based only on a server PID or process death.

## Managed activation and compatibility

The managed entry points (CLI, housekeeping, refill, trash) publish version-1
participation before work and withdraw on completion. The barrier inventories
supported managed executable entry points, checks exact controller identities
against participation records, and refuses any unannounced/unknown worker.
Linux scopes process inventory to the authority HOME; Darwin uses its process
inventory conservatively. New workers participate in the final authority, so
allowing them does not rely on their finishing first. An old worker must finish
naturally; this command never kills it. A consumer checks the activation again
before each acquisition. Inventory/record unreadability is a bounded refusal.

Install the producer first, select that exact producer in every supported managed
launch path, drain the old workers, activate, then enable claim-consuming work.
Capability alone is insufficient. Already-running older workers are precisely
why activation can refuse after installation. No guarantee is made about an
operator subsequently invoking an arbitrary obsolete binary/library outside
those managed launch paths. Such binaries do not know the final authority.

Activation does not install anything, disable housekeeping, change services or
promote a release. Upgrading the producer/consumer requires normal delivery
permissions. No shipped-client field is required; the contract is local CLI or
library on each actual execution host. Linux tests run here; macOS execution,
coupled T3 lifecycle/closed-epoch proof and the installed cross-repository fixture
remain validation for the coupled lead. The required Champion attempt is separate
UX evidence and cannot substitute for the installed ownership fixture passing.
