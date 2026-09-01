# Usage

Agent Core is a set of composable packages rather than an executable application. Applications select model providers, tools, authorization policy, checks, persistence repositories, and presentation.

Use package root exports for platform-neutral contracts. Filesystem repositories are exposed only through `@agent-core/runtime/node` and `@agent-core/persistence/node`. Node and workspace tool implementations are exposed by `@agent-core/tools-local`.

The first runnable application is maintained in [Ismail-elkorchi/agents](https://github.com/Ismail-elkorchi/agents). Its command-line options, configuration, workspace layout, authentication commands, and terminal interface are documented there.
