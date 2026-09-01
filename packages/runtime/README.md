# `@agent-core/runtime`

Run contracts, causal model windows, prompt-material assembly, the inference gateway, sessions, verification, approvals, recovery, and run finalization. Before transport, the gateway applies a model-profile-aware request-fit check covering messages, tool and response schemas, the model input limit, and output reserve. The root export contains no filesystem persistence; import `@agent-core/runtime/node` for `JsonlSessionRepository`.

Application-owned working copies and publication policy do not belong to this package. Core records effect truth and finalizes runs; Coding Agent owns repository isolation, checks, diffs, and publication.
