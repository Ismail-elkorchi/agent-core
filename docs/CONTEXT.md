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

## Working state

A session branch owns one current freeform working-state revision. Its protected
text artifact is referenced from the existing session journal alongside the
previous revision and the exact recorded inference input that produced it.
Branching inherits the revision at the selected branch point. Later revisions
on either branch are independent.

Compose `context.toolDefinitions()` with history tools. The model supplies
complete replacement text through `context_transition.workingState`; the runtime
binds scope, attribution, and the revision presented in its inference. The tool
receipt means scheduled. After completing the exchange, the runtime admits the
actual next request and atomically publishes state and selection. A rejected or
stale proposal preserves the previous revision and produces explicit feedback.
Publication is conditional and idempotent; a lost receipt does not duplicate it.

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

Compose `createHistoryTools` and `context.toolDefinitions()`
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

The operation may supply `workingState` alone or with source edits as the complete
replacement text. The runtime binds it to the revision presented in the
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
source reference, a short description, stored byte size, and its exchange identity.
Routing metadata is read before original bodies, so source overflow does not prevent
inspection. Pages have no global source count: discovering a page does not enumerate
the complete selection. Group facts disclose known prefix binding, protection and
unfinished calls; `requires_validation` means release must still validate the complete
dependency closure at the transition boundary. An oversized exchange can leave prefix
binding `unknown`; inspection never declares that release safe. Stored bytes do not
promise compiled token savings. Inspection labels the last compiled admission by input
identity, separately from the live cut.

With automatic recovery and an available context-transition tool, admission reserves
continuity room from compilation of the current bounded context-management request,
including its actual tool schemas, metadata presentation, output reservation, and
independently charged reasoning. This can trigger recovery before ordinary overflow.
The same check applies before committing a selected successor. It is not a guarantee
about unknown future contributions: each actual request is compiled and admitted again.
Mandatory native result delivery admits its exact compiled capacity and may consume
discretionary continuity room. Pending synchronous results must be delivered before
a context transition is legal; the next discretionary boundary enforces the reserve
again. This does not grant permission to exceed actual request capacity.

Near capacity, factual feedback can still be added when its exact candidate preserves
admission. Unchanged facts are reused; this is not a periodic summary instruction.

Recovery is a restricted turn of the same runtime and inference owner, using ordinary
tool canonicalization, authorization, durable execution, and usage settlement. Its
catalog contains context inspection, bounded history reads, and explicit context
transitions. It cannot execute domain tools, answer the user, replace working state,
or implicitly reset native reasoning. Four durable requests per run, at most 1,024
reserved output tokens per request, two tool calls per response, and 8 KiB read results
bound the control work. Unchanged actions stop across restart; a new source window or
compiled-input boundary is distinguished from an unchanged retry. Last control results
are bounded, labeled presentations of recorded originals, not new authority.

Automatic-context tool results use an explicit 8 KiB text presentation bound with a
partial-coverage marker and a persisted full-presentation reference. Original observation
values and coverage are unchanged, and complete call/result pairing remains intact.
Independent recovery exchanges are preserved in original history but excluded from
ordinary replay before their bodies are read. Source overflow can therefore reach
metadata inspection without hydrating the overflowing original.

An impossible protected input, denied operation, unsupported native transition, exhausted
recovery allowance, or inadmissible successor leaves a durable context-admission
suspension. Abort, ownership loss, and budget exhaustion retain their own semantics.
Native compaction still requires the existing capability and permission; no automatic
fresh-prefix reset is introduced.

Hosts may enable `contextRenewal: { automatic: true }` for bounded recovery and
native fallback; both applications do. Only a declared, governed native operation can resolve a rejected
request or a required bound-prefix configuration change. Fitting ordinary requests
do not trigger compaction. `strategy: 'provider'` explicitly requests native
compaction at a legal boundary. The transform itself and its successor must pass
admission. A source already too large for the transform still requires selection,
a different reservation, or another model. Failure preserves the old window and
records the reason; settled usage and unresolved exposure stay with their owner.

Session identity and resources survive every context transition. `/context`
inspects capacity and selected sources. Apply selection and `context.transition`
submit an explicit selection bound to the inspected window and source revision.
Active runs schedule it at a legal boundary; idle sessions commit after admission.
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
bounds instead of fabricated compiled accounting. If a candidate cannot be materialized and admitted within its bounds, the window
remains unchanged. Permitted bounded recovery may propose another explicit selection;
otherwise the run waits for a source, capacity, or model change.

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

When a mandatory native result itself exceeds actual capacity, the recorded result and
its delivery obligation remain intact in a clear context conflict. Source selection
cannot bypass that obligation; cancellation may be necessary when no lawful
continuation fits. This is not a promise of universal automatic resumability.
