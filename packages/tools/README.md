# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and observation presentations. Node and workspace implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and retry/recovery idempotency. Authorization applies to the exact persisted fingerprint.

`defineTool` is authoritative typed construction, including the owned JSON snapshot used for authorization and audit hashing. `ToolRegistry.register()` preserves authored definition identity. Independently implemented or dynamically loaded definitions cross the explicit `adoptToolDefinition()` boundary before registration.

`execute` is ambient process authority unless a host explicitly supplies a stronger isolation contract. Agent Core's built-in `exec_command` runs with the permissions of the Agent Core process. It may indirectly read, write, or delete files, access the network, and start child processes. Its conservative `workspace/files` lease remains held for the lifetime of a persistent process. Persistent ambient processes block conflicting workspace tools until they exit or stop.
