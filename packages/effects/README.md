# @agent-core/effects

Domain-neutral contracts for repeat-sensitive external work. Recovery is capability-specific: changing reads require captured preconditions, queryable work requires an external execution identity and retained query authority, idempotency requires a parameter-bound service key and expiry, and journal-backed mutations identify their reconciliation authority. Missing proof is represented as `unknown`; it is never treated as replay permission.

The package also defines the pure one-shot ticket and exact-settlement state machine consumed by the durable runtime. It does not execute effects, store operation state, or provide a general transaction or compensation framework.
