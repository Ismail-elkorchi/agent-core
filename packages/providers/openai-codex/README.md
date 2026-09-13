# `@agent-core/provider-openai-codex`

OpenAI Codex/ChatGPT subscription adapter for the provider-neutral contracts in `@agent-core/model`.

The default is `gpt-5.6`, with built-in Sol, Terra, and Luna profiles. `listModels()` discovers the authenticated account's model catalog; `describeModel()` discovers models without a built-in profile. Discovered profiles preserve the catalog's reasoning efforts and replace built-ins once the catalog is loaded. Complete `OpenAICodexModelProfileDefinition` overrides take precedence. Subscription capabilities come from this endpoint, including whether reasoning can be disabled; Platform pricing and `standard|pro` mode support are not inferred. Namespaced service tier accepts `default|priority`; obsolete aliases are rejected. HTTP full replay and WebSocket incremental continuation remain explicit strategies, and failed continuation resets conservatively. Both `complete()` and `stream()` use streaming transport; `complete()` collects its terminal response.

Bounded Responses framing is shared with the Platform adapter; credentials, headers, model policy, and continuation behavior are not.

Typed protocol replay preserves native reasoning items and developer authority, with explicit endpoint/model/prefix compatibility. Compiled session methods reuse the admitted full body before applying the existing conservative exact-prefix WebSocket optimization. Changed instructions, catalogs or input prefixes retain full-replay fallback. Platform Astra steering/async/context-transform support is not inferred for the subscription endpoint.

This transport rejects a requested generation cap. `compileRequest(request, { outputReservation })` therefore receives an explicit host reservation policy, not a server-enforced cap. Core supplies its selected request-window reservation for both primary and auxiliary inference. Standalone compilation without a policy marks output reservation unknown; it cannot pass governed admission. Never reserve zero by default or equate encrypted state bytes with logical tokens.
