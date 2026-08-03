# `@agent-core/provider-openrouter`

OpenRouter adapter for the provider-neutral contracts in `@agent-core/model`.

Catalog profiles are runtime-validated and map provider-declared modalities, limits, snake_case parameters, pricing, and model-specific reasoning. Effort, token budget, mandatory reasoning, JSON mode, and JSON Schema are derived from their distinct catalog fields rather than inferred from a generic reasoning or response-format flag. Profiles refresh on a bounded TTL and explicit invalidation. Standard/Pro mode is rejected because it is not route-neutral; upstream selection and `require_parameters` remain namespaced routing options. Reasoning visibility uses `reasoning.exclude`, never the deprecated outgoing `include_reasoning` alias. Midstream errors preserve visible content and `Retry-After` survives as structured diagnostics.
