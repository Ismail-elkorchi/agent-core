# `@agent-core/runtime`

Run orchestration, governed inference, original history, session-owned structured state, conditional context windows, sessions, approvals, recovery, and finalization. Admission uses the accounting for the exact compiled model input, including content, tools, media, protocol state, and an explicit output reservation.

The root exports contracts and in-memory repositories. Import `@agent-core/runtime/node` for `JsonlSessionRepository` and `JsonlInferenceRepository`. Applications supply storage locations explicitly.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository guidance and host-access policy, checks, diffs, and publication.

`EffectExecutionEvent` requires an observation for a settled state with a known outcome and forbids observations on other states. The event decoder verifies the observation's digest against the settlement before repository consumers use it.

See the repository's [context composition guide](../../docs/CONTEXT.md) for service boundaries and the public tool factories.

Work budgets are opt-in: applications may bound turns, tool calls, elapsed time, tokens, and cost. Defaults cover execution capacity, not task duration or a failure streak. Accounting continues without a configured budget. Context selection can omit settled exchanges within an active run while preserving original history, current input, and pending protocol obligations.

`AgentSession.close()` stops scheduling, interrupts the active run, and waits for its settlement. Queued submissions and suspended outcomes stay recorded for a new session instance; closing does not dispatch queued work or retry unknown effects.

Admission and queue capacity are session-wide durable decisions. `admitSubmission()` atomically accepts input and may claim the free execution slot; `claimNextSubmission()` takes the oldest queued input only when that slot is free. Separate clients observe and settle the same admitted submissions. Execution ownership is acquired before claiming input and held through runtime creation and durable settlement. Restoring or waiting on a session cannot take execution from a live client; an abandoned claimed run resumes through the existing fenced recovery path after ownership is acquired. Suspended outcomes keep their existing reconciliation requirements. `configure()` changes only local response-format defaults; model changes use the durable idle-boundary operation below.

Applications use `SessionReadLifetime` to own session-bound asynchronous reads. `read()` admits and starts the complete read synchronously, including derived-index publication and result decoration; `close()` fences new reads and waits for admitted reads to settle before their session resources are released. Replacement sessions receive a fresh lifetime. Read failures remain visible to their callers.

The admitted configuration includes the selected provider, model, endpoint, reasoning, and temperature. `SessionProviderBinding` owns exact adapter resolution, model and input validation, and inference-service replacement before admission and again before dispatch. Applications supply transport resolution, credentials, inference persistence, budgets, and request security policy. Model changes stage a validated binding and publish it only after durable selection succeeds; response formatting remains a per-client default. Admission compares that complete binding against the current durable selection under the repository lock; a concurrent change raises `SessionConfigurationChangedError` without accepting the input. Clients can refresh and retry. Execution records its actual profile in run events and never replaces the selected endpoint with a transport URL. Response formatting is validated against the selected adapter without becoming part of its binding identity.

Applications can use `authorizeSessionToolEffects` inside their ordinary tool authorizer to validate exact session/branch bookkeeping effects. Public artifact reads require a separate explicit host grant and resolution in the configured artifact repository; tool names alone never grant artifact access. The helper does not read artifact bodies, execute effects, or grant broad filesystem/persistence authority.

Observer delivery is bounded and independent of execution and settlement. A `delivery.gap` asks the consumer to reload authoritative session and application state before processing later notifications. Listener and failure-handler errors cannot block a run.

Submission transitions are fenced by `claimId`. Replacing a claim requires its observed `expectedClaimId`; completion, suspension, and failure require the current claim. A dispatcher that loses its claim or run-driver fence rejects only its local attempt and leaves durable work available for reconciliation. Restoration is read-only. Automatic dispatch can recover claimed input whose run was not yet accepted only after acquiring execution ownership, retaining its original run identity, input, and configuration. Accepted runs continue through the existing run-driver fencing and effect-reconciliation path.

`AgentRuntime.close()` releases an idle runtime, including resources acquired by a factory whose session claim was superseded. It is idempotent, rejects active execution or approval resolution, and prevents further dispatch on that explicitly closed runtime.

Cancellation fences new work while allowing the owning driver to reconcile already-started provider outcomes and record their usage. A response committed during cancellation remains known; an unavailable outcome remains uncertain. Recording a result does not authorize consuming it to start more work after cancellation.

Model changes use `AgentSession.changeModel({ selection, profile, artifacts })` at an idle boundary. They begin fresh provider continuation over portable originals while preserving the session and its current state. The next actual inference passes ordinary request admission. Original native reasoning stays in history; pending effects and result deliveries must be settled first. `parseModelSelection` from `@agent-core/model` parses selection commands. `recordedModelSelection` reads the committed selection; no continuation choice is saved as a default.

Run control is constructed as `new AgentRunCoordinator(events, artifacts)` with the same durable artifact repository on every attachment and restart. `AgentRunRecords` stores protected, run-scoped tool sources, exact inputs, approvals, plans, effects, and settlements before a transition publishes their integrity-bound references. Transition creation and replay are asynchronous: pass the records instance to `createAgentRunStateTransition(previous, next, records)` and `applyAgentRunStateTransition(previous, transition, records)`. Obsolete inline tool transitions are rejected without altering stored data. Recovery requires the original artifacts; replacing them with an empty repository cannot authorize execution.

Operational collections contain outstanding work and release completed batches after synchronous recording or acknowledged native application. The outstanding-work admission bound is 256 provider requests or tool calls; accumulated historical payload volume is not a run limit. `pendingToolCalls(state)` and `assertToolTransitionBoundary(state)` query the durable driver's state directly. `AgentRunBudget` reads and updates that driver's counters and retains elapsed-time arithmetic without owning a phase machine. Inference invocations attributed with `runId` contribute their settled owner charges once, including auxiliary requests and native successors. Applications must retain the inference repository across continuation and attribute auxiliary run inference to the same run; continuing-owner budgets remain separate from run limits.

An ordinary generation failure before any answer, reasoning, or tool call is delivered ends that candidate attempt. A retryable provider error allows two bounded retries, each with fresh invocation admission. HTTP `Retry-After` guidance is recorded as an absolute retry deadline and respected alongside backoff; waiting remains cancellable and counts toward the run deadline. Explicit account spending-cap rejections are not retried. Earlier uncertain charges remain reserved and completed tools are never replayed. Permanent errors and exhausted retries end the run with a failure. A recorded failed attempt ends cleanly after process loss without restarting its retry allowance. Native execution, partially delivered output, unclassified failures, and process loss without a recorded settlement still require outcome reconciliation. `provider.attempt.failed` records unavailable generation output or rejected capacity; it does not assert that an uncertain provider charge was refunded.

Answers use answer-channel content exclusively. Reasoning summaries and interrupted reasoning remain in their original event/session fields; reasoning-only output has an absent answer.


Original observations and delivered model content have independent persistence identities. Audit `tool.ended.observation` is a `StoredToolObservation` with inline original data or a public artifact reference. `resolveToolObservation(source, artifacts)` verifies and reads it. Progress `tool.ended` carries the owned observation directly. `observation.record.created` and session observations carry exactly one delivered `modelContent` or `modelContentRef`; `resolveToolModelContent(record, artifacts)` resolves the original representation. Content is selected once before settlement and is reused by live delivery, recovery, native successors, and history. Formatter changes and UI expansion cannot regenerate older results. Old inline audit records and retired presentation envelopes are rejected.

## State, context and inspection

Narrative state is stored as addressable items with immutable revisions. Use
`context_state_save` for conditional create/replace/edit/remove batches independent
of model-request admission. `context_transition` activates exact existing item
revisions/ranges and evidence; `context_save_and_activate` explicitly commits a
save and an admitted view atomically. A scheduled view receipt is not publication.
New saves do not change the selected view, and a rejected separate activation does
not undo them. `ContextService.sessionState()` reads the selected view only.

Use bounded list/search/read operations rather than hydrating all stored items.
Storage, mutation, read, source-selection and compiled-request limits remain
separate. State is optional request material: recovery may retain a smaller view
without deleting saved understanding. It cannot discard mandatory protocol
obligations, execute domain effects, or provide final answers. Continuing-work
budgets and durable recovery attempt limits survive restart.

`context_runtime_inspect` exposes configured or last-admitted capabilities,
allowances and active operations with revision-bound pagination.
`AgentSession.inspectProviderBinding()` resolves the current durable selection
without replacing an executing binding. Configuration is distinct from actual
request admission and dispatch.

See [Composing persistent context](../../docs/CONTEXT.md) for exact tool inputs,
per-item revision conflicts, attribution, bounds, view activation and recovery.
The current session format is `agent-core.session/6`; incompatible originals are
rejected in place and require their matching earlier build to read. No migration,
old-format reader, automatic summary or provider-compaction path is supplied.

Automatic-context tool presentations have an explicit 8 KiB text bound. A shortened presentation identifies itself as partial and references the persisted full selected presentation; original observations, coverage, execution facts, and call/result pairing remain unchanged. Storage failure does not silently shorten unavailable originals. Every actual successor and recovery request still passes admission; the continuity probe is not a guarantee about arbitrary future input. Recovery exchanges remain original history but do not become application conversation or native continuation.

## Session metadata projection

`JsonlSessionRepository` keeps one rebuildable projection beside the original JSONL ledger. A bounded root selects immutable, checksummed lookup nodes for branch positions, current settings, session state, submissions, and retry/finalization records. The Node adapter stores these derived nodes in one SQLite database using the built-in Node API; consumers need no database dependency or setup. Historical roots preserve captured cuts, while retired current-state nodes are reclaimed. Node changes and the bounded root commit in one database transaction after the authoritative source append; an interrupted derived commit catches up from the source on normal access. After the authoritative terminal event commits, its exact reference is confirmed in the same session lifecycle; cold capture can then skip the completed archive and inspect only unconfirmed or open runs. Publication is atomic; an unaccepted candidate cannot replace the committed root. Checksums detect inconsistent derived data, not malicious rewriting of both data and checksum.

Persistent lookup structures trade additional write work and derived storage for bounded cold access. Historical immutable nodes grow with retained source history; bounded caches limit in-process reuse, not total archive storage. SQLite operations are synchronous, and captured-source validation still performs filesystem work at public read boundaries. These guarantees do not imply faster steady appends than an append-only metadata log.

Ordinary open, settings lookup, scheduling, and append use point lookups rather than replaying the transcript. `historyReadMetrics` reports metadata reads separately from source scanning and body reads. Explicit `loadReplayState()` still validates and materializes the selected original branch. Missing, stale, or damaged derived data is rebuilt from original records under the source lock. Invalid or incompatible originals are rejected in place; no migration or repair rewrites them.

Applications can preflight a set of sessions with `recoverHistoryIndexes(expectedBinding, options)` and use `rebuildHistoryIndex(sessionId, expectedBinding, options)` for deliberate host diagnostics. These are storage operations, not user commands. Cancellation before publication preserves the previous projection; a failure after publication reports `SessionHistoryIndexPublicationError` with the publication outcome rather than claiming rollback. Ordinary users need no knowledge of indexes or recovery.

When a mandatory native result itself exceeds actual capacity, the recorded result and
its delivery obligation remain intact in a clear context conflict. Source selection
cannot bypass that obligation; cancellation may be necessary when no lawful
continuation fits. This is not a promise of universal automatic resumability.
