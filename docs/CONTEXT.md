# Composing persistent context

Applications choose the instructions, provider, tools, repositories, and resource
policy. Core supplies the history, note, transition, and inference contracts. None
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
before unrelated bodies are decoded; `maxBytes` separately bounds returned text.
An oversized source stays identifiable in `unavailable` and can be requested with
a larger source allowance. Later appends cannot enter an existing cursor.

For request assembly, `selectedContext(cut)` reads only the selected window record;
`page({cut, after, cursor, limit, maxBytes})` and `entriesAfter(after, through, bounds)`
enumerate bounded original sources. Follow the cursor and check `unavailable`
before claiming complete coverage. There is no full-view gateway or exhaustive
omission list. Session repositories expose `sourceSnapshot()` for cached branch
membership, source digests, sizes and finalization pointers without source bodies.

`EventRepository.readReference()` verifies a committed event's run, sequence, ID
and digest. `readRange()` scans strictly after `afterSequence`, through a pinned
sequence/hash, with record and byte limits applied before domain decoding. Its
`nextSequence` is the last scanned sequence, suitable for the next request's
`afterSequence`; `oversized` leaves that record unconsumed. Type filters use derived
metadata. `latestReferenceOfType()` and `referenceByKey()` return exact pointers
without decoding their payloads. Both memory and JSONL repositories have the same
query and conflict semantics. Tool history joins original results and recorded
model content through the existing idempotency index, at the selected cut.

JSONL uses rebuildable sequence offsets alongside its existing tail/type indexes.
Warm append refresh reads only newly committed records, and caches at most 128
run-tail indexes. No history cache retains completed run bodies. Cold construction
and explicit integrity verification still scan authoritative storage; first-ever
unindexed access is not constant cost. `JsonlEventRepository.rebuild()` and
`JsonlSessionRepository.rebuildHistoryIndex()` accept cancellation and progress
callbacks. Interrupted rebuilds leave original ledgers intact. The bounded lexical
index is optional and rebuildable; a cursor cannot broaden host-granted scope.

Keep original user contributions in history even after a context transition.
Applications can associate a contribution with a continuation, correction, side
question, or task replacement. Those relationships remain distinct from whether
delivery is immediate, steering, or queued.

## Notes

Use `InMemoryNoteRepository`, `EventNoteRepository`, or the explicitly located
`JsonlNoteRepository` from `@agent-core/runtime/node`. Bind a note scope to a session
and branch. A write names its expected revision, idempotency key, author, and
invocation. A conflicting revision produces a conflict instead of overwriting a
concurrent edit. A retry must identify the same operation and content.

Notes accept plain text, Markdown, and JSON. Read results identify the exact
revision delivered. Forks inherit a pinned revision boundary; later parent edits
do not silently change a child branch. Quotas include staged storage so failed or
contending writes cannot evade resource limits.

Note repositories index committed revisions, reservations and branch inheritance
incrementally from the last sequence/hash. A mutation preserves earlier index
work; exact revision reads never replay the note log. Lists and searches pin a
watermark, and deletions leave earlier selected revisions readable with their
original authorship. `maxScannedBytes` limits search content reads independently
of returned bytes; inaccessible or oversized sources produce explicit coverage
limits. Metadata indexes obey `maxIndexBytes` (32 MiB by default) and storage
quotas, with at most four session indexes cached. `rebuildIndex()` is an explicit
cancellable scan with progress, available on `EventNoteRepository` and its memory
and JSONL implementations.

`createNotesTools` exposes a host-bound repository scope. Storing a note does not
automatically add it to a prompt. Selected note revisions remain attributed model
data and cannot grant tool permissions or change application acceptance state.
For deliberate sharing, the application can grant a separately named tool bound
to another scope and restrict its allowed operations through the tool policy.
The model cannot obtain that grant by supplying another session or branch ID.

## Context transitions

Compose `createHistoryTools`, optional `createNotesTools`, and `createContextTools`
with the ordinary tool registry and authorization policy. `ContextService` records
selected original sources and exact note revisions at an immutable history cut.
Unselected material remains retrievable; no exhaustive omission partition is needed.

Configure `policy.maxSourceBytes` and authorized original-history retrieval on the
service. Byte bounds govern source access. `RequestAdmission` assembles the actual
task, attachments, instructions, dynamic context, selected notes, tool guides,
catalog and generation settings, then compiles the provider request.
`assertRequestAccountingFits` alone decides fit, including separate reasoning and
output reservations. Counts, estimates, and unknown components stay distinguishable.

`context_transition` requests a fresh window with an optional source/note selection.
The runtime binds the operation to its tool invocation, protects active accepted
input and steering, preserves complete protocol exchanges, and schedules admission
at the next lawful request boundary. Provider transforms are explicit governed
invocations; their result must pass next-generation admission before activation.
Idle source selection records intent without pretending to admit a future task.

Core hosts opt into `contextRenewal: { automatic: true }`; both applications enable
it by default. One bounded fallback candidate retains active and protected input
and may omit optional conversation and notes. It creates no summary and requires
no note. Irreducible input/catalog/reservation conflicts suspend the owning driver
with actionable context diagnostics. Changing selection or model can resolve a
conflict; retrying an unchanged request cannot. Session, work, accounting and live
resources retain their identities across renewal. `/context` inspects the selection
and compiled capacity; `/renew-context` and RPC `context.renew` submit renewal choices.

## Governed inference

Pass one `InferenceService` to the primary runtime and auxiliary consumers. Supply
an explicit invocation repository and artifact repository for durable auxiliary
work. A common `ownerId` binds primary work, note generation, and verification to
one resource policy. `invocationId` identifies a particular admitted request;
`purpose` explains its application role without imposing a workflow.

The service persists admission and reservations before dispatch and records the
settled result and usage. Reusing a settled identity replays its result. A request
that crossed its start boundary without a known result remains uncertain rather
than being dispatched again automatically. Cancellation releases the caller while
a late response can still settle its original permit.

Adapters compile immutable input before admission. Accounting covers the compiled
body, actual tool arguments and results, schemas, media, and protocol state. Exact
counts, estimates, and unknown components remain distinct. Configure an explicit
output allowance for every invocation (`AgentRuntime.maxOutputTokens`, or the
inference request's cap / explicit `outputReservation`). Core has no generation
allowance default and does not infer unknown provider output capacity. Endpoints
that reject a cap still reserve the host allowance and settle actual usage.

Selected sources are membership: admission and replay restore branch input order
and each run's event sequence. Source byte/entry capacity conflicts suspend at the
same admission boundary as compiled token conflicts, with source references and
bounds instead of fabricated compiled accounting. Authorized automatic renewal
can select a smaller window while retaining accepted inputs and native obligations.

Inference repositories advance from verified ledger tails. `load(ownerId)` returns
committed liabilities and settled totals; optional `invocationId` and `runId` queries
retrieve one invocation or per-run totals. `settledRunUsage()` replaces cumulative
charge arrays. Provider settlements use exact event references and idempotency keys;
ordinary admission and accounting do not replay historical settlement bodies.

## Independent provider and tool work

The run driver retains provider requests and original tool groups in one state.
Each call keeps its source response, advertised catalog and effect permit. The
same per-call executor handles ordinary requests and native continuations; results
can be recorded out of order while another response streams. Conflicting effects
and explicit dependencies still gate execution and approval.

For native Responses execution, configure the supported WebSocket transport and
pass an `InferenceService` with explicit invocation and artifact repositories.
Every generation is admitted before its causative frame is sent. Steering plus a
required tool result can extend one successor reservation; it does not create two
billable invocation identities. Response boundaries settle individual usage;
stream closure is not an additional generation.

Result delivery has its own durable admission, transmission and application
receipts. A late result keeps its original catalog binding even after a catalog
update. An acknowledged or uncertain delivery cannot be sent again without
provider evidence that it failed. Closing a connection does not erase known tool
results or grant a fresh effect permit.

## Policy measurements

`scripts/evaluate-context-policies.mjs` provides dry, capability, simulation, and
explicit live modes. Run `node scripts/evaluate-context-policies.mjs --help` for
the supported options. Reports pin the workload, model, endpoint, resource limits,
sample count, and predeclared quality gates.

Simulation proves the composition can execute and account for each policy. It
does not estimate real model recall quality. Live trials compare retained input,
original-history retrieval, notes with retrieval, and native transforms where the
exact adapter and endpoint support them. Unavailable capabilities and unknown
pricing remain visible. No model-policy default follows from a single successful
trial or a smaller prompt.

### Recorded release measurements: 2026-09-08

Core's `npm run verify:release` passed its clean build, lint, 511 unit/fault tests,
179 focused recovery/provider tests, and packed consumers under both settings of
`exactOptionalPropertyTypes`. The long-session suite completes 1,000 real runtime
inputs and verifies original requirements and later corrections across context
transitions. Native execution fixtures run the actual runtime and WebSocket
adapter against controlled protocol streams.

The [simulation report](validation/policy-simulation-2026-09-08.json) contains
16 completed trials: four policies, two delayed-recall workloads, and two
deterministic repetitions per combination. All 424 invocations settled. The
32 recall checkpoints passed; observed input loss, unauthorized scope expansion,
orphan results and duplicate settlements were zero. The run exercised 60 context
transitions, 20 governed note writes, 16 history retrievals and 20 native
transforms. Notes were delivered 76 times through context selection; explicit
note-read tool calls were zero. Native state was delivered 76 times.

These numbers establish integration behavior on authored fixtures. Token usage
includes estimates, pricing is unknown, and the repeated trials do not measure
stochastic model quality. The report records the original source commit with a
dirty working tree and the runner/workload digests because it was generated
before the coordinated implementation commit.

The [live availability report](validation/policy-live-availability-2026-09-08.json)
records zero generations. The configured Codex subscription alias had no pinned
deployment version, so the runner refused to treat it as a reproducible quality
trial. The adapter also declares no native transform for that endpoint. Other
live provider accounts were not configured. No model-specific policy default is
promoted: retained history remains the baseline, and notes/retrieval/native
transitions are explicit composition choices.

The predeclared quality gates require at least ten trials per comparison, at
most a five-percentage-point success regression within the reported uncertainty,
and a known-cost ratio no greater than 1.25. Simulation cannot pass those gates.
Reproduce the mechanical comparison after building Core with:

```sh
node scripts/evaluate-context-policies.mjs --mode simulation --output /tmp/context-policy-report.json
```

The output path must be new. Use the runner's explicit live options with an
identified deployment and resource limits to collect empirical evidence.

## Breaking state formats

This pre-alpha cutover rejects incompatible persisted state explicitly. Starting
a new session is separate from deleting old records. There are no migration
readers, compaction callback aliases, or automatic directory cleanup.
