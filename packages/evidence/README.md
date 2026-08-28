# `@agent-core/evidence`

Hash-chain contracts, bounded JSON-safe normalization, evidence values, and pathless in-memory repositories. Import `@agent-core/evidence/node` for local JSONL and filesystem artifact implementations.

The event repository exposes two different operations:

- `append()` records ordinary audit evidence under the repository writer lock.
- `appendConditional()` is the control-transition primitive. It compares the exact tail sequence/hash and driver generation, binds a run-scoped idempotency key to the canonical event payload, and returns a tagged commit outcome. `tail()` and `latest()` provide bounded control recovery reads.

JSONL is the append-only authority. Per-run tail and idempotency files are derived indexes: they are written only after the ledger record is file-synced, can be discarded and rebuilt by streaming the ledger with bounded memory, and never repair or override ledger truth. Ledger files and index state use private permissions. A completed record followed by a failed index publication is reported as `committed_index_unknown`; an append failure that cannot be reconciled is `outcome_unknown`.

The Node implementation claims crash consistency only for local filesystems that honor file and directory `fsync`. Node does not expose directory-entry synchronization on Windows: ledger and index file contents are synchronized there, and process-termination recovery is supported, but OS-restart and power-loss durability are not claimed for newly created or atomically replaced paths. The implementation does not claim protection against lying storage hardware, remote-filesystem cache semantics, arbitrary deletion of otherwise valid derived index files, or manual removal of a live writer's lock. Complete-record hash/sequence corruption and truncation before the indexed tail are quarantining errors; only a newline-incomplete final fragment is repairable.

Artifact publication is atomic and verified reads enforce declared size and SHA-256; JSON artifacts and verifier output use the shared bounded normalizer.
