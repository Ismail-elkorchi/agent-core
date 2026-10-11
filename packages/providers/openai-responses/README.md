# @agent-core/provider-openai-responses

Shared, dependency-light protocol primitives used by the provider adapters. It owns Responses decoding, bounded SSE framing, bounded HTTP diagnostic-body reads, and JSON error-envelope decoding; authentication, model policy, continuation, and product-channel behavior remain in the concrete adapters.

HTTP failures retain the provider's explanation. Status and explicit protocol diagnostics determine classification and retry disposition: words such as “token” or “context” do not establish context overflow. Request timeouts remain transient transport failures, and exhausted account credits or spending limits are not retried as throttling.

This is not a model provider and does not blur OpenAI Platform credentials with ChatGPT subscription credentials.
