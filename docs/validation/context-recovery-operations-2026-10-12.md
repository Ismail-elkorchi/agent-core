# Context recovery operation counts

## Scope

These are structural tests and operation counts, not live-model evaluations, latency benchmarks, or evidence of better model decisions. No paid model calls were made.

The comparison isolates the context implementation at `7165a62` from the working-tree changes. The earlier runtime, context service, event codec, and request-admission modules were transpiled into an isolated temporary package. Both sides used the same built dependencies and repaired JSONL index implementation. The public-export fixtures and inputs were otherwise unchanged; baseline measurement assertions were disabled so their actual counters could be recorded.

## Fixed active selection, growing released archive

Each fixture retains two active sources after an explicit source transition. One check consists of `assertSourceCapacity()` followed by `capacityFeedback()`. Cold measurements open a new `JsonlSessionRepository` over an existing persisted index. Warm measurements repeat the pair at the same immutable source cut.

The following counts were identical for archive sizes 100, 1,000, and 10,000:

| Operation | Earlier cold | Updated cold | Earlier warm | Updated warm |
| --- | ---: | ---: | ---: | ---: |
| Active metadata pages | 2 | 1 | 2 | 0 |
| Scanned active metadata records | 6 | 3 | 6 | 0 |
| Selected context-record body reads | 4 | 2 | 4 | 0 |
| Archived source-body reads | 0 | 0 | 0 | 0 |
| Original JSONL bytes scanned | 0 | 0 | 0 | 0 |

Cold index restoration still scales with archive metadata. This work was not eliminated or hidden by the active-selection cache:

| Released archive | Indexed source entries | Cold metadata checkpoints | Earlier metadata bytes | Updated metadata bytes |
| --- | ---: | ---: | ---: | ---: |
| 100 | 103 | 104 | 224,962 | 224,962 |
| 1,000 | 1,003 | 1,004 | 2,193,836 | 2,191,828 |
| 10,000 | 10,003 | 10,004 | 21,970,368 | 21,990,376 |

The fixtures and storage stamps were generated independently, so these byte differences are not a claimed reduction in index size. Both sides read the entire metadata index once on cold reopen and read zero additional metadata-index bytes/checkpoints on warm repetition. Updated cold reads only two copies of the current selection record: 2,052 / 2,054 / 2,056 body bytes respectively. Warm body reads are zero.

The in-memory fixture independently records the same page/scanned-count reduction. It also verifies that a new source cut invalidates the cache and that changed protected-source policy is freshly applied even when source facts are reused. These in-memory counts exclude repository/index initialization.

## Ordinary request preparation

Three ordinary turns with a deterministic provider and unchanged model capabilities produced:

| Operation | Earlier | Updated |
| --- | ---: | ---: |
| Ordinary compilations | 3 | 3 |
| Bounded control compilations | 3 | 3 |
| Durable recovery-attempt metadata queries | 3 | 0 |
| Bounded inventory inspections | 3 | 3 |
| Unpaged active-context inspections | 3 | 0 |

No general reduction in provider compilation count is claimed. New ordinary boundaries still compile their current control reserve. Recovery-attempt accounting is now read only when entering recovery and is indexed to the unchanged boundary; six successful recovery boundaries do not scan earlier successful boundaries.

## Regression coverage

- `tests/context-recovery-work.test.js`: public-history and real JSONL cold/warm counts at 100 / 1,000 / 10,000 archived sources
- `tests/context-recovery.test.js`: visible required reserve, mandatory-source safety, four distinct rejected selections at one stable boundary, and ordinary preparation counts
- `tests/context-recovery-accounting.test.js`: exact retry candidate/accounting, owner-budgeted successful recoveries, durable no-progress limits, failed-attempt crash safety, and settled-control restart instruction restoration

Run these with `node --test tests/context-recovery-work.test.js tests/context-recovery.test.js tests/context-recovery-accounting.test.js` after building. Repository-wide validation remains a separate gate.
