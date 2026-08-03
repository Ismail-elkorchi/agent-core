# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and observation presentations. Node and workspace implementations live in `@agent-core/tools-local`.

The runtime boundary is parse → canonicalize → derive call-specific effects → authorize. Effects include kind, resource scopes, idempotency, reversibility, dependencies, and optional compensation metadata. Authorization returns `allow`, `deny`, or `require_approval` for the exact fingerprint.
