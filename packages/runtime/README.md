# `@agent-core/runtime`

Run orchestration, governed inference, original history, scoped notes, conditional context windows, sessions, approvals, recovery, and finalization. Admission uses the accounting for the exact compiled model input, including content, tools, media, protocol state, and an explicit output reservation.

The root exports contracts and in-memory repositories. Import `@agent-core/runtime/node` for `JsonlSessionRepository`, `JsonlNoteRepository`, and `JsonlInferenceRepository`. Applications supply storage locations explicitly.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository isolation, checks, diffs, and publication.

`EffectExecutionEvent` requires an observation for a settled state with a known outcome and forbids observations on other states. The event decoder verifies the observation's digest against the settlement before repository consumers use it.

See the repository's [context composition guide](../../docs/CONTEXT.md) for service boundaries and the public tool factories.

Work budgets are opt-in: applications may bound turns, tool calls, elapsed time, tokens, and cost. Defaults cover execution capacity, not task duration or a failure streak. Accounting continues without a configured budget. Context selection can omit settled exchanges within an active run while preserving original history, current input, and pending protocol obligations. Provider-native transforms may represent settled active exchanges when supported.

`AgentSession.close()` stops scheduling, interrupts the active run, and waits for its settlement. Queued submissions and suspended outcomes stay recorded for a new session instance; closing does not dispatch queued work or retry unknown effects.

Model changes use `AgentSession.changeModel({ selection, profile, artifacts })` at an idle session boundary. Selected incompatible native state raises `ModelContinuationRequiredError`; an explicit user command may pass `continuation: 'fresh'`. The reset records the target model, a history cut, portable original source references, and selected note revisions together. The next actual inference uses ordinary runtime request admission. Accepted input, answer content, complete tool exchanges, and supported original images remain available; native reasoning and opaque continuation state remain in original history. Pending work, uncertain effects, and unacknowledged result deliveries must be resolved first. A fresh continuation does not authorize replaying an uncertain request or terminating continuing resources.

`parseModelChangeRequest` decodes a flat model-selection command with an optional `continuation: 'fresh'`; the option is not a saved default. `recordedModelSelection` reads committed model selections and fresh resets without treating later carried source representations as another model choice.

Run control is constructed as `new AgentRunCoordinator(events, artifacts)` with the same durable artifact repository on every attachment and restart. `AgentRunRecords` stores protected, run-scoped tool sources, exact inputs, approvals, plans, effects, and settlements before a transition publishes their integrity-bound references. Transition creation and replay are asynchronous: pass the records instance to `createAgentRunStateTransition(previous, next, records)` and `applyAgentRunStateTransition(previous, transition, records)`. Obsolete inline tool transitions are rejected without altering stored data. Recovery requires the original artifacts; replacing them with an empty repository cannot authorize execution.

Operational collections contain outstanding work and release completed batches after synchronous recording or acknowledged native application. The outstanding-work admission bound is 256 provider requests or tool calls; accumulated historical payload volume is not a run limit. `pendingToolCalls(state)` and `assertToolTransitionBoundary(state)` query the durable driver's state directly. `AgentRunBudget` reads and updates that driver's counters and retains elapsed-time arithmetic without owning a phase machine. Inference invocations attributed with `runId` contribute their settled owner charges once, including transforms and native successors. Applications must retain the inference repository across continuation and attribute auxiliary run inference to the same run; continuing-owner budgets remain separate from run limits.

Answers use answer-channel content exclusively. Reasoning summaries and interrupted reasoning remain in their original event/session fields; reasoning-only output has an absent answer.


Original observations and delivered model content have independent persistence identities. Audit `tool.ended.observation` is a `StoredToolObservation` with inline original data or a public artifact reference. `resolveToolObservation(source, artifacts)` verifies and reads it. Progress `tool.ended` carries the owned observation directly. `observation.record.created` and session observations carry exactly one delivered `modelContent` or `modelContentRef`; `resolveToolModelContent(record, artifacts)` resolves the original representation. Content is selected once before settlement and is reused by live delivery, recovery, native successors, and history. Formatter changes and UI expansion cannot regenerate older results. Old inline audit records and retired presentation envelopes are rejected.

Model note mutation schemas request the desired note and expected revision. The runtime binds deduplication to the durable tool invocation; model-authored idempotency keys are rejected. Explicit host repository commands retain their command identity.
