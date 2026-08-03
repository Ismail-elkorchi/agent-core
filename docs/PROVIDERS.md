# Provider contracts

Agent Core models provider features as discovered capabilities, not as a lowest-common-denominator request bag. `@agent-core/model` owns canonical parameter names, reasoning strategies, profile validation, request validation, and request-versus-profile validation. Provider-specific controls live only in namespaced `providerOptions` and cannot overwrite canonical fields.

## OpenAI Platform

`@agent-core/provider-openai` uses the Responses API and defaults to `gpt-5.6-sol`. Trusted built-ins cover the `gpt-5.6` Sol alias, Sol, Terra, Luna, GPT-5.5, and GPT-5.5 Pro; unknown model IDs require a complete explicit profile rather than an optimistic fallback. Explicit Platform profiles are complete replacements, not partial overlays.

The GPT-5.6 profiles declare 1,050,000 context tokens, 922,000 maximum input tokens, 128,000 maximum output tokens, efforts `low|medium|high|xhigh|max` plus the neutral disabled strategy for wire effort `none`, and independent `standard|pro` modes. The adapter serializes the official `reasoning.mode` field. Sol is the quality default; Terra is the balanced price/latency choice; Luna is the high-volume choice. These are provider-owned profiles, not model IDs or tier logic embedded in the core. Pricing includes cache read/write rates and the whole-request multiplier above 272,000 input tokens. Platform credentials and stored-response continuation remain Platform-only. Namespaced options expose current `reasoning.context`, `prompt_cache_options`, and service tiers `auto|default|flex|priority`; the deprecated GPT-5.6 `prompt_cache_retention` field and undocumented `scale` tier are rejected before network I/O.

References: [model catalog](https://developers.openai.com/api/docs/models), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and [reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode).

## OpenAI Codex

`@agent-core/provider-openai-codex` is a distinct ChatGPT-subscription transport and defaults to the documented `gpt-5.6` alias. It also trusts Sol, Terra, and Luna identities. Unknown subscription models require a complete replacement profile. It deliberately does not copy Platform pricing, claim `standard|pro` mode support, or claim that reasoning can be disabled on the Codex product surface. It supports effort through `max`; namespaced service tier is `default|priority`, with the obsolete `fast` alias rejected. Failed continuation resets conservatively, and HTTP full replay remains separate from WebSocket incremental continuation.

OpenAI Platform and Codex share only bounded Responses SSE/JSON primitives in `@agent-core/provider-openai-responses`; authentication, headers, storage behavior, model policy, continuation, and product-channel claims remain separate. Reference: [Codex model selection](https://developers.openai.com/codex/models).

## OpenRouter

`@agent-core/provider-openrouter` discovers profiles from `/api/v1/models`, maps snake_case wire parameters to canonical names, preserves raw declarations as metadata, and refreshes its bounded-TTL catalog explicitly or after failures. Reasoning effort is advertised only when `reasoning.supported_efforts` is present, token-budget reasoning only when `supports_max_tokens` is true, and disable only when reasoning is not mandatory. A `null` effort list means the router accepts the canonical effort set. JSON mode follows `response_format`; JSON Schema follows the distinct `structured_outputs` capability. Standard/Pro mode is rejected as non-route-neutral.

Routing remains an explicit namespaced option. Applications may set OpenRouter’s `provider.require_parameters` when they need upstream routes that accept every requested parameter. Reasoning visibility is sent through `reasoning.exclude`; the deprecated top-level `include_reasoning` alias is never emitted. Streaming recognizes top-level errors and `finish_reason: error`; it never retries after visible output. `Retry-After` is preserved as structured diagnostic delay.

References: [models](https://openrouter.ai/docs/guides/overview/models), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [streaming](https://openrouter.ai/docs/api/reference/streaming), and [errors](https://openrouter.ai/docs/api/reference/errors-and-debugging).

## Ollama

`@agent-core/provider-ollama` discovers capabilities and context limits with `/api/show`; custom clients without discovery must supply a complete profile. Tool calling, vision, and thinking are declared only when the model reports them. GPT-OSS thinking requires `low|medium|high` and cannot be disabled; generic thinking models use the toggle strategy. Unsupported effort, budget, mode, and summary controls fail explicitly.

The default deployment is `local`, where JSON and JSON-Schema formats are declared. `deployment: 'cloud'` removes those capabilities and rejects response formats because Ollama Cloud does not currently support structured outputs. Request-scoped clients isolate aborts, and midstream NDJSON errors preserve already-emitted visible content at the core boundary.

References: [show details](https://docs.ollama.com/api-reference/show-model-details), [thinking](https://docs.ollama.com/capabilities/thinking), [tool calling](https://docs.ollama.com/capabilities/tool-calling), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), and [errors](https://docs.ollama.com/api/errors).

## Adding a provider

A new adapter must return a runtime-validated profile, validate every request at its boundary, normalize complete and streaming responses identically, emit exactly one terminal stream event, propagate abort, preserve visible streamed content, validate finite nonnegative usage, expose JSON-safe continuation state, and declare conservative retry disposition. Capabilities must come from an authoritative static profile or provider discovery; unknown values are not guessed. Provider model names, release tiers, authentication channels, wire-only controls, and continuation behavior stay in the adapter so adding a provider does not require editing the core model or run contracts.
