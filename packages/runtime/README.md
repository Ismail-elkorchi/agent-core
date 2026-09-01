# `@agent-core/runtime`

Run contracts, causal model windows, prompt-material assembly, the inference gateway, sessions, verification, approvals, recovery, and run finalization. The root export contains no filesystem persistence; import `@agent-core/runtime/node` for `JsonlSessionRepository`.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository isolation, checks, diffs, and publication.
