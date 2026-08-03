# `@agent-core/auth`

Provider-neutral bearer-token sources and local credential storage capabilities. Credentials are application/runtime state and are never written to workspace ledgers or package archives.

Provider adapters receive capability interfaces rather than workspace credential paths; automated tests use fake sources and never live credentials.
