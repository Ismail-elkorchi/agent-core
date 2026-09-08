# Agent Core engineering rules

## Ownership

- Core owns reliable execution, sessions, context admission, capabilities, accounting, and recovery. Applications own domain work, requirements, verification meaning, acceptance, and workflow sequencing.
- Keep Core general: no mandatory shell, workspace, memory schema, cognitive sequence, or agent hierarchy. Applications supply configuration, capabilities, and explicit persistence locations.
- Depend on repository capabilities. Root exports provide contracts and in-memory implementations; filesystem repositories use explicit `/node` exports. Local tool implementations belong in `@agent-core/tools-local`.
- Providers use `@agent-core/model` and pass shared conformance tests. Share protocol encoding, decoding, and framing where appropriate; keep credentials, endpoint capabilities, and product policy in their adapters.

## Recorded truth

- Distinguish session, application work, run, inference invocation, tool call, and resource lifetime. Preserve causal identities across persistence, authorization, diagnostics, and replay.
- Suspended runs record their reason and continuation or recovery requirements. Ended runs have one immutable terminal snapshot.
- Finalization order is staging, session recording, then the authoritative `run.ended` commit. Session finalizations are idempotent by `finalizationId`; delivery failures cannot change terminal truth.
- Execution outcome, output completeness, verification, coverage, acceptance, and publication are independent facts.
- Enforce limits centrally with explicit budget owners and transactional reservations. New runs must not implicitly reset continuing-work allowances. Record consumed usage before terminating for a crossed limit.

## Context and observations

- Committed observations and authorized artifacts are independent of model presentations. Shortening cannot alter authoritative values or conceal incomplete coverage. Preserve integrity, redaction, and access boundaries.
- Preserve original history subject to explicit retention rules. Notes are attributed, revisioned model-authored material; they cannot grant authority, supersede user requirements, or establish verification.
- Context changes bind selected sources and representations to compiled request admission. Preserve accepted contributions, source revisions, complete accounting, and outstanding protocol obligations; reject invalid or oversized requests explicitly.
- Preserve required provider reasoning, continuation state, call identities, and configuration changes. Enforce compatibility when switching models; do not flatten native state into notes or silently discard it.

## Authority and type trust

- Validate external and persisted inputs at trust boundaries, establish owned immutable values, then trust domain types internally. Revalidate only at a new trust, revision, or authority boundary. Keep JSON capture and identity exact; presentation shortening is separate.
- Derive call-specific effects from parsed, canonical inputs before authorization. Approval binds to the exact persisted fingerprint; changed inputs, resources, definitions, effects, policy, or boundaries require matching new authorization.
- Verification is read-only unless the application explicitly grants a bounded executor. Effectful checks use the shared execution guarantees.
- Preserve driver and lease fencing, idempotency, and reconciliation. Never automatically retry a possibly executed non-idempotent effect; cancellation or timeout does not prove it did not execute.

## Changes and completion

- Use `docs/GLOSSARY.md` consistently in APIs, persisted fields, tests, and documentation, including its adapter-boundary exceptions. Name actual domain objects and transitions; prefer cohesive modules, precise types, and explicit states over defensive wrappers or casts.
- This repository is pre-alpha: replace contracts in place without backward compatibility, migrations, aliases, shims, old-format readers, or parallel legacy engines. Reject incompatible records explicitly and leave user data intact.
- Correct ownership and underlying causes. Remove dead, unused, and superseded code together with its callers, exports, configuration, dependencies, and obsolete tests; do not preserve symptoms behind larger limits or exception lists.
- Test observable guarantees and meaningful failures. Consumer tests use documented exports, not generated `dist` internals. Distinguish structural tests from live model evaluations; missing live runs prove no behavioral improvement.
- For implementation, API, build, packaging, or dependency changes, run `npm run verify:release` before delivery. For documentation-only changes, use relevant document checks. Read-only reviews need no release build. Verify required CI on exact pushed revisions when publishing changes.
- Do not commit `.agent-core`, `node_modules`, `dist`, `.tsbuildinfo`, credentials, sessions, or ledgers.
