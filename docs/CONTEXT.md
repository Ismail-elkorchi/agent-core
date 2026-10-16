# Composing persistent context

Applications choose the instructions, provider, tools, repositories, and resource
policy. Core supplies the history, session-state, transition, and inference contracts. None
of these services requires a workspace, a document, a planner, or a verification
pass. The minimal compositions in `tests/context-neutrality.test.js` exercise
conversation, structured classification, and read-only monitoring.

## Original history and selected attention

Construct `HistoryReader` with the session repository and descriptor. Supply the
run event and artifact repositories to include authoritative output that committed
before its session copy. Session copies and run events resolve to one source
identity; committed partial output remains distinguishable from completed output.

`capture()` reads committed branch metadata and independent open-run heads; it
never loads transcript bodies. `resolve(source, cut)` validates an exact source's
identity and branch membership. `read()` returns its bounded UTF-8 range, requested
neighbors, and explicit unavailable/oversized results. `search()` binds its cursor
to the branch, cut, query and filters. `maxScanned` and `maxScannedBytes` bound work
before unrelated bodies are decoded; `maxBytes` bounds the complete search presentation, including source references, coverage, and cursors.
A source not inspected within the scan allowance stays identifiable in `unread` with the limiting reason and can be requested with
a larger source allowance. Later appends cannot enter an existing cursor.

For request assembly, `selectedContext(cut)` reads only the selected window record;
`page({cut, after, cursor, limit, maxBytes})` and `entriesAfter(after, through, bounds)`
enumerate bounded original sources. Follow the cursor and check `unread`
before claiming complete coverage. There is no full-view gateway or exhaustive
omission list. Session repositories expose `sourceSnapshot()` as a lazy, asynchronous view of branch
membership, source digests, sizes and finalization pointers without source bodies.
Point lookups and indexed ancestry navigation preserve immutable boundaries;
ordinary appends do not rebuild a full ancestor array or source lookup maps.
Terminal confirmation records bind the owning ledger’s committed finalization to
the session. Cold capture does not revisit confirmed completed runs; its separate
open-ledger capture cost depends on genuinely outstanding runs. A failed confirmation
delivery preserves terminal truth and is retried during normal access.

`EventRepository.readReference()` verifies a committed event's run, sequence, ID
and digest. `readRange()` scans strictly after `afterSequence`, through a pinned
sequence/hash, with record and byte limits applied before domain decoding. Its
`nextSequence` is the last scanned sequence, suitable for the next request's
`afterSequence`; `oversized` leaves that record unconsumed. Type filters use derived
metadata. Domain event codecs provide small routing facts (for example, a tool name);
time and routing filters run before inline payload byte admission, just as session
branch metadata filters do. Relevant oversized originals retain exact unread references.
`latestReferenceOfType()` and `referenceByKey()` return exact pointers
without decoding their payloads. Both memory and JSONL repositories have the same
query and conflict semantics. Tool history joins original results and recorded
model content through the existing idempotency index, at the selected cut.

JSONL uses rebuildable sequence offsets alongside its existing tail/type indexes.
Warm append refresh reads only newly committed records, and caches at most 128
run-tail indexes. No history cache retains completed run bodies. Cold construction
and explicit integrity verification still scan authoritative storage; first-ever
unindexed access is not constant cost. `JsonlEventRepository.rebuild()` accepts cancellation and progress callbacks, as does
`JsonlSessionRepository.rebuildHistoryIndex(sessionId, expectedBinding, options)`. Session repair validates the original header against the requested identity and
workspace binding under the source lock, without requiring session activation or a model provider. Interrupted rebuilds leave original ledgers intact. Search incrementally builds an in-memory substring index of hashed trigrams and
source identities, not retained source text. Warm queries verify matching candidates
against authoritative originals. New cuts extend or replace only the affected tail;
forks and unavailable sources cannot reuse unauthorized candidates. Cold readers
rebuild within the requested scan allowance, including after cursor restart.
Queries support source, run, tool, resource and inclusive `afterTime`/exclusive
`beforeTime` filters. Index coverage and unread sources remain explicit. This is
literal retrieval, not semantic ranking. A cursor cannot broaden host-granted scope.

Keep original user contributions in history even after a context transition.
Applications can associate a contribution with a continuation, correction, side
question, or task replacement. Those relationships remain distinct from whether
delivery is immediate, steering, or queued.

## Session state

A branch owns one current `SessionStateSnapshot`: revision metadata and one structured
`content` body. Revision metadata contains attribution, content digest, and byte size;
it never duplicates that body. The optional `interaction`, `understanding`, `working`, and `trajectory`
sections contain stable-ID items with `id`, `text`, optional exact history `sources`,
and optional natural-language `status` and `scope`. No section, domain ontology,
workflow, or update schedule is mandatory. Freeform working notes belong in item
text. `decodeSessionStateContent` establishes an owned immutable value;
`sessionStateContentSchema` exposes the same bounded contract.

The model sends a complete replacement through `context_transition.sessionState`.
Keep IDs when revising the same item; remove obsolete claims and omit unnecessary
sections. Omitted content leaves the current interpretation unchanged; empty content
clears it. Identical content preserves revision identity. Clearing state does not
erase original history or older state already delivered to a provider. State is fallible interpretation, never authority, verification, or a
replacement for original user requirements and observations.

Runtime provenance is separate from model content: the revision records its
previous revision, exact originating inference request, captured history cut, and
an optional validated declared cut. Citations must resolve at the captured cut.
The existing journal entry owns the exact structured snapshot, avoiding separate
staging artifacts. Protected inference artifacts retain request attribution. The
`context_transition` entry publishes state and selection atomically only after
admission of the actual next request. A scheduled tool receipt is not publication.
Rejected, stale, or oversized proposals leave the previous state intact; retries
are idempotent. Forks inherit state at the selected historical point.

`ContextService.sessionState()` reads the authoritative current snapshot without
replaying the archive. `inspect()` supplies bounded content or a partial preview
plus an exact history reference. Within a supported session format, historical
revisions stay retrievable through original history.

Within a provider continuation, the initial checkpoint-state presentation is frozen.
An admitted state update appends an attributed complete replacement notice,
identifying its previous and successor revisions. An empty replacement is explicit.
The exact notice role, bytes, identity, and position are persisted for replay;
restart and fork preserve the applicable branch ancestry. Earlier state can remain
visible as explicitly superseded interpretation until renewal. Neither checkpoint
nor replacement notice becomes system/developer authority or overwrites execution
facts. A fresh continuation starts from the latest state without older notices.

## Context transitions and renewal

One `context_transition` operation proposes state and source changes. The runtime
chooses the lawful successor from the actual delivered request and provider
capabilities:

- **Unchanged:** effective state and ordered evidence selection are unchanged,
  with no required or requested renewal. No state revision, notice, or window is
  published, and the tool exchange still completes normally
- **Append:** a source-preserving state replacement lawfully extends the exact
  delivered prefix with its notice, preserving provider continuation
- **Fresh:** explicit renewal, source reduction or reorder, incompatible
  configuration/prefix, or required capacity recovery needs a fresh continuation

Use `renewal: true` only when deliberately requesting fresh context, including
renewal with unchanged state. Callers do not select append or provide reset IDs,
model bindings, or provider-prefix bookkeeping. If no admitted lawful successor is
supported, the transition fails without publishing state. Session identity,
authority, effects, resources, accounting, and unresolved delivery obligations
survive either committed strategy. Fresh continuation retains portable selected
originals; signed or opaque native material stays in original storage and is not
recast as ordinary state. Model changes preserve only compatible provider state.

`context_transition` accepts `add` and `release` edits, or `retain` as a complete
replacement of optional history. `recentFrom` selects the active suffix from an
exact source. Omitting source edits keeps the selection; empty `retain` releases
optional history. Complete exchanges, active accepted input, and explicit protections
remain protected. Citations in every state section are exact retrieval references,
not automatic retention. Use source-selection operations to retain or release
originals independently of how the state is organized.

State replacement may accompany source changes. Both are bound to the originating
inference revision and the authoritative source cut, with no implicit stale-state
rebase. Finish the transition tool's exchange before compiling the successor.
Outstanding effect and result-delivery obligations cannot be dropped to make a
request fit. Hosts use `transitionContext` at the inspected window and source
revision. Their `ContextTransitionRequest.selection` contains only evidence:
`retained`, optional `excerpts`, and optional `protected` sources. Do not copy the
persisted window's runtime-owned `continuity` into a proposal. For example, reuse
`inspection.activeSelection.selection` when its status is `available`, with
`expectedWindowId`, `expectedSourceRevision`, `idempotencyKey`, and `reason` from
the inspected operation; add `renewal: true` only for deliberate renewal.

`AgentSession.transitionContext()` returns `kind: 'scheduled'` for queued work,
`kind: 'selected'` with the committed entry, or `kind: 'unchanged'` with a nullable
window ID. Scheduling is not commitment. Committed transition records expose the
selected `strategy`, `cause`, and optional `requestedRenewal` separately. The
correlated `context.transitioned`, `context.transition.unchanged`, or
`context.transition.rejected` event settles a pending application action. An
unchanged result is not evidence of pressure relief. Durable publication also is
not proof of provider delivery; existing invocation and delivery receipts remain
authoritative.

The TUI has one advanced Apply selection action while a request is running; it
does not force renewal. Idle history remains inspectable without publishing an
unadmitted window.

`context_inspect` exposes bounded source metadata and exact references. Follow its
cursor to inspect more of the captured selection. Original-history inspection,
search, and reads retain exact branch/cut boundaries, attribution, byte bounds,
and explicit partial coverage. Stored byte counts do not promise compiled token
savings. Do not infer complete coverage from a single page or an unread source.

## Admission and recovery

Applications set source byte bounds and explicit output reservations. Admission
compiles the actual task, attachments, instructions, session state, selected
originals, the frozen checkpoint and all active replacement notices, tools, media,
and protocol requirements. Exact counts, estimates, and
unknown components remain distinguishable. Only the compiled request's accounting
determines fit; failed preparation or admission never publishes a candidate.

With `contextRenewal: { automatic: true }` and context tools available, bounded
recovery uses the same inference service, owner budgets, authorization, and
transition path. Continuity room is derived from compilation of the bounded
control request and the retained ordinary generation reservation. Input-only and
combined context limits are checked independently; separately accounted reasoning
is included once. An explicit ordinary output reservation is never silently
reduced. Estimated growth remains an estimate: newly accepted input, provider
protocol material, and actual tool presentations still require admission.

Completed ordinary tool batches settle their effects before selecting model
presentations. The runtime admits the complete batch's checkpoint candidate,
reducing derived presentations through artifact-backed excerpts when necessary.
Original observations remain unchanged, and the published presentation is reused
on retry. If required metadata, images, or preserved protocol obligations cannot
fit, the run suspends with its settlements intact. Native in-inference tool
delivery retains its provider protocol boundary and is not treated as a completed
ordinary batch.

Appended replacements consume capacity. They are never rewritten or deleted
inside a preserved prefix. When actual reduction is required, recovery uses an
admitted fresh request containing the latest state and required evidence,
without superseded notices. Unavailable measurements do not establish exhaustion.

Recovery can inspect metadata, retrieve history, and request fresh context through
the same transition operation. It cannot execute domain effects or answer the user.
Its control requests and original results remain recorded. Repeated unchanged
attempts and exhausted allowances produce durable, explicit suspension rather
than resetting limits. Tool-result presentation bounds never alter authoritative
observations or call/result pairing.

No automatic summary, provider compaction, alternate transform engine, or
oldest-source eviction runs between turns. A mandatory result that cannot fit
remains an outstanding delivery obligation and a clear admission conflict.
Cancellation may be necessary when no lawful continuation fits.

## Governed inference

Share one `InferenceService` across primary work and authorized auxiliary consumers,
with explicit invocation and artifact repositories. `ownerId` binds accounting;
`invocationId` identifies an admitted request. Persist admission and reservations
before dispatch and settle usage against that identity. Reusing a settled identity
replays its result. An invocation that may have started but lacks a known outcome
requires reconciliation, not automatic redispatch. Cancellation does not erase
late settlement or uncertain exposure.

`InferenceService.admitRequest` checks the exact immutable compiled input before
transport. Every native successor is independently admitted. Result delivery has
separate durable admission, transmission, and application receipts; an uncertain
or acknowledged delivery cannot be resent without evidence that it failed.

## Compatibility and evidence

Execution and state-sequence formats are versioned. The continuation contract uses
`agent-core.session/3`. This build cannot open, resume, or read historical content
from earlier session formats. It rejects unsupported execution records and
incompatible session headers without rewriting original journals. Reading those
originals requires the matching earlier build; this build performs no conversion. It has no aliases, old-format readers, migrations, or
automatic deletion. Structural tests establish publication, persistence, forks,
source attribution, admission, and protocol boundaries. Continuation strategy,
provider cache usage, and retained information are separate measurements. They do not establish a
model-quality improvement; empirical claims require identified models, workloads,
resource limits, and comparable live trials.
