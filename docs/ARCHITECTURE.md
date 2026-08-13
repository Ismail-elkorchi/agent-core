# Architecture

Agent Core has one runtime authority and capability-based boundaries.

```text
model ───────────────► providers
  ▲
  │
runtime ◄──── tools ◄──── tools-local
  │
  ├──── evidence contracts
  │          ▲
  └──── CLI ─┬──── evidence/node persistence
             └──── runtime/node session persistence
```

`@agent-core/runtime` owns one task execution (`run`), its model turns, context, session projection, verification, approval suspension, recovery, and terminal snapshot. `@agent-core/cli` owns workspace configuration and local runtime layout. Core consumers receive repository capabilities and do not infer storage from paths.

## Runtime state

A run moves through `preparing`, `requesting_model`, `executing_tools`, `waiting_for_approval`, `verifying`, `finalizing`, and `ended`. Stable run, finalization, turn, request-attempt, batch, and call identities make retries and recovery explicit.

The public result is discriminated:

```ts
type AgentRunResult =
  | { state: 'suspended'; reason: 'approval_required'; runId: string; pendingApprovals: readonly AgentApprovalRequest[] }
  | { state: 'ended'; terminal: AgentTerminalSnapshot; deliveryDiagnostics: readonly AgentDeliveryDiagnostic[] };
```

Execution status, candidate status, and verification status are independent. A stream failure may preserve a partial candidate without running verification; an output limit may be a completed execution with a partial candidate.

## Persistence and terminal authority

The finalization sequence is:

1. persist `finalization.prepared`;
2. project the same immutable decision into the session;
3. persist authoritative `run.ended`;
4. notify delivery observers.

Replay ignores an uncommitted session projection. Repeated identical finalization returns the same promise; a conflicting decision is rejected before writing. Delivery failures are diagnostics and cannot erase terminal truth.

`@agent-core/evidence` exports contracts, JSON normalization, evidence values, hash-chain primitives, and in-memory repositories without filesystem imports. `@agent-core/evidence/node` adds JSONL and content-addressed local repositories. Likewise, `@agent-core/runtime` exports session contracts and its in-memory repository, while `@agent-core/runtime/node` adds JSONL session persistence. Local readers tolerate one incomplete trailing record and reject committed corruption with location details.

## Tools, approvals, and verification

Tool execution is parse → canonicalize → derive effects → authorize → execute → normalize → persist. Authorization is per call. An approval binds canonical input, resources, tool implementation, effects, policy, execution boundary, and fingerprint; `AgentSession.resolveApproval()` reconstructs the exact persisted batch and never repeats an uncertain non-idempotent effect.

Checks receive a present candidate, provenance-bearing instructions, read-only evidence, metadata, and an abort signal. Required failed checks produce `failed`; missing or unknown required checks produce `inconclusive`; advisory checks remain visible without blocking.

Provider profiles, requests, responses, streams, usage, tool calls, continuation state, and retry disposition are validated at the provider boundary. Provider-specific credentials and product policy stay in each adapter.
