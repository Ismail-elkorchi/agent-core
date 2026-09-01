# `@agent-core/provider-openai`

OpenAI Platform Responses API adapter for the provider-neutral contracts in `@agent-core/model`.

The quality default is `gpt-5.6-sol`. Trusted built-ins cover the `gpt-5.6` Sol alias, Sol, Terra, Luna, GPT-5.5, and GPT-5.5 Pro; unknown models require a complete `OpenAIModelProfileDefinition`. Explicit definitions replace built-ins and are runtime-validated—partial profile merging is intentionally unsupported. GPT-5.6 profiles declare 1,050,000 context tokens, 922,000 maximum input tokens, 128,000 output tokens, efforts `low` through `max`, independent `standard|pro` modes, tiered component pricing, and the official `reasoning.mode` wire field. Current service tiers are `auto|default|flex|priority`; undocumented values fail before a request is sent.

Ordinary Platform requests are stateless: the adapter sends the full logical input with `store:false` and does not use `previous_response_id`. Bounded SSE/JSON framing is shared with the Codex adapter through `@agent-core/provider-openai-responses`, while authentication and product semantics remain separate.
