# `@agent-core/cli`

Agent Core command-line and TUI entry point. It presents execution, candidate completeness, model termination, verification, advisory checks, and delivery diagnostics independently.

Use `--config agent-core.config.json` for committed workspace settings. The default coding surface exposes structured list/read/search plus patch and shell tools. Interactive modes present Allow/Deny approval choices; noninteractive suspension exits `7`, and `agent-core approval` resolves the exact persisted fingerprint after restart.
