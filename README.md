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
# Start an interactive TUI session
npx agent-core --provider ollama --model llama3.1

# Start the TUI and immediately run a task
npx agent-core "summarize this workspace" --provider ollama --model llama3.1

# Run once without a TUI
npx agent-core exec "summarize this workspace" --provider ollama --model llama3.1

# Use committed workspace configuration
OPENAI_API_KEY=... npx agent-core \
  "fix the failing test and run the required checks" \
  --root . --config agent-core.config.json --apply --allow-shell

# Resolve a persisted approval after restart
npx agent-core approval allow RUN_ID APPROVAL_ID FINGERPRINT \
  --root . --config agent-core.config.json --allow-shell
```

`agent-core` is the interactive TUI entry point. `agent-core exec <task|->` is the noninteractive entry point and accepts a task argument or stdin. The TUI resolves approvals directly; `agent-core approval` resolves an exact persisted fingerprint after the original process exits.

New sessions are the default. `--resume` selects the most recently active session in the workspace, while `--session <id>` opens an existing session. A resumed session retains its latest provider and model unless an explicit CLI option overrides them.

Explicit CLI options override resumed-session settings, committed configuration, environment values, and built-in defaults in that order. Project authorization can restrict invocation authority but cannot grant it: `--apply` or `--dry-run` is required for structured writes, and `--allow-shell` is required for ambient execution and configured command checks.

Noninteractive output preserves the independent result axes. Exit codes are `0` success, `1` execution failure, `2` partial/indeterminate candidate, `3` failed required verification, `4` inconclusive verification, `7` suspension, and `130` abort.

`.agent-core` contains runtime state and is never source configuration. See [Architecture](docs/ARCHITECTURE.md), [Usage](docs/USAGE.md), and [Provider contracts](docs/PROVIDERS.md).
