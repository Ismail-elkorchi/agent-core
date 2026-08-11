# `@agent-core/model`

Provider-neutral model profiles, requests, complete responses, stream events, usage, termination, native tool calls, continuation state, and matching runtime validators.

Usage includes cache-read, cache-write, and reasoning tokens. `parseModelRequest` owns and validates every discriminated message, image, tool, response format, reasoning strategy, and namespaced provider option. Pass that decoded request and a decoded profile to `assertModelRequestSupported`; the support check enforces capability relationships without decoding either value again. Provider sessions explicitly classify failed-request continuation as `reusable`, `reset_required`, or `unknown`; only the first permits reuse.
