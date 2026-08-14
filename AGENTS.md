# Agent Core engineering invariants

## Package direction

- `@agent-core/runtime` owns run orchestration, context projection, sessions, verification, approvals, recovery, and terminal contracts.
- Runtime code depends on repository capabilities. Root exports contain contracts and in-memory repositories; filesystem persistence is isolated in `@agent-core/evidence/node` and `@agent-core/runtime/node`.
- `@agent-core/tools` contains domain-neutral tool contracts and policy. Node/workspace implementations belong in `@agent-core/tools-local`.
- Provider packages depend on `@agent-core/model` and pass the shared conformance suite. OpenAI adapters may share only dependency-light Responses framing, never credentials or product policy.
- Runnable applications own committed configuration, environment layout, and presentation. Core packages receive capabilities and explicit persistence locations.

## Runtime truth

- Stable `runId`, `finalizationId`, `turnId`, `requestAttempt`, `toolBatchId`, and call identities survive persistence, approvals, diagnostics, and replay.
- A run result is either `suspended` for a durable approval request or `ended` with one immutable terminal snapshot.
- Execution, candidate completeness, and verification are independent dimensions.
- `run.ended` is the authoritative commit marker. Session finals are idempotent projections keyed by `finalizationId`.
- Finalization order is `finalization.prepared`, session projection, then `run.ended`. Delivery failures cannot change terminal truth.
- Run limits are central. Consumed provider usage is recorded before a crossed limit terminates a run; planned tool operations are reserved transactionally.

## Verification, tools, and approvals

- Validate check definitions before execution and every observation before deriving verification.
- Required failures produce `failed`; missing or unknown required results produce `inconclusive`; advisory results never block.
- Verification is read-only unless an application explicitly grants a verification command executor.
- Tool input is parsed, canonicalized, and used to derive call-specific effects before authorization.
- Approval applies only to the exact persisted fingerprint. Changed input, resource, definition, effects, policy, or boundary requires a new request.
- Non-idempotent or uncertain side effects are never retried automatically.

## Contracts and completion

- This repository is pre-alpha. Schema version `1` means only the current schema; replace contracts in place without migrations, aliases, shims, or old-format readers.
- Consumer tests use documented exports. Do not import generated `dist` internals.
- Do not commit `.agent-core`, `node_modules`, `dist`, `.tsbuildinfo`, credentials, sessions, or ledgers.
- Before completion run `npm run verify:release`.
