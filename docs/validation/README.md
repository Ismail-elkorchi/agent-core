# Context redesign measurements, 2026-09-08

The `redesign-*.json` reports separate real endpoint activity from the historical policy simulation. No report establishes a winning memory policy.

- `redesign-live-availability-2026-09-08.json`: the configured Astra deployment has no trusted profile in the current Codex adapter. No generation was attempted. The implementation does not infer adapter capabilities from model names.
- `redesign-supported-model-availability-2026-09-08.json`: a bounded eight-invocation probe confirmed actual responses from `gpt-5.6-sol`. The invocation ceiling and trial deadline prevented a policy comparison.
- `redesign-model-comparison-2026-09-08.json`: twelve matched trials compared retained history, history retrieval and model notes on two authored workloads, with two trials per workload/policy. There were 202 attempted invocations. Every trial reached the declared 60-second deadline before completing both checkpoints. All quality gates are inconclusive. The adapter declared no native transform for this endpoint/model, so that strategy was unavailable.

Original constraints, explicit corrections, side questions and replacement tasks appeared in the workloads. The reports retain failures, partial checkpoints, observed token usage, retrieval/note counts, latency, uncertain invocations and unknown dollar costs. Two samples per comparison are below the predeclared ten-trial quality gate. An opaque deployment alias is not an immutable model-version pin.

These development measurements recorded the base commit, dirty status and exact runner/workload hashes. Source edits continued during the redesign, so they do not certify the final release revision. Subsequent reports also record an implementation source-tree hash. Structural release tests and exact pushed CI revisions establish implementation guarantees separately.

The Agents repository contains an independent development runner for actual Coding and Writing compositions. Its live review and proposal-correction reports do not substitute for mutation/publication, concurrency or crash measurements. Those guarantees are exercised by deterministic fault and conformance tests; live measurements remain explicitly unmeasured where absent.
