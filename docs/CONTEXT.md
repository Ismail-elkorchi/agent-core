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
Snapshots share incremental ancestry indexes and capture immutable boundaries;
ordinary appends do not rebuild a full ancestor array or source lookup maps.

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
unindexed access is not constant cost. `JsonlEventRepository.rebuild()` and
`JsonlSessionRepository.rebuildHistoryIndex()` accept cancellation and progress
callbacks. Interrupted rebuilds leave original ledgers intact. Search incrementally builds an in-memory substring index of hashed trigrams and
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

Working state is a request suffix. Adding conversation before that suffix changes
the preceding wire input even when the state text is unchanged. Providers that
require an exact append-only prefix for incremental continuation use full replay
in that case. Incremental transport reuse and provider-reported prompt cache usage
are separate facts; shared prefixes alone do not establish cache hits.

Ordinary provider reasoning retains its recorded conversation position; its presence
does not move application references. Provider-transformed windows are distinct:
their admitted input precedes current references, including after reopening. A
provider's required reasoning prefix is a protocol constraint, not an incremental
transport optimization. Full replay cannot repair an edited or reordered required
prefix; such an input is rejected rather than discarding signed reasoning.
Binding is model-specific: immutable signed blocks do not universally bind earlier
messages. Prefix-bound records also bind the declared catalog. Changed working
state, references or authority cannot be replayed under a different bound prefix;
unsupported combinations fail explicitly. Fresh continuation is an explicit
native reset using portable original contributions, with working state carried
separately rather than selected as another conversational source.

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

`context_transition` edits the selected original sources. `add` and `release`
change the current selection; `retain` replaces optional history. Omitting these
fields keeps the current sources. An empty `retain` explicitly releases optional
history. Releasing or retaining part of a response selects the whole exchange,
including its parallel calls and observations. Bound native responses retain their
prefix dependencies. Active accepted input and explicit protection remain mandatory.

The operation may also supply `workingState`, using the same full-text replacement
as `update_working_state`. The runtime binds it to the revision presented in the
originating inference. Staged content and the new window publish together only
after ordinary request admission, with no implicit rebase of stale state. Without
a state change, source selection requires no auxiliary generation. Source changes
take effect at a settled tool boundary, including the transition's own exchange.

`continuation: 'fresh'` explicitly starts new model reasoning over the selected
originals in the same session. It preserves working state, authority, accounting,
effects and resource lifetimes. Native reasoning remains in original storage but
is not replayed. Idle applications can call `AgentSession.freshContinuation({profile})`;
model switching shares that path. Outstanding effects and deliveries must be
resolved first. The TUI context controls and RPC `context.fresh` expose this choice.
It is never an automatic response to incompatible native state.

There is no automatic portable summarization or oldest-source eviction. The model
chooses relevant sources and updates understanding when useful. History is the
recoverable original; working state is generated interpretation, not evidence.
`context_inspect` exposes the live selection, including the tail after the last
committed window. Its source manifest uses bounded `limit`/`maxBytes` pages and a
cursor pinned to the captured branch and ledger heads. Each item carries an exact
source reference, a short description, stored byte size, and its whole-exchange
group, including prefix binding and protected or unfinished dependencies. These
byte sizes do not promise compiled token savings. An unavailable selection exposes
its source-capacity conflict rather than reporting an empty window. Inspection
labels the last compiled admission by input identity, separately from the live cut.

Near compiled continuity capacity or 80% of selected-source bounds, the runtime
adds factual capacity feedback at the end of the request. It reuses unchanged
status, counts and admits the request including the notice, and preserves native
prefixes. Feedback distinguishes source-read bounds and compiled reservations
from settled usage and owner allowances. It does not demand working-state upkeep
or trigger compaction. Optional notice preparation cannot block an already valid
ordinary request; cancellation still stops dispatch. A single large new input or
result can still cross a bound before the model gets another decision point.
Providers without native compaction use source selection or an explicit fresh
continuation. These are structural guarantees; long-session task quality and the
usefulness of pressure feedback still need controlled live evaluation of this
source-selection policy, not the superseded automatic-summary policy.

Hosts may enable `contextRenewal: { automatic: true }` for native fallback; both
applications do. Only a declared, governed native operation can resolve a rejected
request or a required bound-prefix configuration change. Fitting ordinary requests
do not trigger compaction. `strategy: 'provider'` explicitly requests native
compaction at a legal boundary. The transform itself and its successor must pass
admission. A source already too large for the transform still requires selection,
a different reservation, or another model. Failure preserves the old window and
records the reason; settled usage and unresolved exposure stay with their owner.

Session identity and resources survive every context transition. `/context`
inspects capacity and selected sources. `/renew-context` and `context.renew` release
optional sources or submit an explicit selection; they do not summarize the archive.
Retrying an unchanged, rejected request cannot resolve an admission conflict.

## Governed inference

Pass one `InferenceService` to the primary runtime and auxiliary consumers. Supply
an explicit invocation repository and artifact repository for durable auxiliary
work. A common `ownerId` binds primary work, native transforms, and verification to
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
