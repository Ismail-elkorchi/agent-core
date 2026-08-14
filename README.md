# Agent Core

Agent Core is a pre-alpha, provider-neutral runtime for tool-using model sessions. It preserves native tool protocols, records structured evidence, reduces context deterministically, and reports execution, candidate completeness, and verification independently.

Schema version `1` means the current schema only. The unpublished project intentionally has no compatibility readers or migrations.

## Packages

| Package | Responsibility |
| --- | --- |
| `@agent-core/runtime` | Run orchestration, context, session contracts, verification, approvals, recovery, and terminal contracts; `@agent-core/runtime/node` adds JSONL sessions. |
| `@agent-core/model` | Provider-neutral model contracts and validation. |
| `@agent-core/evidence` | JSON/evidence contracts and in-memory repositories; `@agent-core/evidence/node` adds filesystem persistence. |
| `@agent-core/tools` | Generic tool contracts, effects, authorization, policy, and observations. |
| `@agent-core/tools-local` | Node workspace read, search, patch, shell, and process tools. |
| `@agent-core/auth` | Provider-neutral credential sources and local credential storage. |
| `@agent-core/provider-*` | Ollama, OpenRouter, OpenAI Platform, OpenAI Codex, and shared Responses framing. |

Applications choose providers, tools, checks, policies, authorization, and repositories. The runtime does not impose coding tools or model-based judging.

## Validate

Node.js 24 or newer is required.

```bash
npm install
npm run verify:release
```

`verify:release` cleans and builds once, lints, runs unit and focused recovery/provider tests, then packs every publishable package once and checks it from a strict external consumer.

Runnable applications are maintained separately in [Ismail-elkorchi/agents](https://github.com/Ismail-elkorchi/agents). Agent Core does not own application configuration, terminal presentation, or workspace layout.
