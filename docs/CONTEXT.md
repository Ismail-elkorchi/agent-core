# Composing persistent context

Applications choose the instructions, provider, tools, repositories, and resource
policy. Core supplies the history, working-state, transition, and inference contracts. None
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
callbacks. Interrupted rebuilds leave original ledgers intact. Search reads bounded original sources; a cursor cannot broaden host-granted scope.

Keep original user contributions in history even after a context transition.
Applications can associate a contribution with a continuation, correction, side
question, or task replacement. Those relationships remain distinct from whether
delivery is immediate, steering, or queued.

## Working state

A session branch owns one current freeform working-state revision. Its protected
text artifact is referenced from the existing session journal alongside the
previous revision and the exact recorded inference input that produced it.
Branching inherits the revision at the selected branch point. Later revisions
on either branch are independent.

Compose `createWorkingStateTool(context)` with history and context tools. The
model supplies the complete replacement text only; the runtime supplies session and branch
scope, invocation attribution, and the revision presented in its inference.
The replacement publishes atomically against that revision. A stale update returns
an explicit conflict with the current state and its history reference. Publication
is conditional and idempotent; a failed append leaves the previous head intact.

Every admitted request binds to the current revision at its captured boundary.
Present the generated interpretation once; do not accumulate historical revisions
in the prompt. State cannot grant authority, establish verification, or replace
original user contributions and observations. It has no mandatory sections or
maintenance schedule. Unchanged understanding requires no update.

`ContextService.inspect()` exposes a bounded preview and an authorized history
reference. Historical reads and searches use `HistoryReader` and disclose their
byte bounds and coverage. There is no independent note repository or browser.

## Context transitions

Compose `createHistoryTools`, `createWorkingStateTool`, and `createContextTools`
with the ordinary tool registry and authorization policy. `ContextService` records
selected original sources and the current working-state revision at an immutable history cut.
Unselected material remains retrievable; no exhaustive omission partition is needed.

Configure `policy.maxSourceBytes` and authorized original-history retrieval on the
service. Byte bounds govern source access. `RequestAdmission` assembles the actual
task, attachments, instructions, dynamic context, working state, tool guides,
catalog and generation settings, then compiles the provider request.
`assertRequestAccountingFits` alone decides fit, including separate reasoning and
output reservations. Counts, estimates, and unknown components stay distinguishable.

`context_transition` schedules a replacement window with an optional source selection. Omitting selection removes optional history while keeping current working state; the tool does not generate a summary. Activation still requires admission.
The runtime binds the operation to its tool invocation, protects active accepted
input and steering, preserves complete protocol exchanges, and schedules admission
at the next lawful request boundary. Provider transforms are explicit governed
invocations; their result must pass next-generation admission before activation.
Idle source selection records intent without pretending to admit a future task.

Core hosts with a context service opt into `contextRenewal: { automatic: true }`;
both applications enable it by default. At context pressure, governed inference
revises working state from the current working context. This uses the same
owner budget, admission policy, and immutable inference records as ordinary work.
State renewal appends an auxiliary task in the user channel to the unchanged
conversation. It preserves authority roles, exact protocol prefixes, and provider
settings, while removing executable tools and the original answer format. This
task belongs only to its inference invocation; it is not recorded as user input.
Capacity stays in request accounting and context inspection; the runtime does not
insert capacity reminders into an established conversation prefix.
Only a complete revision proposal and an admitted replacement can activate a new
window. State and window become current together in one session journal commit.
An unchanged proposal can renew the window without writing a new state revision. Active and protected user input remains exact; model-authored working state is
fallible reference material, never instructions or verification. Originals remain
retrievable. The soft continuity allowance occupies at most half of the available
input capacity, so a large output reservation cannot trigger renewal on every
turn. Failed summarization preserves the preceding window; proactive renewal
failure does not block an ordinary request that still fits.
Irreducible input/catalog/reservation conflicts suspend the owning driver
with actionable context diagnostics. Changing selection or model can resolve a
conflict; retrying an unchanged request cannot. Session, work, accounting and live
resources retain their identities across renewal. `/context` inspects the selection
and compiled capacity; `/renew-context` and RPC `context.renew` submit renewal choices.

## Governed inference

Pass one `InferenceService` to the primary runtime and auxiliary consumers. Supply
an explicit invocation repository and artifact repository for durable auxiliary
work. A common `ownerId` binds primary work, state renewal, and verification to
one resource policy. `invocationId` identifies a particular admitted request;
`purpose` explains its application role without imposing a workflow.

The service persists admission and reservations before dispatch and records the
settled result and usage. Reusing a settled identity replays its result. A request
that crossed its start boundary without a known result remains uncertain rather
than being dispatched again automatically. Cancellation releases the caller while
a late response can still settle its original permit.

Application egress policy is supplied as `InferenceService.admitRequest`. It checks
the exact compiled input before dispatch authority, including context transforms
and native successors. A local admission rejection cannot become an uncertain
provider outcome. Provider wrappers must not hide admission inside transport.

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
bounds instead of fabricated compiled accounting. If the working sources cannot
be materialized or summarized within their bounds, the window remains unchanged;
an explicit source selection or model change is required.

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
original-history retrieval, and native transforms where the
exact adapter and endpoint support them. Unavailable capabilities and unknown
pricing remain visible. No model-policy default follows from a single successful
trial or a smaller prompt.

### Historical measurements

The [archived reports](validation/README.md) describe the earlier notebook
architecture and authored workloads. They do not validate working-state behavior
or establish a model-quality improvement for this implementation. Current
structural tests cover publication, concurrent updates, historical forks,
request attribution, bounded recovery, admission, and provider continuity.

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
