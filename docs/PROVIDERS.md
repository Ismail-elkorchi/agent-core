# Provider contracts

Agent Core models provider features as discovered capabilities, not as a lowest-common-denominator request bag. `@agent-core/model` owns canonical parameter names, reasoning strategies, profile validation, request validation, and request-versus-profile validation. Provider-specific controls live only in namespaced `providerOptions` and cannot overwrite canonical fields.

## Typed input and accounting

Each profile carries a versioned protocol declaration for its endpoint. Typed input
preserves instruction authority, media, tool calls/results, and required protocol
state. Adapters reject unsupported combinations before dispatch; display reasoning
is never a substitute for required signed or opaque state.

First-party adapters compile an owned wire body and dispatch that same admitted
body. Request accounting distinguishes provider counts, estimates, and unknown
components. OpenAI Platform and Claude offer opt-in bounded counting endpoints;
other adapters use declared complete estimates and explicit allowances for unknown
state. Cached input still occupies context. Codex uses an application-supplied
output reservation because its subscription endpoint rejects the Platform output
cap parameter.

| Protocol family | Preserved state | Native execution boundary |
| --- | --- | --- |
| OpenAI Responses | Required reasoning items and exact continuation identities | Native steering requires the supported model profile and WebSocket transport; async tools and compaction require their explicit capability declarations. |
| Codex Responses | Subscription-compatible reasoning and conservative continuation | Platform native steering is not inferred from the shared Responses format. |
| OpenRouter Chat Completions | Original reasoning content/details and tool-call associations | Ordinary response/tool-result boundaries; routed capabilities come from the declared profile. |
| Ollama Chat | Declared thinking output and native tool-call associations | Ordinary request/response execution with explicit unsupported-control errors. |
| Claude Messages | Thinking signatures and redacted-thinking blocks in original order | Ordinary Messages execution; no advertised native steering, async tools, or context editing. |

These are adapter conformance claims. They do not establish model quality or live
account availability. Qwen/Kimi/GLM-compatible Chat fixtures exercise routed wire
fields without claiming direct vendor adapters. Unverified model families require
explicit profiles and their own conformance evidence.

## OpenAI Platform

`@agent-core/provider-openai` uses the Responses API and defaults to `gpt-5.6-sol`. Trusted built-ins cover the `gpt-5.6` Sol alias, Sol, Terra, Luna, GPT-5.5, and GPT-5.5 Pro; unknown model IDs require a complete explicit profile rather than an optimistic fallback. Explicit Platform profiles are complete replacements, not partial overlays.

The GPT-5.6 profiles declare 1,050,000 context tokens, 922,000 maximum input tokens, 128,000 maximum output tokens, efforts `low|medium|high|xhigh|max` plus the neutral disabled strategy for wire effort `none`, and independent `standard|pro` modes. The adapter serializes the official `reasoning.mode` field. Sol is the highest-capability default; Terra is the balanced price/latency choice; Luna is the high-volume choice. These are provider-owned profiles, not model IDs or tier logic embedded in the core. Pricing includes cache read/write rates and the whole-request multiplier above 272,000 input tokens. Stateless HTTP Platform calls submit the full logical input with `store:false` and no response-ID continuation. Namespaced options expose current `reasoning.context`, `prompt_cache_options`, and service tiers `auto|default|flex|priority`; the deprecated GPT-5.6 `prompt_cache_retention` field and undocumented `scale` tier are rejected before network I/O.

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

## Claude Messages

`@agent-core/provider-claude` is a native Messages reference adapter. It supports
text, images, PDF documents, JSON tools, manual thinking budgets, cache usage, and
partial/refusal output. Thinking signatures and redacted-thinking blocks survive
replay unchanged. Its built-in reference model is `claude-sonnet-4-6`; other models
require explicit verified profiles. The adapter does not guess unknown capacity,
pricing, or account access.

`countTokens: true` uses a bounded, cancellable Messages counting request during
compilation. Native steering, async tools, hosted server tools, adaptive thinking,
and context editing are not implemented. See the
[adapter contract](../packages/providers/claude/README.md) for exact scope and
protocol fixture references.

## Adding a provider

A new adapter must return a runtime-validated profile, validate every request at its boundary, normalize complete and streaming responses identically, emit exactly one terminal stream event, propagate abort, preserve visible streamed content, validate finite nonnegative usage, expose JSON-safe continuation state, and declare conservative retry disposition. Capabilities must come from an authoritative static profile or provider discovery; unknown values are not guessed. Provider model names, release tiers, authentication channels, wire-only controls, and continuation behavior stay in the adapter so adding a provider does not require editing the core model or run contracts.
