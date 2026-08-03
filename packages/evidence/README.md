# `@agent-core/evidence`

Hash-chain contracts, bounded JSON-safe normalization, evidence values, and pathless in-memory repositories. Import `@agent-core/evidence/node` for local JSONL and filesystem artifact implementations.

JSONL append indexes validate once and ingest only appended bytes under the writer lock. Artifact publication is atomic and verified reads enforce declared size and SHA-256; JSON artifacts and verifier output use the shared bounded normalizer.
