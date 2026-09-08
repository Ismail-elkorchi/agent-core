# Agent Core

Agent Core is a pre-alpha, provider-neutral runtime for persistent model sessions. It preserves original conversation, offers scoped history and model-managed notes, accounts for compiled provider input, and keeps execution, model-output completeness, and verification independent.

Schema version `1` means the current schema only. The unpublished project intentionally has no compatibility readers or migrations.

## Packages

| Package | Responsibility |
| --- | --- |
| `@agent-core/runtime` | Run orchestration, governed inference, sessions, history, notes, context transitions, optional verification, approvals, and recovery; filesystem repositories use `@agent-core/runtime/node`. |
| `@agent-core/model` | Typed content and protocol contracts, provider capabilities, compilation, accounting, and validation. |
| `@agent-core/persistence` | Hash-chain, artifact, redaction, and in-memory repository contracts; `@agent-core/persistence/node` adds filesystem persistence. |
| `@agent-core/tools` | Generic tool contracts, effects, authorization, policy, and observations. |
| `@agent-core/tools-local` | Node workspace read, search, patch, shell, and process tools. |
| `@agent-core/auth` | Provider-neutral credential sources and local credential storage. |
| `@agent-core/provider-*` | Ollama, OpenRouter, OpenAI Platform, OpenAI Codex, Claude Messages, and shared Responses framing. |

Applications choose providers, prompt material, tools, checks, policies, authorization, and repositories. The runtime does not impose coding workspaces, writing evidence policy, or model-based judging. Public terminology is defined in [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

Finishing a run does not evict its conversation. Context transitions change
retained attention explicitly, while original sources remain available within
their authorized retention scope. Notes are attributed generated material, not
instructions or proof that work passed verification. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for ownership and recovery contracts.
The [context composition guide](docs/CONTEXT.md) describes the public services,
their boundaries, and the policy evaluation runner.

## Validate

Node.js 24 or newer is required.

```bash
npm install
npm run verify:release
```

`verify:release` cleans and builds once, lints, runs unit and focused recovery/provider tests, then packs every publishable package once and checks it from a strict external consumer.

Runnable applications are maintained separately in [Ismail-elkorchi/agents](https://github.com/Ismail-elkorchi/agents). Agent Core does not own application configuration, terminal presentation, or workspace layout.
