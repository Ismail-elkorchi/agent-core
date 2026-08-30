# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and observation presentations. Node-local implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and capability-specific recovery proof. Missing proof is `unknown`; it never grants replay authority. Authorization applies to the exact persisted fingerprint.

`defineTool` is authoritative typed construction, including the owned JSON snapshot used for authorization and audit hashing. `ToolRegistry.register()` preserves authored definition identity. Independently implemented or dynamically loaded definitions cross the explicit `adoptToolDefinition()` boundary before registration.

Tool calls cross `createToolCall()` for typed construction or `decodeToolCall()` for external data. Preparation accepts only that owned call and does not decode it again.

`CommandExecution` is the behavior boundary for starting, querying, controlling, recovering, and cleaning command executions. The runtime and tools do not require a concrete process manager. An application supplies an implementation with a versioned implementation identity and a stable recovery-store identity; unsupported recovery remains explicit rather than authorizing replay.
