# `@agent-core/cli`

Agent Core command-line entry point. The terminal UI implementation lives in `@agent-core/tui`; this package composes it with committed workspace configuration, providers, repositories, and the local tool host.

`agent-core [task]` opens the TUI, optionally starting with the supplied task. `agent-core exec <task|->` runs once without a TUI. `agent-core auth` manages provider credentials, and `agent-core approval` resolves an exact persisted approval after restart.

Use `--config agent-core.config.json` for committed provider, model, instruction, tool, authorization, verification, and run-limit settings. Session selection is invocation state: omit session options for a new session, use `--resume` for the most recently active workspace session, or use `--session <id>` for an existing session.

CLI values override resumed-session settings, committed configuration, environment values, and defaults. A project configuration may narrow authority but cannot elevate the invocation. `--apply` authorizes structured mutation, while `--dry-run` authorizes validation without mutation. `--allow-shell` grants separate ambient process authority and is required for configured command checks. Ambient execution can indirectly read, write, or delete files, access the network, and start child processes. Persistent processes block conflicting workspace tools until they exit or stop.
