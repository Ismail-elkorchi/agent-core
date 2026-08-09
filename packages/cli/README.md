# `@agent-core/cli`

Agent Core command-line entry point. The terminal UI implementation lives in `@agent-core/tui`; this package composes it with committed workspace configuration, providers, repositories, and the local tool host.

Use `--config agent-core.config.json` for committed workspace settings. The default coding surface exposes structured list/read/search plus patch and shell tools. Interactive modes present Allow/Deny approval choices; noninteractive suspension exits `7`, and `agent-core approval` resolves the exact persisted fingerprint after restart.

`--apply` authorizes the full structured patch surface: add, update, move, and delete. `--allow-shell` is separate ambient process authority. It can indirectly read, write, or delete files, access the network, and start child processes even when structured patch writes are disabled. Persistent ambient processes block conflicting workspace tools until they exit or stop.
