# Terminal presentation

Shared terminal presentation for the application adapters. `MarkdownDocument` retains a markspan GFM document session and a width-specific presentation. Source offsets are half-open UTF-16 ranges; generated labels have no source range. Copying original Markdown, displayed text, and normalized code are separate operations.

Links expose only HTTP, HTTPS, and mail destinations and never open automatically. HTML and images remain literal descriptions. Parser resource errors leave the exact source accessible. Syntax highlighting uses Prism's token API; unsupported languages remain plain code.

Import reusable components from `@agent-core/tui` and external-editor and explicit browser-launch integration from `@agent-core/tui/node`. Applications own policy and session lifetime. Components use the consumer's terminal-ui peer instance; install local file dependencies as packages rather than symlinking across independently installed terminal-ui copies.

Shared components also provide source-selection copying, session-state inspection, history bookmarks, and retained list elements and renderer-derived navigation geometry. Source text stays exact in memory and storage. Clipboard transport preserves the selected source, including tabs and line endings.

Configuration can open directly at provider, model, reasoning, or authentication. Components consume provider discovery/authentication capabilities and a single validated save operation. Conversation projections preserve run/turn/call identity; draft, queue, recall, source, context, and settings components remain caller-controlled. Applications supply optional attachment readers, resource search, session names, export, and notifications. Node integrations keep private presentation preferences and unsent drafts separate from accepted history.

On shutdown, `saveDrafts` attempts every supplied session draft before reporting any failed writes together. Applications select the drafts, with the active composer replacing its cached session entry.

Resource suggestions supply literal `reference` values. Shared completion owns quoting, complete reference replacement, caret placement, and undo. Set `continueSearch` for a selectable scope such as a directory; `acceptResource` then returns the next completion to pass to `searchResources` along with the updated input.

Resource search returns `items` and explicit `coverage`. The picker labels partial results and does not describe an empty partial search as exhaustive absence.


Tool activities distinguish invocation completion from domain outcome. `projectProgress` and `projectSessionEntry` accept an optional tool renderer after the call-presentation callback; renderers receive structured observations. Generic results use a neutral completed state, failures retain invocation-failure state, and executor uncertainty remains visible. A renderer exception produces a display diagnostic and bounded raw inspection without changing execution truth or model input. The optional `localToolCallPresentation` and `renderLocalToolObservation` adapters from `@agent-core/tools-local` render local source, search, process, and mutation results.

`queuePanel`, `configurationPanel`, and `sourceInspectorPanel` return terminal-ui child definitions. Compose them with `createTuiChild`, retain the returned child state in the application's aggregate state, route one scoped envelope, and consume their explicit domain outputs. Removing a child cancels its scoped work; hiding a queued mutation retains the child until its outcome is delivered and the application has recovered the draft or reported the failure. The stateless `mountPanel` and `applyPanelResult` functions share generation allocation and modal result grafting for applications with a `panelGeneration` counter and an `overlay`. They forward the whole scoped result without inspecting opaque work contributions and do not retain state or interpret outputs. Reconcile removed lifetimes directly with terminal-ui's `reconcileTuiChildren` and combine its contribution with the update using `combineTuiResults(finalState, ...results)`. Pass all retained children to reconciliation, including hidden saving queues, and forward each retained child's opaque subscription handles from the parent. Consume `close`, `saved`, and queue outputs explicitly; session, approval, visibility, refresh, and draft recovery decisions remain application-owned.

`applicationEventSource` attaches application subscriptions inside the existing runtime's source lifetime. Its sink owns admission, reliable delivery, replacement, and backpressure. Startup runs after attachment; removal detaches the producer. There is no separate pre-attachment message queue. The application still owns service shutdown and any terminal host it created.

Prompt recall owns one search index per entry snapshot and prepares queries through the parent's replaceable effect lifecycle. `createPromptRecall`, `appendRecalledDrafts`, `updatePromptRecall`, and `receivePromptRecallQuery` return state-and-effect results: retain `result.state`, forward `result.effects` and `result.cancel`, and route `recall.query` messages back to `receivePromptRecallQuery`. Retain the recall instance ID so a closed or reopened overlay rejects late completions, and cancel `prompt-recall-query` and `recovered-drafts` when removing it. The editor remains available during preparation and after an error; query results only apply to their exact owned index and query.

`conversationEntryView` shares role labels, reasoning disclosure, interrupted-output labels and tool details across applications. `responsiveStatusline` fits complete configured fields, prioritizing authority and activity. The activity clock measures display elapsed time only; runtime events remain authoritative for execution and accounting. Context inspection exposes the effective source selection, including exchanges after the last explicit transition; Apply selection uses the existing transition without forcing renewal. Correlated unchanged, committed, and rejected outcomes settle pending actions; unchanged updates do not claim a new window. Runtime-selected fresh context uses the selected originals and latest state, while compatible updates preserve continuation.

External editor commands (`VISUAL`, then `EDITOR`) must remain running until all
of their editor children have finished; use a GUI editor's `--wait` option where
needed. Wrappers that wait for their editor are supported, but daemonizing or
explicitly disowning processes is not. Editors inherit the real foreground
terminal without starting a detached session. Cancellation waits for the owned
wrapper/editor tree to exit before releasing the terminal or deleting its draft.
POSIX cancellation requires standard `ps`; Windows uses `taskkill /T /F`.
