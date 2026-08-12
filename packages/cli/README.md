# `@agent-core/cli`

Agent Core command-line entry point. The terminal UI implementation lives in `@agent-core/tui`; this package composes it with committed workspace configuration, providers, repositories, and the local tool host.

`agent-core [task]` opens the TUI, optionally starting with the supplied task. `agent-core exec <task|->` runs once without a TUI. `agent-core auth` manages provider credentials, and `agent-core approval` resolves an exact persisted approval after restart.

See the [usage guide](../../docs/USAGE.md) for the complete command, option, configuration, environment, authorization, and authentication reference.
