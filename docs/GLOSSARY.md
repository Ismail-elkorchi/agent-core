# Domain glossary

These terms are part of Agent Core's public and persisted contract. New APIs,
events, state fields, and documentation use them consistently.

| Term | Meaning |
| --- | --- |
| **run** | One admitted agent execution from task input to suspension or finalization. Core does not call this an operation. |
| **model output** | Content returned by a model invocation. `candidate` is not a Core synonym. |
| **context window** | A committed selection of session history and derived artifacts. It can span many completed runs; run completion does not evict history. |
| **history position** | A branch boundary and the exact committed source records visible at that boundary. Independent run ledgers do not share a fabricated global sequence. |
| **history selection** | Explicit original-source and derived-artifact references retained for inference, with bounded retrieval of omitted material. |
| **model note** | Attributed, revisioned model-authored text or structured data. A note is neither user authority nor a verification result. |
| **context transition** | A conditional change to selected original sources and note revisions. Idle changes record selection intent; actual inference admission checks the captured request's fit and protocol obligations. |
| **prompt material** | Typed application or runtime material available to the request assembler. |
| **logical model request** | Provider-neutral request assembled by Core before wire serialization. |
| **compiled model request** | The immutable provider input admitted for invocation, with its capability revision and accounting. Credentials are transport configuration, not persisted input. |
| **request accounting** | Complete component accounting for a compiled input, identifying estimates and unknown costs separately from exact counts. |
| **provider context state** | Versioned, provider-bound continuation or reasoning material with explicit compatibility and replay rules. It is separate from public history and notes. |
| **inference invocation** | One governed model operation with captured input, budget, cancellation, and durable settlement or explicit uncertainty. It need not be an interactive agent run. |
| **request fingerprint** | Stable identity of the logical request and the inputs that produced it. It is not proof of provider-visible bytes. |
| **observation** | Recorded tool or effect facts. Invocation disposition, execution state, domain outcome, and output completeness remain distinct; a returned result does not certify task success. |
| **observed fact** | A bounded, normalized fact derived from an observation for persistence or later selection. |
| **plan** | A fully specified proposed effect that has not crossed its authorization or start boundary. |
| **authorization** | Host-owned authority to perform a bounded effect. |
| **staged** | Durable local state awaiting a later commit, application, or publication boundary. |
| **snapshot** | An immutable capture of state at a named boundary, such as a pre-change workspace snapshot. It is not a synonym for request, view, or summary. |
| **receipt** | An immutable acknowledgement from a durability or authority boundary. Selection records, prompt bundles, and ordinary return values are not receipts. |
| **run finalization** | Durable settlement of the run result and its session record. |
| **verification** | A production check that can affect acceptance. `evaluation` is reserved for offline product or model measurement. |
| **working copy** | Coding Agent's isolated mutable workspace. This is application-owned, not a Core candidate. |
| **evidence** | Writing-domain material that supports or contradicts a claim. Core tool results are observations or observed facts, not evidence. |

## Prohibited contract vocabulary

Do not introduce persisted or public names using:

- `projection` for assembly, selection, recording, delivery, or finalization;
- `candidate` without an application-qualified domain meaning;
- `prepare` or `prepared` when the actual state is planned, authorized, staged,
  normalized, admitted, or assembled;
- `evaluation` for production verification.

An adapter may retain an upstream protocol name only at that boundary. Coding
Agent therefore mirrors Sandbox `prepare`, `preparing`, and `prepared` wire
states in its Sandbox adapters, then exposes application-owned authorization
terminology everywhere else.

Local variables may use ordinary English where there is no domain ambiguity, but
persisted fields and exported APIs must name the exact state transition.

Tool input inspection contains normalized input and derived effects, before execution resources are bound or an approval fingerprint exists. Applications can supply missing context at this stage. An execution binding captures the exact input snapshot, invocation, optional recovery operation, and owned resources. Authorization fingerprints that bound snapshot before an effect can start. Simple tools use `defineTool` with `invoke`; tools that acquire execution resources use `bindExecution` and return the bound invocation. Both authoring forms produce the same execution binding.
