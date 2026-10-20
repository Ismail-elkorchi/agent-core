# Architecture

Agent Core is an application-neutral substrate. `@agent-core/runtime` owns orchestration, model-window assembly, sessions, approvals, recovery, and immutable execution outcomes. It depends on repository capabilities rather than filesystem paths.

`@agent-core/model` owns provider-neutral model contracts. Provider packages adapt external transports and decode their outputs before returning owned model values. `@agent-core/tools` owns domain-neutral tool definitions, effects, authorization, scheduling, observations, and registries. `@agent-core/tools-local` supplies optional Node and workspace implementations without making them runtime defaults.

Persistence contracts live at package roots. Filesystem implementations are isolated in `@agent-core/runtime/node` and `@agent-core/persistence/node`. Applications own provider selection, tool composition, configuration, environment layout, presentation, and product policy.

## Persistent conversation

A run records execution from admitted input to suspension or finalization. A session records accepted contributions and their branch relationships. A context window selects what to send to a provider. These boundaries serve different purposes: finishing a run does not summarize or discard its conversation.

History reads resolve original source identities within a captured branch boundary. Generated session state records its originating inference input; it does not replace the authoritative record. Search results are bounded and report coverage and a stable continuation cursor. A missing or inaccessible source is explicit. A source identifier supplied by a model cannot grant access to another branch or session.

Context changes are conditional commits. Before activation, the host checks the proposed selection against current input, mandatory application material, available retrieval, session-state revisions, request fit, and provider protocol obligations. If the captured state has changed, the transition must be revalidated. Network inference does not run while holding session command serialization. Failure before commit leaves the previous window active.

## Four kinds of continuity

Original user contributions retain their authorship. Applications decide which continuing requirements apply and how a later instruction supersedes an earlier one. Scheduling a follow-up does not itself cancel prior work.

Application state has application-defined meaning and immutable revision identity. Core does not prescribe fields for coding plans, editorial briefs, research findings, or completion criteria.

Addressable narrative items have a canonical owner: a session branch or an explicitly host-granted durable scope. Both use the same immutable revision and conditional mutation rules, protected content references and recorded inference attribution. The producing inference and its captured history boundary remain distinct from the target owner. Conditional batches save independently of model requests; disjoint item writes do not conflict. An admitted context view selects exact revisions and optional byte ranges, not all current heads. Session-local combined save-and-activate publishes both or neither after admission. Shared-scope saves commit independently; a later view selects their returned revisions. Mixed-owner atomic batches and shared-scope combined activation are rejected. Forks inherit historical branch state. Storage, bounded retrieval and compiled request fit are independent limits. Material cannot grant permission, alter accepted requirements or certify a check result. See [the context guide](CONTEXT.md) for the concrete APIs.

Provider context state contains versioned continuation or reasoning material. Its adapter declares endpoint/model/protocol-revision compatibility and replay rules. Signed or opaque protocol state is distinct from display reasoning summaries and is not exposed through public history tools. A model switch must preserve only compatible state or explicitly reset that continuity.

## Inference and execution

Prompt assembly preserves declared system, developer, and user authority. Retrieved text and session state remain attributed data. Tool definitions are advertised through the provider catalog rather than duplicated as full prose. At a fresh window, stable references and the selected session-state view precede retained attributed source material and the active conversation. Within that window, the admitted prefix is immutable and conversation grows append-only; state is not rewritten at every request suffix. Provider-owned reasoning and tool replay retain their required identities and order. Applications supply purpose, tone, output policy, and any desired workflow; Core adds no universal persona or mandatory reflection cycle.

An inference invocation captures its owner, purpose, request identity, resources, cancellation, and durable result or uncertain outcome. Ordinary agent steps and auxiliary work share the inference service. A classifier or verifier does not need a complete conversational run just to invoke a model. Both durable and in-memory inference compositions include repositories, accounting, and recovery; partial compositions are rejected. Applications assign the budget owner independently of the current run.

The provider adapter compiles input before admission. Accounting covers actual tool arguments and results, schemas, control fields, content, media, and provider state. Estimates disclose their method and uncertainty. Provider counts or compatible request-level usage cover opaque state; otherwise its cost remains explicitly unquantified and does not itself establish overflow. Context capacity, requested output, and the owning work's total budget are separate limits.

Provider capabilities are versioned contracts for a concrete endpoint and model. An optional method or marketing name is not proof of protocol support. Unsupported combinations fail explicitly. Native steering, asynchronous results, and append-or-fresh context transitions must preserve the same input-delivery, effect-authorization, and settlement invariants as conservative request/response execution.

The durable driver retains outstanding provider requests and tool groups alongside its lifecycle phase. Completed work leaves those collections after its recording and delivery obligations resolve; protected, run-scoped immutable records preserve original inputs, approvals, effects, and observations. References are committed only after their records are durable, and recovery verifies their scope and digest. Targeted transitions preserve unrelated work. Effect execution retains exact call identities, authorization fingerprints, locks, start fencing, and recovery records. A response ending, a tool job ending, and application work completing are independent facts. Known settled effects are not repeated after recovery; an unknown outcome does not become a successful observation.

Applications sequence verification, acceptance and publication through the shared effect executor. Core has no verification or disposition phase. `AgentSession` can leave submissions durably queued until an application explicitly starts the next one; notification handlers do not confer execution authority.

Execution resources have an explicitly granted lifetime owner independent of their originating call. A resource may span runs; adapters implement acquisition, control and release without changing its causal identity. Commands and filesystem resources are optional integrations.

Selected original sources, tool model content, and optional session-state revisions are admitted context choices. Core preserves selected images or explicitly rejects a modality or resource-limit mismatch; it does not remove older attachments during assembly. Fresh transitions preserve portable original history and protected artifacts, require an explicit `fresh_request` reset capability at a safe protocol boundary, and replace the live provider session without carrying old response identifiers or opaque continuation state into the new window. Selected-view changes can append exact attributed replacement notices to a frozen checkpoint without resetting compatible native reasoning or tool continuation. Stored item heads are distinct from exact active references and older superseded projections within that continuation. Effective view no-ops publish no window or notice; explicit renewal overrides no-op classification. Applications propose evidence and renewal intent, while Core owns prefix validation and reset identity. Pressure checkpoints append runtime control to the unchanged prefix and tool catalog; execution gates restrict checkpoint tools. Accepted input arriving during publication is reassembled and readmitted before dispatch.

## Scoped material and reusable methods

Subject identity and audience are separate. Material about a person, relationship,
activity or environment is visible only through explicit host grants. Matching names
never merge subjects or grant access. Bounded discovery authorizes identifiers,
previews and cursors as well as bodies. Literal or semantic retrieval can suggest
useful references; it does not publish an active view or establish their truth.
Accepted inputs and outstanding execution obligations are independent of optional
recall. Late recall cannot cross a newer correction or permission boundary.

Inventory removal hides a live head. Deselection changes the active view.
Supersession records a changed interpretation. Revocation withdraws future use,
including material retained inside a native prefix. These operations do not promise
physical deletion. An optional erasure capability reports its actual local coverage,
retained shared bytes and unsupported storage; prior remote deliveries and separately
governed history are explicit limitations. Declared derivation can propagate
revocation, but cannot prove complete semantic unlearning.

Skill packages are immutable reusable instructions and resource inventories. Their
metadata can be discovered without loading every body. Selection binds an exact
package revision; scripts are never run by discovery or reading. Resource execution
uses the existing authorized tool or command capability. Package permission metadata
cannot enlarge host authority. Repository-scoped guidance retains its different
applicability and is not replaced merely because a skill has similar prose.

## Accepted future work

An intention records future work the host has actually accepted, including its
original authorization and current condition. A host event or clock adapter admits
a wake through the ordinary session queue. Durable trigger identities make retries
return the same admission receipt, including after restart or a lost acknowledgment.
A wake carries its own origin; it is not a fabricated user correction or permission
to resume suspended work. Host recovery must rediscover eligible unacknowledged
intentions. An in-memory timer alone does not supply that guarantee.

Admission idempotency does not make arbitrary external effects exactly once.
Cancellation, current authorization, budget ownership and uncertain outcomes retain
their ordinary execution contracts. No new agent loop or executor is introduced.

## Breaking formats and release evidence

This pre-alpha release replaces superseded context contracts in place. Incompatible persisted formats are rejected with a diagnostic; repositories do not migrate or delete user data automatically. There is no native, server, or parallel legacy compaction engine.

Release checks cover both source and packed consumers. Deterministic tests establish delivery, scope, protocol, accounting, and recovery properties. Model-quality comparisons report workload, endpoint/model version, budgets, sample sizes, and uncertainty separately. A smaller prompt or a scripted fixture is not evidence that a memory policy improves real model behavior.
