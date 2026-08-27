# @agent-core/tools-local

Optional Node-local capabilities for Agent Core applications: bounded search and reads, directory inspection, atomic text patching, process execution, image loading, and artifact access. Generic contracts, policy, authorization, observations, and registries live in `@agent-core/tools`.

Applications explicitly select from `list_directory`, `find_files`, `read_files`, `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `stop_process`, `view_image`, and `read_artifact`.

Workspace file tools consume an adopted `WorkspaceFileRoot`, not an ambient path string. The root rejects aliases, multiply linked files, nested mounts, special files, `.git`, and application-private names. Reads and mutations stay relative to held directory authority even if another process replaces a pathname. `apply_patch` additionally requires a separately adopted `TextPatchJournal`; its directory must already exist, overwrite and delete plans bind both the source identity and its SHA-256 value, and the journal retains checksummed recovery receipts outside the generic workspace file namespace. `createLocalToolHost()` accepts the application-owned artifact repository and adopted patch journal directly; it does not derive either authority from path strings. Close the host and root capability when their application lifetime ends.

The handle-relative implementation currently requires Linux `/proc`. `WorkspaceFileRoot.adopt()` fails on platforms where the package cannot provide the same confinement contract. This is an explicit availability boundary, not a weaker portable mode.

`exec_command` is ambient local shell execution, not shell isolation. It inherits the Agent Core process's file, network, and child-process authority. A persistent command holds the conservative `workspace/files` lease, so conflicting workspace tools wait until that process exits or is stopped.
