# Offline application evaluation

The real-task evaluator lives in `../agents/validation`, not in Core. Run its
`qualify-evaluation.mjs` for a paired, local scripted-provider qualification.
Core supplies execution, accounting and recovery; acceptance belongs to that
application evaluator. No benchmark-specific runtime or provider is installed
in Core.

Use exact Core and Agents build revisions when comparing prior continuation,
selective continuation and narrative session state. See the Agents validation
README for preparation, sandbox requirements, task provenance and reports.

## Measurements to preserve

- `run.configured` identifies effective model, generation, tool and permission
  configuration. `model.requested` carries admission **estimates**, not receipts.
- `context.transitioned` distinguishes `fresh` and `append`;
  `context.transition.unchanged` is neither. A successful task without a fresh
  transition says nothing about renewal quality.
- Terminal `budget` records consumed run usage, including a crossed limit.
  It is not independent acceptance and does not establish provider charges.
- Inference owner events record invocation identity, purpose, reservations,
  settlement `usageSource` (`provider` or `estimate`), unknown costs and uncertain
  outcomes. Keep them rather than presenting absent measurements as zero.
- Continuing work uses the same inference owner. A new run ID must not imply
  a new allowance. `evaluation-accounting-contract.test.js` exercises the
  public contracts across primary and context-recovery invocation purposes.

The Coding Agent CLI currently exposes run limits, not configuration of the
session inference budget. The evaluator partitions its task allowance among
scripted runs and also bounds provider requests; it does not substitute a
second inference accounting engine. A provider invocation can incur charges
before usage is reported. Known-cost limits with missing prices cannot provide
a hard monetary guarantee. The current evaluator therefore rejects paid
execution; a qualified external prepaid/provider-enforced limit is still needed.

Deterministic gates include `tests/context-recovery-accounting.test.js`,
`tests/shared-inference-budget.test.js`, `tests/native-context-renewal.test.js`
and `tests/evaluation-accounting-contract.test.js`. These qualify mechanics,
not live model quality.
