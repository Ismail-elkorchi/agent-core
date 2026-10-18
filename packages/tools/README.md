# `@agent-core/tools`

Domain-neutral tool definitions, effects, per-call authorization, policy, validation, registries, observations, and tool-owned model content. Node-local implementations live in `@agent-core/tools-local`.

The runtime boundary is decode → canonicalize → derive call-specific effects → authorize → invoke → validate output → persist. Effects contain resource accesses, scheduling locks, dependencies, and capability-specific recovery proof. Missing proof is `unknown`; it never grants replay authority. Authorization applies to the exact persisted fingerprint.

`defineTool` is authoritative typed construction, including the owned JSON snapshot used for authorization and audit hashing. `ToolRegistry.register()` preserves authored definition identity. Independently implemented or dynamically loaded definitions cross the explicit `adoptToolDefinition()` boundary before registration.

Every compiled definition exposes `outputJsonSchema`, an immutable, serializable JSON Schema generated from the same `outputSchema` validator used when an observation enters Core. Output defaults remain required in this contract. Unsupported transforms and unbounded `z.unknown()`/`z.any()` result declarations are rejected; use an explicit JSON result schema. Adoption checks a supplied portable contract against its validator. `toolDefinitionHash()` binds input and output contracts, effects, requirements, and invocation modes for discovery, request admission, and authorization.

`invocationModes` defaults to `['direct']`. Programmatic calls require explicit `['direct', 'programmatic']` or `['programmatic']` eligibility. The host records local parent/program identity or genuine provider-program provenance in `ToolInvocationContext.caller`; caller identity is part of authorization and cannot change before invocation or recovery.

Tool calls cross `createToolCall()` for typed construction or `decodeToolCall()` for external data. Planning accepts only that owned call and does not decode it again.

`CommandExecution` is the behavior boundary for starting, querying, controlling, recovering, and cleaning command executions. The runtime and tools do not require a concrete process manager. An application supplies an implementation with a versioned implementation identity and a stable recovery-store identity; unsupported recovery remains explicit rather than authorizing replay. Uncertainty acceptance binds process identity and the exact observation revision, so a stale decision cannot acknowledge new evidence.

`start()` distinguishes a dispatched command from a proven `not_started` refusal. Exceptions after dispatch can remain uncertain. `listProcesses()` includes authority-wide unresolved records, whose owner may be unavailable. A terminal report remains retained until its original owner durably records and acknowledges it. Reports already committed by an executor carry `settlementReference`; consumers reuse that event. Run-owned resources are released by the runtime; applications explicitly release resources with a longer owner lifetime.


`WorkspaceFiles` describes an adopted file authority independently of any host path or environment provider: normalized relative paths, incremental directory entries, bounded exact reads with revisions, and conditional transactions. Applications supply confinement, concurrency, epoch fencing, and lifetime ownership. Core does not select or initialize an environment.


Observations use `kind: 'result' | 'failure'` for invocation disposition. Their structured `output` owns domain outcomes; a nonzero process exit, a partial read, and a failed application check can each be a returned result. Effectful tools report executor facts with `execution.state`: `not_started`, `settled`, `active`, or `unknown`. An active process retains its own owner and lease after its invocation returns. Missing executor facts for an effectful call cannot establish settlement. A thrown failure from a call whose authorized accesses are all reads is a settled invocation failure, not an unconfirmed mutation; it does not establish successful retrieval or authorize replay. Failures carry a precise `reason` and relevant details; there is no generic success flag or required retry prose.

`buildModelContent({ call, input, observation })` optionally returns ordinary `ToolContent[]` (text, image, or artifact parts). Plain tools use the structured output fallback. Source tools return the requested original range and usable continuation handles. Content construction has no separate immediate/retained token budgets; compiled request accounting governs admission. UI renderers consume structured observations independently.

`createReadArtifactTool({ maxReadBytes })` composes `read_artifact` over the host's `artifactRepository` service without local files or local-tool configuration. Supply an explicit positive safe-integer read limit; omitted or larger requested ranges use that limit. Repository-verified UTF-8 ranges may expand to complete boundary code points. Public lookup, artifact-specific authorization, range coverage and continuation offsets are preserved; protected artifacts cannot be looked up by this tool. Complete images remain image content and partial images remain artifact references.

## Revisioned discovery and loading

`ToolCatalog` owns eager definitions and configured `ToolCatalogSource` adapters. A source returns a bounded `ToolSourceSnapshot` of descriptors and resolves an exact `ToolReference` into a compiled definition. `describeCatalogTool()` binds the reference revision to `toolDefinitionHash()`; `captureToolSourceSnapshot()` validates the source/binding identity and owns the snapshot. Connection or authority changes require a different `bindingRevision`.

`discover()` pages either inventory metadata or the complete exact selected-reference list using `target: 'inventory' | 'selection'` and returns bounded literal-search metadata with inventory and selection revisions, paging, loaded flags, and explicit unavailable sources/references. It does not load implementations or grant invocation authority. `select()` replaces the complete selection (an empty array clears it) and requires exact references, the expected branch owner and selection revision, and an idempotent operation identity. It checks definition identity and name collisions before conditional selection publication. Host composition can reserve its own control names with `reserveNames()`; names never grant authority.

Selected references persist through a `ToolCatalogSelectionStore`; standalone catalogs default to an explicit in-memory store. Ordinary refresh contacts only sources referenced by the current selection; inventory discovery explicitly contacts all configured sources, and selection also validates newly requested sources. Snapshot work uses at most `TOOL_CATALOG_LIMITS.sourceConcurrency` simultaneous sources and publishes only a completed, uncancelled refresh. A subsequent refresh reloads only exact recorded references. Missing, changed, or disconnected definitions remain recorded as unavailable and cannot start calls. Catalog refresh and source loading support cancellation, including an adapter that does not promptly honor its signal. Transport timeouts, failure backoff, lifetimes and permission changes remain adapter/host responsibilities.

External JSON Schema contracts use `defineJsonSchema(schema, compileValidator)`. The
compiler receives the immutable captured schema and returns a synchronous validator
that reports issues or `undefined`. The same schema is emitted for input and output;
no Zod reconstruction can erase its assertions. Nested schemas retain local JSON
pointer references through owned definitions. Remote references, separate `$id`
resources and dynamic anchors are rejected. Validation compilers remain host-authored
capabilities, never code supplied by external catalog data.

`embedJsonSchema(schema, path)` preserves those same portable-reference rules when
an author wraps an exact schema in a larger result contract. The path is an array
of property names from the new schema root, such as `['$defs', 'toolOutput']`.
Names are JSON-pointer escaped; only schema-position references are rebased.
Literal `const`, `enum`, `default`, and `examples` data remains unchanged.
