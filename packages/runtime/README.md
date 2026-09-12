# `@agent-core/runtime`

Run orchestration, governed inference, original history, scoped notes, conditional context windows, sessions, approvals, recovery, and finalization. Admission uses the accounting for the exact compiled model input, including content, tools, media, protocol state, and an explicit output reservation.

The root exports contracts and in-memory repositories. Import `@agent-core/runtime/node` for `JsonlSessionRepository`, `JsonlNoteRepository`, and `JsonlInferenceRepository`. Applications supply storage locations explicitly.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository isolation, checks, diffs, and publication.

`EffectExecutionEvent` requires an observation for a settled state with a known outcome and forbids observations on other states. The event decoder verifies the observation's digest against the settlement before repository consumers use it.

See the repository's [context composition guide](../../docs/CONTEXT.md) for service boundaries and the public tool factories.

Work budgets are opt-in: applications may bound turns, tool calls, elapsed time, tokens, and cost. Defaults cover execution capacity, not task duration or a failure streak. Accounting continues without a configured budget. Context selection can omit settled exchanges within an active run while preserving original history, current input, and pending protocol obligations. Provider-native transforms may represent settled active exchanges when supported.

`AgentSession.close()` stops scheduling, interrupts the active run, and waits for its settlement. Queued submissions and suspended outcomes stay recorded for a new session instance; closing does not dispatch queued work or retry unknown effects.
