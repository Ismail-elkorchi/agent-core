# @agent-core/provider-openai-responses

Shared, dependency-light protocol primitives used by the OpenAI Platform and OpenAI Codex adapters. It owns bounded SSE framing and bounded HTTP diagnostic-body reads; authentication, model policy, continuation, and product-channel behavior remain in the concrete adapters.

This is not a model provider and does not blur OpenAI Platform credentials with ChatGPT subscription credentials.
