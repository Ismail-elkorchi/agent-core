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
agent-core approval allow RUN_ID APPROVAL_ID FINGERPRINT --root . --config agent-core.config.json
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
