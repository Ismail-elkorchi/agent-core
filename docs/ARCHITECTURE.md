# Architecture

Agent Core is an application-neutral substrate. `@agent-core/runtime` owns orchestration, model-window assembly, sessions, approvals, recovery, and immutable execution outcomes. It depends on repository capabilities rather than filesystem paths.

`@agent-core/model` owns provider-neutral model contracts. Provider packages adapt external transports and decode their outputs before returning owned model values. `@agent-core/tools` owns domain-neutral tool definitions, effects, authorization, scheduling, observations, and registries. `@agent-core/tools-local` supplies optional Node and workspace implementations without making them runtime defaults.

Persistence contracts live at package roots. Filesystem implementations are isolated in `@agent-core/runtime/node` and `@agent-core/persistence/node`. Applications own provider selection, tool composition, configuration, environment layout, presentation, and product policy.

## Persistent conversation

A run records execution from admitted input to suspension or finalization. A session records accepted contributions and their branch relationships. A context window selects what to send to a provider. These boundaries serve different purposes: finishing a run does not summarize or discard its conversation.

History reads resolve original source identities within a captured branch boundary. Derived notes and summaries reference their sources; they do not replace the authoritative record. Search results are bounded and report coverage and a stable continuation cursor. A missing or inaccessible source is explicit. A source identifier supplied by a model cannot grant access to another branch or session.

Context changes are conditional commits. Before activation, the host checks the proposed selection against current input, mandatory application material, available retrieval, note revisions, request fit, and provider protocol obligations. If the captured state has changed, the transition must be revalidated. Network inference does not run while holding session command serialization. Failure before commit leaves the previous window active.

## Four kinds of continuity

Original user contributions retain their authorship. Applications decide which continuing requirements apply and how a later instruction supersedes an earlier one. Scheduling a follow-up does not itself cancel prior work.

Application state has application-defined meaning and immutable revision identity. Core does not prescribe fields for coding plans, editorial briefs, research findings, or completion criteria.

Model notes are attributed text or structured data with revision checks, scope, quotas, and source references. Writing a note is a storage operation. It cannot grant permission, alter an accepted requirement, or certify a check result. Notes are retrieved selectively; storing one does not inject it into every request.

Provider context state contains versioned continuation or reasoning material. Its adapter declares endpoint/model/protocol-revision compatibility and replay rules. Signed or opaque protocol state is distinct from display reasoning summaries and is not exposed through public history tools. A model switch must preserve only compatible state or explicitly reset that continuity.

## Inference and execution

Prompt assembly preserves declared system, developer, and user authority. Retrieved text and notes remain attributed data. Tool definitions are advertised through the provider catalog rather than duplicated as full prose. Applications supply purpose, tone, output policy, and any desired workflow; Core adds no universal persona or mandatory reflection cycle.

An inference invocation captures its owner, purpose, request identity, resources, cancellation, and durable result or uncertain outcome. Ordinary agent steps and auxiliary work share the inference service. A classifier or verifier does not need a complete conversational run just to invoke a model. Both durable and in-memory inference compositions include repositories, accounting, and recovery; partial compositions are rejected. Applications assign the budget owner independently of the current run.

The provider adapter compiles input before admission. Accounting covers actual tool arguments and results, schemas, control fields, content, media, and provider state. Estimates disclose their method and uncertainty; unknown opaque costs need an explicit admission policy. Context capacity, requested output, and the owning work's total budget are separate limits.

Provider capabilities are versioned contracts for a concrete endpoint and model. An optional method or marketing name is not proof of protocol support. Unsupported combinations fail explicitly. Native steering, asynchronous results, and context transforms must preserve the same input-delivery, effect-authorization, and settlement invariants as conservative request/response execution.

The single run state retains independent provider requests and tool groups alongside its lifecycle phase. Targeted transitions preserve unrelated work. Effect execution retains exact call identities, authorization fingerprints, locks, start fencing, and recovery records. A response ending, a tool job ending, and application work completing are independent facts. Known settled effects are not repeated after recovery; an unknown outcome does not become a successful observation.

Applications sequence verification, acceptance and publication through the shared effect executor. Core has no verification or disposition phase. `AgentSession` can leave submissions durably queued until an application explicitly starts the next one; notification handlers do not confer execution authority.

Execution resources have an explicitly granted lifetime owner independent of their originating call. A resource may span runs; adapters implement acquisition, control and release without changing its causal identity. Commands and filesystem resources are optional integrations.

Selected observation summaries and image representations are admitted context choices. Core preserves selected images or explicitly rejects a modality or resource-limit mismatch; it does not remove older attachments during assembly. Native-state invalidation retains portable original history and protected artifacts.

## Breaking formats and release evidence

This pre-alpha release replaces superseded context contracts in place. Incompatible persisted formats are rejected with a diagnostic; repositories do not migrate or delete user data automatically. There is no parallel legacy compaction engine.

Release checks cover both source and packed consumers. Deterministic tests establish delivery, scope, protocol, accounting, and recovery properties. Model-quality comparisons report workload, endpoint/model version, budgets, sample sizes, and uncertainty separately. A smaller prompt or a scripted fixture is not evidence that a memory policy improves real model behavior.
