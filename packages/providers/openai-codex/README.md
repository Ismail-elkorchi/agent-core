# `@agent-core/provider-openai-codex`

OpenAI Codex/ChatGPT subscription adapter for the provider-neutral contracts in `@agent-core/model`.

The default is the documented `gpt-5.6` alias, with trusted Sol, Terra, and Luna identities and efforts through `max`. Unknown or locally enabled models require a complete `OpenAICodexModelProfileDefinition`; explicit definitions replace built-ins instead of partially merging guessed capabilities. The subscription channel deliberately does not claim Platform pricing, `standard|pro` mode support, or a disable-reasoning path. Namespaced service tier accepts `default|priority`; obsolete aliases are rejected. HTTP full replay and WebSocket incremental continuation remain explicit strategies, and failed continuation resets conservatively.

Bounded Responses framing is shared with the Platform adapter; credentials, headers, model policy, and continuation behavior are not.
