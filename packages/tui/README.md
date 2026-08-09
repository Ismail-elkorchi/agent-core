# `@agent-core/tui`

Agent Core's terminal user interface. It renders runtime progress, approvals, tool activity, terminal outcomes, and interactive commands on top of `@ismail-elkorchi/terminal-ui`.

The package consumes an `AgentRuntime`; it does not own CLI configuration, provider selection, workspace layout, repository construction, or local tool-host composition. `@agent-core/cli` remains the executable entry point and supplies those dependencies.
