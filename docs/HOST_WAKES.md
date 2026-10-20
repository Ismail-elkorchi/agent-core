# Durable intentions and host wakes

An intention is accepted future work, not a suggestion extracted from conversation.
An embedding host calls `HostWakeService.accept` only after acceptance, supplying an
opaque responsible `ownerId`, stable `intentionId`, destination `sessionId`, original
`authorizationRef`, exact task input, and a time or event condition. These identifiers
are host configuration; text in a memory or skill cannot create authority.

Use `InMemoryIntentionRepository` for an explicitly ephemeral host, or
`JsonlIntentionRepository({ rootDir })` from `@agent-core/runtime/node` for process
restart. The durable implementation uses the existing event repository: an immutable
owner-qualified acceptance directory and revisioned per-intention records. Catalog
pages read only the selected owner's bounded acceptance page and exact current
records. They never enumerate other users or all sessions.

## Embedding contract

Construct `HostWakeService` with:

- `repository`: the accepted-intention repository
- `resolveSession(sessionId)`: the existing session, or a `HostWakeSession` facade
  containing `submitTriggered`, `readTriggeredSubmissionReceipt`, `readSubmission`,
  and `updateQueuedSubmission`
- `adapter.now()`: the host clock, returning an ISO timestamp
- `adapter.evaluate(intention, { signal })`: bounded clock/event observation returning
  `{ key, evidence }` or `undefined`. Event adapters must recover from their durable
  event source; an ephemeral timer or consumed-only in-memory event cannot promise
  restart recovery. Observation is outside the cancellation fence
- `adapter.withAdmission(intention, trigger, operation)`: recheck current authorization
  and the live condition, including relevant corrections, under the host authority
  fence. Call and await `operation` while holding that fence. Reject false, withdrawn,
  or stale authority/conditions. The authorization reference and evidence are records
  to verify, never self-authenticating grants

On startup, and after relevant host clock/event delivery, call
`recover(ownerId, { limit, maxBytes, cursor, signal })`. Follow returned cursors to
finish the captured owner page. `failures` are bounded diagnostics; failed intentions
remain unacknowledged and eligible for redelivery. A later recovery pass starts
without a cursor so newly accepted intentions and previously failed triggers are
checked. Core installs no timer, cron, monitoring agent, or inference loop.

Recovery and listing bound the complete serialized envelope, including cursors and
diagnostics. If even one entry cannot fit, they reject with the required size rather
than skip it or return a non-progressing page. Increase that explicit byte budget.

`dispatch(ownerId, intentionId, { expectedRevision?, signal? })` handles one explicit
host delivery. The default policy enqueues through the existing session queue and
requires its configured capacity. It never preempts an active run. Suspended sessions
reject new wake admission until ordinary session controls settle the suspension.
Manual session scheduling remains manual; automatic scheduling uses its existing
executor. Ordinary provider binding, continuing budgets, approvals, tool authorization,
resource settlement, uncertain effects, and cancellation remain in force.

## Admission and staging

`AgentSession.submitTriggered` is a host-only method requiring `withAdmission`.
Do not expose it, its origin, or its authority callback as user-controlled RPC input.
Ordinary submission and queue replacement reject forged `host_wake` origins.

Core captures the exact payload and computes its digest. The stable key identifies
one admission; a different payload for an admitted key rejects. The admission and
immutable receipt occupy one session-journal record. Concurrent duplicates and
retries after lost acknowledgments return that receipt, including after its run has
completed or its queued input has been canceled. A receipt is evidence of admission,
not of successful execution or an exactly-once external effect.

Optional `AgentSessionOptions.stageTriggeredSubmission` receives frozen prospective
`sessionId`, `submissionId`, `runId`, `key`, `payloadDigest`, `input`, and `configuration`
under the admission fence, before session publication. Hosts can persist application
permission state there. Staging must be idempotent by the stable identities and
must not reenter that same `AgentSession`. Staging failure admits no work. A crash
after staging may leave unused host-side staging; the host owns its retention.
Receipt replay skips staging. A remembered approval must never be used to select
or expand application permissions.

The run and submission identities remain stable across pre-admission retries. Core
records typed `host_wake` provenance, presents it as a host trigger rather than a new
direct user instruction, and exposes history authorship as `host`/role `control`.
It cannot increment the accepted-user-correction fence.

## Cancellation, revisions, and completion

All changes use revision checks. A slow observation for an obsolete revision cannot
prepare a trigger after cancellation or rescheduling. A recorded trigger is durable
before admission, retaining the original key and evidence across process death.
Admission receipt recovery precedes reconsidering authorization: discovering prior
admission does not authorize or create additional work.

`cancel` first checks whether an unacknowledged trigger already committed. It can
cancel an admitted queued input through ordinary session controls. A running or
suspended input must be aborted or reconciled through those controls; cancellation
never pretends that an uncertain effect did not execute. Rescheduling admitted work
rejects instead of creating an alternate run. After terminal session settlement,
recovery records `status: 'completed'` with independent `outcome` of `completed`,
`failed`, or `cancelled`.

The durable tests cover concurrent deliveries, conflicting payloads, real process
termination immediately before and after admission, receipt replay, revision races,
slow/canceled observations, denied current authority, suspension, host staging,
and bounded recovery. Scripted providers establish runtime behavior, not improved
model memory or task success.
