# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and tool-owned model content. Node-local implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and capability-specific recovery proof. Missing proof is `unknown`; it never grants replay authority. Authorization applies to the exact persisted fingerprint.

`defineTool` is authoritative typed construction, including the owned JSON snapshot used for authorization and audit hashing. `ToolRegistry.register()` preserves authored definition identity. Independently implemented or dynamically loaded definitions cross the explicit `adoptToolDefinition()` boundary before registration.

Tool calls cross `createToolCall()` for typed construction or `decodeToolCall()` for external data. Planning accepts only that owned call and does not decode it again.

`CommandExecution` is the behavior boundary for starting, querying, controlling, recovering, and cleaning command executions. The runtime and tools do not require a concrete process manager. An application supplies an implementation with a versioned implementation identity and a stable recovery-store identity; unsupported recovery remains explicit rather than authorizing replay. Uncertainty acceptance binds process identity and the exact observation revision, so a stale decision cannot acknowledge new evidence.

`start()` distinguishes a dispatched command from a proven `not_started` refusal. Exceptions after dispatch can remain uncertain. `listProcesses()` includes authority-wide unresolved records, whose owner may be unavailable. A terminal report remains retained until its original owner durably records and acknowledges it. Reports already committed by an executor carry `settlementReference`; consumers reuse that event. Run-owned resources are released by the runtime; applications explicitly release resources with a longer owner lifetime.


`WorkspaceFiles` describes an adopted file authority independently of any host path or environment provider: normalized relative paths, incremental directory entries, bounded exact reads with revisions, and conditional transactions. Applications supply confinement, concurrency, epoch fencing, and lifetime ownership. Core does not select or initialize an environment.


Observations use `kind: 'result' | 'failure'` for invocation disposition. Their structured `output` owns domain outcomes; a nonzero process exit, a partial read, and a failed application check can each be a returned result. Effectful tools report executor facts with `execution.state`: `not_started`, `settled`, `active`, or `unknown`. An active process retains its own owner and lease after its invocation returns. Missing executor facts for an effectful call cannot establish settlement. A thrown failure from a call whose authorized accesses are all reads is a settled invocation failure, not an unconfirmed mutation; it does not establish successful retrieval or authorize replay. Failures carry a precise `reason` and relevant details; there is no generic success flag or required retry prose.

`buildModelContent({ call, input, observation })` optionally returns ordinary `ToolContent[]` (text, image, or artifact parts). Plain tools use the structured output fallback. Source tools return the requested original range and usable continuation handles. Content construction has no separate immediate/retained token budgets; compiled request accounting governs admission. UI renderers consume structured observations independently.
