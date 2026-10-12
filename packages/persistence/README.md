# `@agent-core/persistence`

Hash-chain contracts, exact JSON hashing, redaction, artifacts, and pathless in-memory repositories. JSON encoding and ownership belong to `@agent-core/json`; diagnostic text belongs to its `/diagnostics` subpath. Import `@agent-core/persistence/node` for local JSONL and filesystem implementations. Tool observations and observed-fact contracts belong to `@agent-core/tools`.

The event repository exposes two different operations:

- `append()` records ordinary events under the repository writer lock.
- `appendConditional()` is the control-transition primitive. It compares the exact tail sequence/hash and driver generation, binds a run-scoped idempotency key to the canonical event payload, and returns a tagged commit outcome. `tail()` and `latest()` provide bounded control recovery reads.

JSONL is the append-only authority. Per-run tail and idempotency files are derived indexes: they are written only after the ledger record is file-synced, can be discarded and rebuilt by streaming the ledger with bounded memory, and never repair or override ledger truth. Ledger files and index state use private permissions. A completed record followed by a failed index publication is reported as `committed_index_unknown`; an append failure that cannot be reconciled is `outcome_unknown`.

Writers in the same process queue by resolved file path across repository instances. The filesystem lock still excludes other processes; its acquisition timeout applies after the local writer reaches the front of the queue. Lock-release errors are reported without re-executing the operation, and a replaced lock is never removed by its previous owner.

The Node implementation claims crash consistency only for local filesystems that honor file and directory `fsync`. Node does not expose directory-entry synchronization on Windows: ledger and index file contents are synchronized there, and process-termination recovery is supported, but OS-restart and power-loss durability are not claimed for newly created or atomically replaced paths. The implementation does not claim protection against lying storage hardware, remote-filesystem cache semantics, arbitrary deletion of otherwise valid derived index files, or manual removal of a live writer's lock. Complete-record hash/sequence corruption and truncation before the indexed tail are quarantining errors; only a newline-incomplete final fragment is repairable.

Artifact publication is atomic and verified reads enforce declared size and SHA-256; JSON artifacts and verification output use the shared bounded normalizer.

`readMetadataRange()` inventories immutable source references, event type/time, original source bytes, and validated routing metadata without hydrating event payloads. It uses the same sequence indexes, filters, captured-tail checks, and scan limits as `readRange()`. Its page byte budget counts serialized metadata records; each record’s `bytes` describes the original source. Oversized descriptors are reported without advancing the cursor. Routing metadata is descriptive and does not grant authority.

Metadata-only reads trust the existing checksummed, run-bound derived indexes and bounded ledger-boundary probes. Normal cold restarts and other writers’ completed index updates need no body reads. Missing, stale, or corrupt derived indexes raise `PersistenceIndexRecoveryRequiredError`; explicitly recover the index with `JsonlEventRepository.rebuild()` (which supports cancellation and progress), then retry. Metadata reads never silently start a full-history recovery scan. Explicit source reads and integrity verification continue to validate original ledger records.

Call `tail()`, `latestReferenceOfType()`, and `referenceByKey()` with `{ metadataOnly: true }` when capturing metadata inventory boundaries. This also prevents index validation or idempotency repair from hydrating original bodies. A changed or torn stream without a matching committed index requires explicit recovery rather than an unbounded backwards scan.

Codec-declared metadata indexes use bounded sequence-number pages under the same derived index lifecycle. Declare a single-field equality index with `metadataIndexes: [{ field: 'group' }]`, or an exact predicate with `metadataIndexes: [{ type: 'checkpoint', metadata: { status: 'pending' } }]`. Declarations are validated and captured immutably when the repository is constructed. Matching metadata queries seek those pages directly and count candidate pointers against the scan limit without walking unrelated events; other filters retain ordinary bounded scanning semantics.

Exact-predicate membership starts empty with the index. A missing dynamic-field membership index conservatively requires explicit recovery, since absence cannot prove that no source was lost. Metadata never certifies authorization or complete source integrity. Index declarations are bound to the persisted tail index; changing them requires explicit recovery before metadata-only reads. Routing publication precedes the tail-index commit, so interrupted membership publication requires recovery even for a warm reader.
