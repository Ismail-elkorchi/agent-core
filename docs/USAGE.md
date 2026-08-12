# Usage

Agent Core is pre-alpha and intentionally uses breaking contracts. Import documented package exports only.

## Persistence

```ts
import { InMemoryArtifactRepository, InMemoryEventRepository } from '@agent-core/evidence';
import { JsonlEventRepository, LocalArtifactRepository } from '@agent-core/evidence/node';
import { AgentRuntime, agentEventCodec } from '@agent-core/runtime';
import { JsonlSessionRepository } from '@agent-core/runtime/node';

const events = new JsonlEventRepository({ rootDir: '.agent-core/runs', codec: agentEventCodec });
const sessions = new JsonlSessionRepository({ rootDir: '.agent-core/sessions' });
const artifacts = new LocalArtifactRepository({ rootDir: '.agent-core/artifacts' });
```

Repository interfaces do not expose filesystem paths. Applications can substitute the in-memory implementations.

## CLI

```bash
# Interactive TUI, optionally with an initial task
agent-core
agent-core "inspect the failing checks"

# Noninteractive task or piped input
agent-core exec "summarize the workspace"
printf '%s\n' 'summarize the workspace' | agent-core exec -

# Resume the most recently active session or open an existing ID
agent-core --resume
agent-core --session SESSION_ID
```

Session selection is not part of committed configuration. A resumed session restores its latest provider and model unless explicitly overridden. Resolution order is explicit CLI options, resumed-session settings, committed configuration, environment values, then built-in defaults.

Configured authorization restricts rather than grants invocation authority. Use `--apply` for structured mutation, `--dry-run` to validate structured writes without mutation, and `--allow-shell` for ambient execution. Configured command checks require `--allow-shell` and project `execute` authorization.

## Approvals

Input is parsed and canonicalized before authorization. When a call requires approval, `run()` returns a durable suspension:

```ts
const result = await runtime.run({ task: 'update the workspace' });
if (result.state === 'suspended') {
  const approval = result.pendingApprovals[0];
  const resumed = await reopenedRuntime.resolveApproval({
    runId: result.runId,
    approvalId: approval.approvalId,
    fingerprint: approval.fingerprint,
    decision: 'allow'
  });
}
```

Changed input, effects, implementation, policy, or execution boundary invalidates the approval. Non-idempotent uncertain work is never retried automatically.

The CLI supports the same persisted operation after process restart:

```bash
agent-core approval allow RUN_ID APPROVAL_ID FINGERPRINT --root . --config agent-core.config.json --allow-shell
```

## Checks

```ts
const checks = [{
  id: 'mentions-risk',
  requirement: 'required' as const,
  timeoutMs: 2_000,
  async run({ candidate, signal }) {
    signal.throwIfAborted();
    return candidate.message.includes('risk')
      ? { verdict: 'passed' as const, summary: 'Risk is covered.' }
      : { verdict: 'failed' as const, summary: 'Risk is missing.' };
  }
}];
```

Checks are read-only by default. Grant a bounded verification command executor only when command execution is intended.

## Result semantics

- Normal stop with visible content: completed execution and complete candidate.
- Output limit or content filter with visible content: completed execution and partial candidate.
- Interrupted stream or abort after visible content: failed/aborted execution, partial candidate, verification not run.
- Failure before visible content: absent candidate.
- Missing or unknown required check: inconclusive verification.

Run `npm run verify:release` for the full repository gate.
## Complete CLI option reference

Run `agent-core [initial task] [options]` for the interactive TUI. Run `agent-core exec <task|-> [options]` for one noninteractive task; `-` reads the task from standard input.

| Option | Parameter and behavior |
| --- | --- |
| `--root <dir>` | Workspace root. Defaults to the current directory. |
| `--config <path>` | Load committed instructions, provider/model settings, tools, authorization, verification checks, and limits. |
| `--provider <name>` | Select `ollama`, `openrouter`, `openai`, or `openai-codex`. |
| `--model <name>` | Select the provider model, such as `gpt-5.6-luna`. |
| `--provider-endpoint <url>` | Override the Ollama host or hosted-provider base URL. |
| `--codex-transport <http_sse\|websocket>` | Select OpenAI Codex HTTP full-replay streaming or live WebSocket continuation. Defaults to `http_sse`. |
| `--max-output-tokens <n>` | Set a positive per-request output-token limit. |
| `--temperature <n>` | Set a finite temperature when the selected provider/model supports it. OpenAI Codex subscription requests do not support temperature. |
| `--reasoning-effort <level>` | Select `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, subject to provider/model support. |
| `--show-reasoning` | Render reasoning text or summaries exposed by the provider. It does not expose private chain-of-thought. |
| `--apply` | Authorize structured patch writes, subject to committed authorization policy and approvals. |
| `--dry-run` | Validate structured patch writes without applying them. This does not sandbox shell commands. |
| `--allow-shell` | Authorize ambient shell execution. Required for configured command checks and subject to committed authorization policy and approvals. |
| `--resume` | Resume the most recently active session for this workspace. |
| `--session <id>` | Open an existing session by exact ID. |
| `--branch <entry-id>` | Branch the selected existing session from an entry. Requires `--resume` or `--session`. |

Runtime-setting precedence is explicit CLI option, resumed-session setting, matching committed provider configuration, environment, then provider default. Provider-specific committed settings are meaningful only for their configured provider.

Provider environment variables are `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL`, and `OPENROUTER_APP_TITLE`. Runtime defaults can be supplied with `AGENT_CORE_PROVIDER`, `AGENT_CORE_MODEL`, `AGENT_CORE_PROVIDER_ENDPOINT`, and `AGENT_CORE_REASONING_EFFORT`.

Credential commands are:

```bash
agent-core auth status openai
agent-core auth status openai-codex
agent-core auth login openai-codex
agent-core auth logout openai-codex
```

OpenAI Platform authentication comes from `OPENAI_API_KEY`; ChatGPT subscription authentication is stored by `auth login openai-codex` outside the workspace.
