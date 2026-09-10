# `@agent-core/provider-openai-codex`

OpenAI Codex/ChatGPT subscription adapter for the provider-neutral contracts in `@agent-core/model`.

The default is the documented `gpt-5.6` alias, with trusted Sol, Terra, and Luna identities and efforts through `max`. Unknown or locally enabled models require a complete `OpenAICodexModelProfileDefinition`; explicit definitions replace built-ins instead of partially merging guessed capabilities. The subscription channel deliberately does not claim Platform pricing, `standard|pro` mode support, or a disable-reasoning path. Namespaced service tier accepts `default|priority`; obsolete aliases are rejected. HTTP full replay and WebSocket incremental continuation remain explicit strategies, and failed continuation resets conservatively.

Bounded Responses framing is shared with the Platform adapter; credentials, headers, model policy, and continuation behavior are not.

Typed protocol replay preserves native reasoning items and developer authority, with explicit endpoint/model/prefix compatibility. Compiled session methods reuse the admitted full body before applying the existing conservative exact-prefix WebSocket optimization. Changed instructions, catalogs or input prefixes retain full-replay fallback. Platform Astra steering/async/context-transform support is not inferred for the subscription endpoint.

This transport rejects a requested generation cap. `compileRequest(request, { outputReservation })` therefore receives an explicit host reservation policy, not a server-enforced cap. Core supplies its selected request-window reservation for both primary and auxiliary inference. Standalone compilation without a policy marks output reservation unknown; it cannot pass governed admission. Never reserve zero by default or equate encrypted state bytes with logical tokens.
