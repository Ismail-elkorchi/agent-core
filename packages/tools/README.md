# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and observation presentations. Node and workspace implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and retry/recovery idempotency. Authorization applies to the exact persisted fingerprint.
