# `@agent-core/provider-ollama`

Ollama adapter for the provider-neutral contracts in `@agent-core/model`.

Profiles are discovered through `/api/show`; custom clients without discovery provide a complete explicit profile. Tool, vision, thinking, and context capabilities are never guessed. GPT-OSS declares `low|medium|high` effort and cannot disable thinking; other thinking models use Ollama's boolean toggle. `deployment: 'cloud'` removes structured-output capabilities that are currently local-only. Request-scoped clients isolate aborts, and NDJSON errors preserve prior visible content.
