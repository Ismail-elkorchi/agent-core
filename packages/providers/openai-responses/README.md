# @agent-core/provider-openai-responses

Shared, dependency-light protocol primitives used by the provider adapters. It owns Responses decoding and usage normalization, bounded SSE framing, bounded HTTP diagnostic-body reads, and JSON error-envelope decoding; authentication, model policy, continuation, and product-channel behavior remain in the concrete adapters.

HTTP failures retain the provider's explanation. Status and explicit protocol diagnostics determine classification and retry disposition: words such as “token” or “context” do not establish context overflow. Request timeouts remain transient transport failures, and exhausted account credits or spending limits are not retried as throttling.

Cancellation applies even when stream status ticks and idle timeouts are disabled. The reader releases its response body and preserves caller-owned abort reasons without modifying them. Provider adapters distinguish a requested cancellation from an upstream failure using the transport signal and error type, not diagnostic wording.

Provider usage is exact only when both input and output counts are present. An incomplete report remains available in the original response but does not become a fabricated zero count or calibrate request accounting. Explicit zero counts and reported cache/reasoning details remain intact.

This is not a model provider and does not blur OpenAI Platform credentials with ChatGPT subscription credentials.
