# `@agent-core/runtime`

Run contracts, orchestration, context projection, session contracts, verification, approvals, recovery, and terminal finalization. The root export contains no filesystem persistence; import `@agent-core/runtime/node` for `JsonlSessionRepository`.

`AgentCandidateWorkspace` is the runtime contract for an isolated candidate, exact checkpoints and diffs, rollback, and prepared promotion. `prepareCandidateWorkspaceAcceptance()` adapts promotion to the durable disposition-effect boundary: an effectful disposition cannot accept before publication settles or reconciles.
