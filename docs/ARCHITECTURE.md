# Architecture

Agent Core is an application-neutral substrate. `@agent-core/runtime` owns orchestration, model-window assembly, sessions, verification, approvals, recovery, and terminal contracts. It depends on repository capabilities rather than filesystem paths.

`@agent-core/model` owns provider-neutral model contracts. Provider packages adapt external transports and decode their outputs before returning owned model values. `@agent-core/tools` owns domain-neutral tool definitions, effects, authorization, scheduling, observations, and registries. `@agent-core/tools-local` supplies optional Node and workspace implementations without making them runtime defaults.

Persistence contracts live at package roots. Filesystem implementations are isolated in `@agent-core/runtime/node` and `@agent-core/persistence/node`. Applications own provider selection, tool composition, configuration, environment layout, presentation, and product policy.
