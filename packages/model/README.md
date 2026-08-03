# `@agent-core/model`

Provider-neutral model profiles, requests, complete responses, stream events, usage, termination, native tool calls, continuation state, and matching runtime validators.

Usage includes cache-read, cache-write, and reasoning tokens. `parseModelRequest` validates every discriminated message, image, tool, response format, reasoning strategy, and namespaced provider option; `assertModelRequestSupported` enforces that request against a runtime-validated profile. Provider sessions explicitly classify failed-request continuation as `reusable`, `reset_required`, or `unknown`; only the first permits reuse.
