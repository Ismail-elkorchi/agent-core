# @agent-core/tools-local

Optional Node-local capabilities for Agent Core applications: bounded search and reads, directory inspection, atomic text patching, process execution, image loading, and artifact access. Generic contracts, policy, authorization, observations, and registries live in `@agent-core/tools`.

Applications explicitly select from `list_directory`, `find_files`, `read_files`, `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `stop_process`, `view_image`, and `read_artifact`. Workspace paths and call-specific resource accesses are canonicalized before authorization. Process ownership and patch recovery are managed by shared services when those capabilities are configured.

`exec_command` is ambient local shell execution, not shell isolation. It inherits the Agent Core process's file, network, and child-process authority. A persistent command holds the conservative `workspace/files` lease, so conflicting workspace tools wait until that process exits or is stopped.
