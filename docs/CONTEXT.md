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

## Stored narrative items and admitted views

Session state is branch-owned, attributed, fallible narrative understanding. Each
item has an immutable revision and exact history citations; there is no mandatory
taxonomy or workflow. Runtime-generated item and revision identities come back in
the save receipt. State cannot grant authority, verify a claim, or override user
requirements. Citations support retrieval without automatically retaining sources.

`context_state_save` saves an atomic batch of `create`, `replace`, UTF-8 range
`edit`, or `remove` operations without compiling a request or changing its active
view. Replacements, edits, and removals require `itemId` and
`expectedRevisionId`. A stale touched item rejects the whole batch; unrelated
item updates do not conflict. Idempotency binds the exact batch. Removing a head
does not erase historical revisions or content already delivered to a provider.

For example, the tool input to save an item is:

```json
{"operations":[{"kind":"create","text":"The user requested a concise answer; the original request remains authoritative."}]}
```

Use the returned `itemId` and `revisionId` in `context_state_read` or in a
`context_transition` selection. A reference is `{ itemId, revisionId }`, optionally
with `range: { offset, bytes }`. Byte ranges and edits must use exact UTF-8
boundaries; they are not JavaScript character offsets and are never silently
truncated. `context_state_read` optionally accepts `maxBytes` for the complete JSON
result, including text, identity and citations, up to 1 MiB. This delivery budget
is independent of the configured source-byte read allowance; insufficient output
space refuses with the measured size and never shortens the exact selection. Omission preserves the normal read API.
`context_state_list` defaults to current stored heads; `view: "selected"`
lists the exact active references. Stored metadata includes an optional leading-text
preview of at most 160 UTF-8 bytes, derived during saving; listing never loads bodies.
Both expose bounded, cut-pinned pages. Tool and host page contracts use the same
32 KiB default, 512-byte minimum, 1 MiB maximum, and 16 KiB cursor limit. The full
serialized result, including its continuation cursor, must fit; pages shrink when
possible and otherwise refuse with a measured retry size rather than returning an
empty page at the same cursor.
`context_state_search` performs literal search with separate scan and output
bounds. It returns the first occurrence per item: `range` selects the exact match,
and `excerptRange` selects the returned excerpt, both as UTF-8 `{ offset, bytes }`.
A bounded, disposable index reuses history's substring candidate machinery to skip
known non-candidates; candidate matches are verified against original revision
bytes. Index construction is incremental within each call's scan allowance, retains
no bodies, and is capped at 16 MiB of source bytes and 16,384 revisions. Short queries
may require scanning every body. Partial coverage and oversized unread items are
explicit; a first item larger than the scan allowance refuses with the required size.

`ContextService.saveSessionState(batch)` is the corresponding host save API.
Supply the branch, idempotency key, recorded originating inference, captured
history cut, and operations; an owned attribution validator is required.
`listSessionState`, `readSessionState`, and `searchSessionState` retrieve storage.
`sessionState()` returns only the committed selected view, not all saved heads.
`SessionStateSnapshot` contains `id` and selected `items`; each selected item
carries its exact revision, optional range, text and citations.

Revision metadata points to protected artifact content and records its digest,
size, predecessor, originating inference and history cut. Keep the original
artifact repository across restarts. Forks inherit revisions at their selected
branch point. Independent saves survive a later failed activation.

Storage, materialization and request capacity are distinct bounds in
`ContextPolicy`:

- `committedRetainedStateBytes` defaults to 64 MiB and counts committed retained
  revision metadata and bodies, including superseded and abandoned-fork revisions
- `sessionStateMutationBytes` defaults to 1 MiB per staging attempt
- `sessionStateReadBytes` defaults to 64 KiB per item read
- `maxSourceBytes` bounds selected source material; compiled request accounting
  independently decides whether the actual provider request fits

The retained revision allowance is not an artifact-store disk quota. Failed
staging/admission can leave unreachable content-addressed artifacts; physical
artifact storage policy belongs to the host’s `ArtifactRepository`. No policy
silently truncates saved text or discards stored revisions to make a view fit.

## Context transitions and renewal

`context_transition` activates exact existing item revisions, original sources,
excerpts and public artifacts without saving narrative state. `sessionState` is
an array of exact item references. Omitting it keeps the selection; `[]` selects
no state. Saving a newer revision does not implicitly update selected references.

To require both a save and activation to succeed, use
`context_save_and_activate`. Its `operations` have the same conditional batch
shape as saving; selection fields match `context_transition`. The default
`activateSaved: true` replaces selected references for touched items with new
revisions and removes deleted items from the view. Set it to `false` to preserve
the explicitly supplied selection. For example:

```json
{"reason":"Keep a short working interpretation in view","operations":[{"kind":"create","text":"The comparison is still pending; no result has been verified."}]}
```

The combined transaction publishes the batch and view only after actual successor
admission, or publishes neither. A scheduled receipt is not commitment. In
contrast, ordinary saves need no model request and are never rolled back by a
separate activation failure.

Source selection uses `add`/`release`, or `retain` to replace optional original
history; `recentFrom` selects the active suffix. Explicit `excerpts` and `artifacts`
select bounded evidence. Active accepted input, complete exchanges, and explicit
protections remain protected. Outstanding effect and result-delivery obligations
cannot be discarded to make a request fit.

The runtime chooses the lawful successor from the actual delivered prefix:

- **Unchanged:** the effective view is unchanged and renewal is not required
- **Append:** the selected-state change lawfully extends the frozen delivered
  prefix with an exact attributed view-replacement notice
- **Fresh:** explicit `renewal: true`, source reduction/reorder, an incompatible
  prefix/configuration, or required capacity recovery starts fresh continuation

Older state projections remain superseded interpretation inside a preserved
prefix. Fresh continuation uses the selected revisions and evidence without old
notices; it does not hydrate every stored head. Session identity, authority,
effects, resources, accounting, original history, and unresolved obligations
survive. Native material remains subject to provider compatibility rules and is
never recast as narrative state. No supported admitted successor means rejection.

Hosts call `AgentSession.transitionContext()` with an inspected window/source
revision, `idempotencyKey`, `reason`, and `ContextTransitionRequest.selection`.
That selection contains `retained` and optional `excerpts`, `protected`,
`sessionState` and `artifacts`; persisted `continuity` is runtime-owned and must
not be copied into proposals. Results distinguish `scheduled`, `selected`, and
`unchanged`. Correlated transitioned/unchanged/rejected events settle queued
application actions. Publication is distinct from provider delivery, and an
unchanged result is not evidence of pressure relief. Idle selection intent is
not a published window.

`context_inspect` gives bounded selected-source metadata and references.
`context_runtime_inspect` distinguishes `target: "configured"` from
`target: "last_admitted"`; page capabilities with `offset`, `limit`, and the prior
`expectedRevision`. Current configuration does not prove that a request has been
admitted or dispatched. Inspection exposes allowances and active operations
without granting capabilities or resetting continuing-work budgets.

## Admission and recovery

Applications set source byte bounds and explicit output reservations. Admission
compiles the actual task, attachments, instructions, the selected state view, selected
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
admitted fresh request containing a bounded optional state view and required evidence,
without superseded notices. Unavailable measurements do not establish exhaustion.

Recovery can inspect metadata, retrieve history, save useful item updates, and
activate a bounded view. Saved state is optional request material: recovery may
select fewer items, exact ranges, or no items without deleting durable state. It
cannot execute domain effects or answer the user.
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

Execution and session formats are versioned. The item-state contract uses
`agent-core.session/6`. This build cannot open, resume, or read historical content
from earlier session formats. It rejects unsupported execution records and
incompatible session headers without rewriting original journals. Reading those
originals requires the matching earlier build; this build performs no conversion. It has no aliases, old-format readers, migrations, or
automatic deletion. Structural tests establish publication, persistence, forks,
source attribution, admission, and protocol boundaries. Continuation strategy,
provider cache usage, and retained information are separate measurements. They do not establish a
model-quality improvement; empirical claims require identified models, workloads,
resource limits, and comparable live trials.

## Host control and output-reservation policy

`AgentRuntimeOptions.contextControlPolicy` overrides the finite defaults in
`DEFAULT_CONTEXT_CONTROL_POLICY`. `parseContextControlPolicy` captures and validates
all attempt, tool-call, inventory, history-read and presentation bounds. The effective
policy is inspectable. `reserveMode: 'required'` preserves recovery headroom as an
admission requirement; `'advisory'` reports measured pressure without rejecting a
request solely for that reserve. Hard compiled capacity remains mandatory in either
mode. Durable attempt accounting is scoped to an unchanged recovery boundary and
survives restart; changing this policy does not reset consumed owner/run budgets.

Control eligibility is an explicit trusted-host grant:
`grantContextControlTool(definition, 'read' | 'state' | 'activation')`. It binds the
exact compiled definition, not its name, implementation identifier or description.
The built-in context/history factories grant their own definitions. Read grants
require a read-only context/history/session-state effect envelope. All granted calls
still pass normal canonicalization, call-specific effect authorization, execution,
and durable reconciliation. Recovery cannot execute domain work or turn arbitrary
model text into a final task answer.

An optional `outputReservationPolicy: { minimum, maximum }` authorizes model-selected
output reservations within that host range, with `maximum <= maxOutputTokens`.
When the host opts into a range and no window choice exists, its maximum is the initial reservation; `maxOutputTokens` remains the configured ceiling. Without a range, the configured output allowance is fixed. A context transition can
propose `outputReservation`; omitted values inherit the current window's choice.
This is a window-scoped allowance for ordinary requests, not a one-shot hint and not
a change to the continuing owner's token budget. Core compiles and admits the exact
proposed reservation before publishing it with the window. Rejection leaves the
prior window unchanged. Current host bounds are checked again on use and restart.
`reduce_reservation` is advertised only when a legal lower choice is authorized.

### Operational inspection

`ContextService.inspect()` exposes one `operational` view shared by active runtimes
and idle application sessions. `configured` pages describe prospective eligibility;
`last_admitted` pages describe the exact captured catalog of the admitted request.
Pagination is revision-bound, defaults to 32 items, and permits at most 128 items.
`maxBytes` bounds the complete operational projection (32 KiB by default, at most
256 KiB), including fixed metadata. The page shrinks without skipping capabilities;
an indivisible minimum page reports measured required bytes and an actionable retry.
The same operational-page parameters are accepted by RPC `context.read`; its other
context fields are outside this operational projection bound.
Applications do not publish a second capability or generation projection.

Context admission and invocation lifecycle are separate evidence. A live context
admission can have no invocation yet. Restart inspection reads the latest durable
invocation and protected request artifact through the existing inference owner
index; it does not invent a separate admission journal. `admissionEvidence` labels
these boundaries. Invocation status and dispatch evidence do not claim dispatch
merely because the durable invocation-start boundary was crossed. Generic inference
without a captured runtime catalog reports `catalog_not_recorded` explicitly.

The continuing inference owner allowance survives runs and reopening. Omitting its
configuration reuses the recorded owner limits; supplying different limits fails
explicitly. This allowance is independent of run limits, per-request generation
reservation, and the bounded context-control policy. Inspection distinguishes the
configured generation reservation, the active window reservation, and host-authorized
reservation range (or fixed reservation).

Context byte policy resolves defaults once. Inspection reports source, mutation,
read, and committed-retained limits plus retained bytes used and remaining. Retained
usage includes committed historical revisions, forked revisions, and their metadata;
it is not physical artifact-store disk use. Deleted live items do not erase retained
history accounting.
