# @agent-core/tools-local

Node-specific workspace tools: bounded search and reads, directory inspection, atomic patching, shell execution, and process-tree control. Generic contracts, policy, authorization, observations, and registries live in `@agent-core/tools`.

The first-party coding surface is `list_directory`, `find_files`, `read_files`, `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `stop_process`, `view_image`, and `read_artifact`. Workspace paths and call-specific resource accesses are canonicalized before authorization. Process ownership and patch recovery are managed by shared services.

`exec_command` is ambient local shell execution, not shell isolation. It inherits the Agent Core process's file, network, and child-process authority. A persistent command holds the conservative `workspace/files` lease, so conflicting workspace tools wait until that process exits or is stopped.
