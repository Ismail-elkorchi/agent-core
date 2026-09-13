# Terminal presentation

Shared terminal presentation for the application adapters. `MarkdownDocument` retains a markspan GFM document session and a width-specific presentation. Source offsets are half-open UTF-16 ranges; generated labels have no source range. Copying original Markdown, displayed text, and normalized code are separate operations.

Links expose only HTTP, HTTPS, and mail destinations and never open automatically. HTML and images remain literal descriptions. Parser resource errors leave the exact source accessible. Syntax highlighting uses Prism's token API; unsupported languages remain plain code.

Import reusable components from `@agent-core/tui` and external-editor integration from `@agent-core/tui/node`. Applications own policy and session lifetime. Components use the consumer's terminal-ui peer instance; install local file dependencies as packages rather than symlinking across independently installed terminal-ui copies.

Shared components also provide source-selection copying, attributed note paging, history bookmarks, and retained list measurements. Source text stays exact in memory and storage. The installed clipboard API normalizes some text; exact-copy requests detect and report this limitation instead of sending altered content.

Configuration components consume provider discovery/authentication capabilities and a single validated save operation. Conversation projections preserve run/turn/call identity; draft, queue, recall, source, notes, and settings components remain caller-controlled. Applications supply optional attachment readers, resource search, session names, export, and notifications. Node integrations keep private presentation preferences and unsent drafts separate from accepted history.
