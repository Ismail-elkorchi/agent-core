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
| `@agent-core/cli` | Committed configuration, workspace layout, CLI, and TUI. |

Applications choose providers, tools, checks, policies, authorization, and repositories. The runtime does not impose coding tools or model-based judging.

## Validate

Node.js 24 or newer is required.

```bash
npm install
npm run verify:release
```

`verify:release` cleans and builds once, lints, runs unit and focused recovery/provider tests, then packs every publishable package once and checks it from a strict external consumer.

## CLI

```bash
# Read-only local task
npx agent-core "summarize this workspace" --provider ollama --model llama3.1

# Use committed workspace configuration
OPENAI_API_KEY=... npx agent-core \
  "fix the failing test and run the required checks" \
  --root . --config agent-core.config.json

# Resolve a persisted approval after restart
npx agent-core approval allow RUN_ID APPROVAL_ID FINGERPRINT \
  --root . --config agent-core.config.json
```

Interactive plain and TUI modes present approval details and explicit Allow/Deny choices. Noninteractive suspension exits with code `7` and prints the persisted identity.

Terminal output preserves the independent result axes. Exit codes are `0` success, `1` execution failure, `2` partial/indeterminate candidate, `3` failed required verification, `4` inconclusive verification, `7` suspension, and `130` abort.

`.agent-core` contains runtime state and is never source configuration. See [Architecture](docs/ARCHITECTURE.md), [Usage](docs/USAGE.md), and [Provider contracts](docs/PROVIDERS.md).
