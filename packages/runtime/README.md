# `@agent-core/runtime`

Run orchestration, governed inference, original history, scoped notes, conditional context windows, sessions, optional verification, approvals, recovery, and finalization. Admission uses the accounting for the exact compiled model input, including content, tools, media, protocol state, and an explicit output reservation.

The root exports contracts and in-memory repositories. Import `@agent-core/runtime/node` for `JsonlSessionRepository`, `JsonlNoteRepository`, and `JsonlInferenceRepository`. Applications supply storage locations explicitly.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository isolation, checks, diffs, and publication.

See the repository's [context composition guide](../../docs/CONTEXT.md) for service boundaries and the public tool factories.
