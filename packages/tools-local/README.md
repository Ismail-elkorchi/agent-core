# @agent-core/tools-local

Node-specific workspace tools: bounded search and reads, directory inspection, atomic patching, shell execution, and process-tree control. Generic contracts, policy, authorization, observations, and registries live in `@agent-core/tools`.

The first-party coding surface is `list_directory_tree`, `read_text_files`, `search_file_text`, `apply_patch`, and `shell_command`. Patch and shell cleanup are explicit lifecycle machines; canonical workspace paths and call-specific scopes are computed before authorization.
