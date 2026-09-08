# `@agent-core/provider-ollama`

Ollama adapter for the provider-neutral contracts in `@agent-core/model`.

Profiles are discovered through `/api/show`; custom clients without discovery provide a complete explicit profile. Tool, vision, thinking, and context capabilities come from discovery. Exact documented GPT-OSS names declare `low|medium|high` effort and cannot disable thinking; other discovered thinking models use Ollama's boolean toggle. Custom names requiring effort control need an explicit profile override. Constructor reasoning defaults pass the same capability validation as request controls. These mappings follow the [Ollama thinking documentation](https://docs.ollama.com/capabilities/thinking).

`deployment: 'cloud'` removes structured-output capabilities that are currently local-only. Request-scoped clients isolate aborts, and NDJSON errors preserve prior visible content. Compilation owns the sent body and accounts for arguments, schemas, images, control options, and replayed thinking; heuristic thinking estimates remain distinct from provider token counts. Native steering, async tools, and context transforms are not declared.

The protocol declares `developerRole: 'system_if_no_system'`: a developer-only instruction tier uses Ollama's native system channel while logical requests retain their original developer role. Requests containing both system and developer contributions fail because this adapter cannot preserve two distinct instruction tiers. User, retrieved, and tool content keep their original roles. This lowering is an adapter policy over the [native chat role surface](https://docs.ollama.com/api/chat), not a claim that Ollama supports a distinct developer channel.
