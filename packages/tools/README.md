# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and tool-owned model content. Node-local implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and capability-specific recovery proof. Missing proof is `unknown`; it never grants replay authority. Authorization applies to the exact persisted fingerprint.

`defineTool` is authoritative typed construction, including the owned JSON snapshot used for authorization and audit hashing. `ToolRegistry.register()` preserves authored definition identity. Independently implemented or dynamically loaded definitions cross the explicit `adoptToolDefinition()` boundary before registration.

Tool calls cross `createToolCall()` for typed construction or `decodeToolCall()` for external data. Planning accepts only that owned call and does not decode it again.

`CommandExecution` is the behavior boundary for starting, querying, controlling, recovering, and cleaning command executions. The runtime and tools do not require a concrete process manager. An application supplies an implementation with a versioned implementation identity and a stable recovery-store identity; unsupported recovery remains explicit rather than authorizing replay.


Observations use `kind: 'result' | 'failure'` for invocation disposition. Their structured `output` owns domain outcomes; a nonzero process exit, a partial read, and a failed application check can each be a returned result. Effectful tools report executor facts with `execution.state`: `not_started`, `settled`, `active`, or `unknown`. An active process retains its own owner and lease after its invocation returns. Missing executor facts for an effectful call cannot establish settlement. Failures carry a precise `reason` and relevant details; there is no generic success flag or required retry prose.

`buildModelContent({ call, input, observation })` optionally returns ordinary `ToolContent[]` (text, image, or artifact parts). Plain tools use the structured output fallback. Source tools return the requested original range and usable continuation handles. Content construction has no separate immediate/retained token budgets; compiled request accounting governs admission. UI renderers consume structured observations independently.
