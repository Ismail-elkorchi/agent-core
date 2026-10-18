# Agent Core

Agent Core is a pre-alpha, provider-neutral runtime for persistent model sessions. It preserves original conversation, offers scoped history and model-managed session state, accounts for compiled provider input, and keeps execution, model-output completeness, and verification independent.

Persisted contracts are versioned independently. The unpublished project accepts only the current formats and intentionally has no compatibility readers or migrations.

## Packages

| Package | Responsibility |
| --- | --- |
| `@agent-core/runtime` | Run orchestration, governed inference, sessions, history, session state, context transitions, optional verification, approvals, and recovery; filesystem repositories use `@agent-core/runtime/node`. |
| `@agent-core/model` | Typed content and protocol contracts, provider capabilities, compilation, accounting, and validation. |
| `@agent-core/persistence` | Hash-chain, artifact, redaction, and in-memory repository contracts; `@agent-core/persistence/node` adds filesystem persistence. |
| `@agent-core/tools` | Generic tool contracts, effects, authorization, policy, and observations. |
| `@agent-core/tools-local` | Node workspace read, search, patch, shell, and process tools. |
| `@agent-core/tools-programmatic` | Optional isolated JavaScript composition through the canonical governed tool executor; `/node` supplies the bounded QuickJS runner. |
| `@agent-core/tools-mcp` | Optional revision-bound MCP tool source; `/node` supplies explicit HTTP and stdio transports. |
| `@agent-core/tools-web` | Optional bounded web retrieval and configured search, retaining original captures and derived text separately. |
| `@agent-core/auth` | Provider-neutral credential sources and local credential storage. |
| `@agent-core/rpc` | Optional JSON-RPC boundary schemas and session/input/history/context/recovery mappings; `/node` owns JSONL stream lifetime. |
| `@agent-core/tui` | Optional conversation, configuration, source, draft, queue, and preference components using the consumer's terminal-ui peer; `/node` adds host/editor and UI storage integration. |
| `@agent-core/provider-*` | Ollama, OpenRouter, OpenAI Platform, OpenAI Codex, Claude Messages, and shared Responses framing. |

Applications choose providers, prompt material, tools, checks, policies, authorization, and repositories. The runtime does not impose coding workspaces, writing evidence policy, or model-based judging. Public terminology is defined in [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

Finishing a run does not evict its conversation. Original sources remain available
within their authorized retention scope. Model-authored session state consists of
addressable, revisioned items that can be saved independently of inference. A view
selects exact item revisions and original evidence; saving material does not silently
replace an admitted view. Explicit combined save-and-activate operations publish
both changes only after successor admission. Fresh continuation preserves runtime
resources and requires a lawful provider protocol boundary.

Deferred discovery, portable programs, and supported provider-native tool exposure
use the same exact tool contracts, authorization, effect planning, and settlement.
Loading a tool does not grant permission to call it. Optional packages require
explicit host configuration; ordinary sessions do not acquire network or process
authority from their presence.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for ownership and recovery,
and [`docs/CONTEXT.md`](docs/CONTEXT.md) for the public context operations.

## Validate

Node.js 24 or newer is required.

```bash
npm install
npm run verify:release
```

`verify:release` cleans and builds once, lints, runs unit and focused recovery/provider tests, then packs every publishable package once and checks it from a strict external consumer.

Runnable applications are maintained separately in [Ismail-elkorchi/agents](https://github.com/Ismail-elkorchi/agents). Applications own workspace layout, permission policy, and domain presentation. Core components accept data and optional capabilities without requiring a coding or writing application.
